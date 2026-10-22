/**
 * 질문 배분 — "이런 질문이 오면 이 기기의 저 세션에 위임하라" 는 명시 규칙(규약 6 의 ①).
 *
 * 전부 순수 함수다. 파일 입출력도 네트워크도 없어서 **직접 import 해 단위 시험할 수 있다**.
 * 방 등록은 낱말보다 먼저다. 방은 이름으로 적는다(꼬리표의 room 이 이름이므로).
 */
import type { RouteEntry } from './types'

/** 한 줄의 사람이 읽는 꼴 */
export function labelOf(r: RouteEntry): string {
  return r.room ? `[방 ${r.room}] → ${r.session}` : `"${r.keywords}" → ${r.session}`
}

/** 같은 키워드·같은 방의 기존 항목을 골라낸다 (교체/제거의 공통 술어) */
function matches(r: RouteEntry, keywords?: string, room?: string): boolean {
  return Boolean((keywords && r.keywords === keywords) || (room && r.room === room))
}

export interface AddResult {
  routes: RouteEntry[]
  entry: RouteEntry
  replaced: boolean
}

/**
 * 등록 — 같은 키워드/같은 방의 기존 항목은 **새 세션으로 교체**한다(중복 누적 방지).
 * keywords 와 room 은 둘 중 하나 이상이 있어야 하며, 검증은 호출부 책임이다.
 */
export function addRoute(
  routes: RouteEntry[],
  session: string,
  keywords?: string,
  room?: string,
): AddResult {
  const rest = routes.filter((r) => !matches(r, keywords, room))
  const entry: RouteEntry = { session }
  if (keywords) entry.keywords = keywords
  if (room) entry.room = room
  return { routes: [...rest, entry], entry, replaced: rest.length !== routes.length }
}

/** 제거 — 지워진 게 없으면 removed:false (호출부가 "해당 항목 없음"을 안내한다) */
export function removeRoute(
  routes: RouteEntry[],
  keywords?: string,
  room?: string,
): { routes: RouteEntry[]; removed: boolean } {
  const rest = routes.filter((r) => !matches(r, keywords, room))
  return { routes: rest, removed: rest.length !== routes.length }
}

/** 목록 렌더 — 비어 있으면 null (호출부가 안내 문구를 고른다) */
export function renderRoutes(routes: RouteEntry[]): string | null {
  if (routes.length === 0) return null
  return ['질문 배분 (방 등록이 낱말보다 먼저):', ...routes.map((r) => `  ${labelOf(r)}`)].join(
    '\n',
  )
}

/**
 * 가져온 규칙을 합친다(team-relay → Meshwork, 처음 한 번 — 명세 D.3 5). 이미 있는 낱말 · 방은 지금 것을 둔다
 */
export function mergeRoutes(current: RouteEntry[], imported: RouteEntry[]): RouteEntry[] {
  const out = current.slice()
  for (const r of imported) {
    if (out.some((x) => (r.keywords && x.keywords === r.keywords) || (r.room && x.room === r.room)))
      continue
    const entry: RouteEntry = { session: r.session }
    if (r.keywords) entry.keywords = r.keywords
    if (r.room) entry.room = r.room
    out.push(entry)
  }
  return out
}
