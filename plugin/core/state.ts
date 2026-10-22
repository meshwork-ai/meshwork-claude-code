/**
 * 상태 파일 — 상태줄처럼 **플러그인 밖에서** 상태를 읽어 가는 수단.
 *
 * 왜 파일인가: doctor 는 플러그인 프로세스 안에 있어서 프로세스가 죽으면 진단도 같이 죽는다(team-relay 2026-09-29 실사례).
 * 상태를 파일로 내보내면 플러그인이 떠 있지 않아도 바깥에서 그 사실을 안다 — `updatedAt` 이 낡은 것이 곧 신호다.
 * 쓰기는 config.json 과 같은 규칙(임시 파일 → rename, 0600) — 여러 세션이 같은 폴더에 쓴다.
 */
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

/**
 * 상태 파일은 **세션마다 하나**다 — 한 기기에서 여러 세션이 돌고 받는 방이 다르다.
 *
 * ⚠️ 이 이름은 세션의 진짜 id 가 아닐 수 있다. `CLAUDE_CODE_SESSION_ID` 는 MCP 서버가 **뜨는 시점**의 값인데,
 * `claude --resume` 은 서버를 먼저 띄우고 그 뒤에 이어 갈 대화를 고른다(연결 계약 §4.2). 그래서 상태줄은 세션 id 로
 * 못 찾으면 부모 PID(`ppid`)로 짝을 찾는다(team-relay 0.7.6 방식).
 */
export function statePath(home: string, sessionId: string): string {
  return join(home, `state-${sessionId.replace(/[^A-Za-z0-9_-]/g, '')}.json`)
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * 끝난 세션의 상태 파일 청소 — 30초마다 고쳐 쓰므로 1시간 지난 파일은 그 세션이 끝났다는 뜻이다.
 * 세션 이름 파일은 바뀔 때만 쓰여 나이로는 못 가린다 — 그 창(claude 프로세스)이 끝났으면 지운다
 */
export function sweepStaleStates(home: string, maxAgeMs = 60 * 60 * 1000, now = Date.now()): void {
  try {
    for (const f of readdirSync(home)) {
      const full = join(home, f)
      if (/^state-.*\.json$/.test(f) && now - statSync(full).mtimeMs > maxAgeMs) unlinkSync(full)
      const m = f.match(/^name-(\d+)$/)
      if (m && !alive(Number(m[1]))) unlinkSync(full)
    }
  } catch {
    /* 청소 실패는 무해하다 */
  }
}

/**
 * 세션 이름 — `/rename` · `--name` 으로 붙인 이름. 플러그인(MCP 서버)에는 오지 않고 **상태줄만** 받는다
 * (입력 JSON 의 session_name). 상태줄이 `name-<PPID>` 로 적어 두고 플러그인이 읽는다 — 둘의 부모가 같은 claude 다
 */
export function readSessionName(home: string, ppid = process.ppid): string | undefined {
  try {
    const t = readFileSync(join(home, `name-${ppid}`), 'utf8')
      // 상태줄이 적은 값에서 제어 문자를 지운다 — 일부러 제어 문자 범위를 쓴다
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim()
    return t ? t.slice(0, 120) : undefined
  } catch {
    return undefined
  }
}

export interface SessionState {
  /** 마지막 갱신 시각 — 이 값이 낡으면 플러그인이 죽은 것이다 */
  updatedAt: number
  sessionId: string
  /** 나를 띄운 Claude Code 프로세스의 PID — 세션 id 와 달리 창이 사는 동안 바뀌지 않는다(상태줄의 `$PPID`) */
  ppid: number
  /** 팀 세션인가(`meshwork-claude`) */
  team: boolean
  /** 로그인 · 연결 — `login`(로그인 필요) · `org`(조직 고르기) · `connecting` · `open` · `offline`(다시 붙는 중) · `stopped` */
  link: 'login' | 'org' | 'connecting' | 'open' | 'offline' | 'stopped'
  /** 다시 붙지 않는 사유 — `outdated` · `revoked` · `removed` · `rejected` */
  stopped: string | null
  /** 이 세션이 받는 방 이름 */
  held: string[]
  /** 참가했지만 **아무 세션도 받지 않는** 방 이름 */
  empty: string[]
  /** 나를 기다리는 보관 메시지 수 */
  queued: number
  /** 퇴근 중 */
  off: boolean
  /** 세션을 켠 뒤 규약 · 방 메모리가 바뀜 — 새 세션부터 반영(명세 §12) */
  contextChanged: boolean
  /** 서비스 · 조직 공지 한 줄(세션에는 넣지 않는다 — 명세 §4.7 · §10.5) */
  notice: string | null
}

export function writeState(home: string, s: SessionState): void {
  // 팀 세션이 아니거나 세션을 알아볼 수 없으면 상태줄이 짝을 찾을 수 없다 — 파일을 만들지 않는다
  if (!s.sessionId || !s.team) return
  try {
    const path = statePath(home, s.sessionId)
    mkdirSync(home, { recursive: true, mode: 0o700 })
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 })
    renameSync(tmp, path)
    chmodSync(path, 0o600)
  } catch {
    /* 상태 내보내기 실패가 팀 채널 동작을 막아선 안 된다 */
  }
}
