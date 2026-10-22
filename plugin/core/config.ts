/**
 * 설정 파일 — 이 기기의 서버 · 조직 · 질문 배분 · 자동 답장 · Claude 세션마다 받는 방.
 *
 * config.json 은 이 기기의 **모든 세션이 같이 쓰는 파일 하나**라, 저장은 원자적이어야 하고 남의 세션 기록을 덮어써서도
 * 안 된다(team-relay 0.6.1 에서 고친 규칙 그대로):
 *  · sessions — 받는 방 기록은 **내 세션 항목만** 쓴다. 남의 항목은 언제나 디스크가 진실
 *  · rooms    — 서버가 진실이다. 서버에서 받은 값일 때만(roomsFromServer) 덮어쓴다
 *  · 쓰기는 임시 파일 → rename — 「옛 내용」 아니면 「새 내용」 만 있다
 * 토큰은 여기 두지 않는다(tokens.json — client-core 의 보관함).
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import type { RouteEntry } from './types'

export interface RoomInfo {
  /** 방 이름(조직 안에서 고유) */
  name: string
  /** 그 방에서의 내 이름 */
  myName: string
}

export interface Config {
  /** 서비스 주소 — `https://<서버>` (첫 로그인 때 입력 · 3단계 ⑥) */
  server?: string
  /** 이 기기가 붙는 조직 */
  org?: string
  orgName?: string
  /** 내가 참가한 방 — id → 이름(서버가 진실 · 표시용 사본 · 세션을 켤 때 방 메모리를 미리 고르는 데) */
  rooms?: Record<string, RoomInfo>
  /** Claude 세션 id → 받는 방 id — `--resume` 하면 되찾는다(명세 §5.2) */
  sessions?: Record<string, string[]>
  /** 질문 배분 — 이런 질문은 이 기기의 저 세션에 위임 */
  routes?: RouteEntry[]
  /** 자동 답장(기본 켜짐) — 끄면 답장 초안을 사용자에게 보이고 승인받은 뒤 보낸다 */
  autoReply?: boolean
  /** team-relay 의 질문 배분 규칙을 가져왔나(한 번만) */
  routesImported?: boolean
}

/** 받는 방 기록 상한 — 세션 id 가 끝없이 쌓이지 않게 */
const SESSION_KEEP = 50

export function loadConfig(path: string): Config | null {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Config) : null
  } catch {
    return null
  }
}

/** 오래된 세션 기록부터 밀어낸다 — 마지막에 쓴 것이 맨 뒤 */
function trimSessions(sessions: Record<string, string[]>): Record<string, string[]> {
  const keys = Object.keys(sessions)
  if (keys.length <= SESSION_KEEP) return sessions
  const keep = keys.slice(keys.length - SESSION_KEEP)
  return Object.fromEntries(keep.map((k) => [k, sessions[k]!]))
}

/**
 * 저장 — 디스크의 최신본과 합친다. `sessionId` 는 이 세션(그 항목만 내 것으로 쓴다).
 * 서버 · 조직이 바뀌면 그 조직의 것(방 사본 · 받는 방 기록)을 비운다 — 다른 조직의 방 id 로 세션을 열지 않게
 */
export function saveConfig(
  path: string,
  cfg: Config,
  opts: { sessionId?: string; roomsFromServer?: boolean } = {},
): Config {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const disk = loadConfig(path) ?? {}
  const next: Config = { ...disk, ...cfg }
  const moved =
    (cfg.server !== undefined && cfg.server !== disk.server) ||
    (cfg.org !== undefined && cfg.org !== disk.org)
  if (moved) {
    if (!opts.roomsFromServer) delete next.rooms
    delete next.sessions
  } else {
    const sessions: Record<string, string[]> = { ...(disk.sessions ?? {}) }
    const mine = opts.sessionId ? cfg.sessions?.[opts.sessionId] : undefined
    if (opts.sessionId && mine) {
      delete sessions[opts.sessionId]
      sessions[opts.sessionId] = mine
    }
    next.sessions = trimSessions(sessions)
    if (!opts.roomsFromServer && disk.rooms) next.rooms = disk.rooms
  }
  for (const k of Object.keys(next) as (keyof Config)[]) if (next[k] === undefined) delete next[k]
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, path)
  return next
}

/** 이 세션이 켤 때 받을 방 — 기억한 방, 없으면 참가한 방이 하나뿐일 때 그 방(명세 §5.1 · 5.2) */
export function rememberedRooms(cfg: Config, sessionId: string): string[] {
  const bound = sessionId ? cfg.sessions?.[sessionId] : undefined
  if (bound?.length) return bound.filter((r) => !cfg.rooms || r in cfg.rooms)
  const all = Object.keys(cfg.rooms ?? {})
  return all.length === 1 ? all : []
}

/**
 * 사람이 친 서버 주소 → `https://<호스트>[:포트]`. 경로 · 물음표 뒤는 버린다(로그인 · 소켓 경로는 플러그인이 붙인다).
 * 인증 경로는 TLS 만(명세 §1.1) — `http://` 는 거절
 */
export function normalizeServer(input: string): string {
  const t = input.trim()
  if (!t) throw new Error('서버 주소가 비어 있습니다')
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t) && !/^https:\/\//i.test(t)) {
    throw new Error('서버 주소는 https 여야 합니다 — 로그인은 암호화된 연결에서만 합니다')
  }
  let u: URL
  try {
    u = new URL(/^https:\/\//i.test(t) ? t : `https://${t}`)
  } catch {
    throw new Error(`서버 주소가 올바르지 않습니다: ${t}`)
  }
  if (u.username || u.password) throw new Error('서버 주소에 계정 정보를 넣지 않습니다')
  return u.origin
}
