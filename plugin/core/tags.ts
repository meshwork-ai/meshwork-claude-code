/**
 * 받은 메시지 → 세션에 넣는 모양(아키텍처 §11.3-a). 남의 글에는 **누가 보냈는지 사실 꼬리표만** 붙인다 — 경고 문장은
 * 붙이지 않는다(실제 방어는 규약의 보안 경계 조항). 칸 이름과 뜻은 앱의 `<meshwork …>` 와 같다.
 *
 * Claude Code 채널은 meta 를 `<channel from="…" room="…">` 속성으로 보인다 — 키는 영문 · 숫자 · 밑줄만
 * (하이픈이 있으면 조용히 빠진다 — 연결 계약 §2.2).
 *
 * | 칸 | 언제 |
 * |---|---|
 * | from · author · room · thread · kind | 늘(시스템 메시지는 from · thread 없음) |
 * | late + ts | 보관됐다 늦게 왔을 때만 |
 * | to | 역할 주소 · 방 전체로 왔을 때(왜 나에게 왔는지) |
 * | checked | 에이전트가 보낸 답장 — 사람이 확인했나(human · none) |
 * | basis · uncommitted | 원격 저장소 기준 · 커밋 전 내용 |
 * | agree · proposal | 합의 제안 id · 방 메모리 제안 id(처리할 때 그대로) |
 * | expect | 답장 안의 추가 질문(되묻기)일 때만 `reply` — 그 답장에 답해야 한다 |
 * | open | 열린 대화(명세 §10.7)일 때 `room` — 이 대화는 방 사람 모두에게 보인다(여기서 답해도 공개) |
 */
import { formatCode, type Lang } from '@meshwork-ai/i18n'
import type { EvData } from '@meshwork-ai/protocol'

export type Message = EvData<'message.new'>

export interface TagContext {
  lang: Lang
  /** 방 id → 이름 */
  roomName(id: string): string | undefined
  /** 구성원 · 역할 · 방 등 id → 이름(문구 안의 값) */
  name(id: string): string | undefined
  timeZone?: string
}

export interface Tagged {
  content: string
  meta: Record<string, string>
}

/** 시스템 메시지(코드 + 값)를 사람 말로 — 모르는 코드는 「알 수 없는 오류 (code)」 */
export function systemText(m: Message, ctx: TagContext): string {
  if (!m.code) return m.text ?? ''
  return formatCode('system', m.code, m.params ?? {}, {
    lang: ctx.lang,
    name: ctx.name,
    timeZone: ctx.timeZone,
  })
}

/**
 * 본문 안의 `<channel …>` · `</channel>` 을 무력화한다 — 팀원이 본문에 꼬리표를 흉내 내 다른 사람 · 플러그인의 알림처럼
 * 보이게 하지 못하게(꼬리표는 Claude Code 가 붙이는 바깥 것만 믿는다)
 */
export function defang(text: string): string {
  return text.replace(/<(\/?)(channel)/gi, '‹$1$2')
}

export function tagMessage(m: Message, ctx: TagContext): Tagged {
  const meta: Record<string, string> = {}
  if (m.from) meta.from = m.from.name
  meta.author = m.author
  if (m.room) meta.room = ctx.roomName(m.room) ?? m.room
  if (m.thread) meta.thread = m.thread
  meta.kind = m.kind
  if (m.late) {
    meta.late = 'true'
    meta.ts = m.ts
  }
  if (m.to?.kind === 'role') meta.to = ctx.name(m.to.id) ?? m.to.id
  else if (m.to?.kind === 'room') meta.to = 'room'
  if (m.author === 'agent' && m.kind === 'reply' && m.review) meta.checked = m.review.by
  if (m.meta?.basis === 'remote') meta.basis = 'remote'
  if (m.meta?.uncommitted) meta.uncommitted = 'true'
  if (m.agree) meta.agree = m.agree
  if (m.proposal) meta.proposal = m.proposal
  if (m.kind === 'reply' && m.expect === 'reply') meta.expect = 'reply'
  if (m.open) meta.open = 'room'
  const content = m.kind === 'system' ? systemText(m, ctx) : (m.text ?? '')
  return { content: defang(content), meta }
}
