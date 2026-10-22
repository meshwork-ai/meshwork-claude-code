/** 플러그인 코어 타입 — 호스트(Claude Code 등)와 무관한 순수 데이터 모양 */

/** 질문 배분 한 줄 — keywords 또는 room 중 하나 이상 */
export interface RouteEntry {
  /** 맞춰 볼 낱말(사람이 읽는 자유 문자열) */
  keywords?: string
  /** 방 이름 — 이 방에서 온 질문은 이 세션으로(낱말보다 우선) */
  room?: string
  /** 이 기기에서 위임받을 세션 이름 */
  session: string
}
