/**
 * MCP 안내문(instructions) — 세션을 켤 때 한 번 시스템 프롬프트에 들어간다(연결 계약 §2.4). 넣는 순서(명세 §12):
 *
 *   ① 도구 안내 ② 팀 규약(못 받으면 사본 · 사본도 없으면 내장 최소 규약) ③ 머리말 + 방 메모리
 *
 * 글은 공용 패키지(@meshwork-ai/team-tools — 앱과 같은 것)에서, 플러그인 몫은 꼬리표(Claude Code 채널) · 넘기는 법 · 방 받기.
 * 떠 있는 세션에는 다시 넣지 않는다 — 바뀌면 새 세션부터(바뀐 사실만 상태줄 · doctor).
 */
import type { Context } from '@meshwork-ai/client-core'
import {
  buildInstructions as teamInstructions,
  FALLBACK_RULES,
  type GuideOptions,
  toolGuide,
} from '@meshwork-ai/team-tools'

export { FALLBACK_RULES }

/** 일반 세션(팀 세션이 아님) — 한 줄만 */
export const NOT_TEAM_INSTRUCTIONS =
  'Meshwork: 이 세션은 팀 세션이 아니다 — 팀 기능(팀원에게 묻기 · 답장 등)은 meshwork-claude 로 켠 세션에서만 쓴다.'

export const GUIDE: GuideOptions = {
  tag: 'channel',
  author: 'plugin',
  delegate:
    '내 소관이 아니면 route(action: "list")로 질문 배분을 보고, 그 방이나 낱말에 등록된 세션이 있으면 SendMessage 로 위임한다. 없으면 send 로 그 사람 · 역할에게 넘기거나 사용자에게 확인한다',
  holdRoom: '/meshwork:room 으로 받을 방을 정할 수 있다',
  roomTool: true,
}

/** 규약 ① — 조항마다 쓸 도구 */
export const TOOL_GUIDE = toolGuide(GUIDE)

export interface InstructionsInput {
  team: boolean
  context: Context | null
  roomName(id: string): string
  /** 로그인 · 조직이 준비되지 않았을 때 한 줄 */
  notReady?: string
}

export function buildInstructions(i: InstructionsInput): string {
  if (!i.team) return NOT_TEAM_INSTRUCTIONS
  return teamInstructions({
    guide: GUIDE,
    context: i.context,
    roomName: i.roomName,
    ...(i.notReady ? { notReady: i.notReady } : {}),
  })
}
