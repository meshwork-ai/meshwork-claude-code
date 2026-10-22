/**
 * 팀 도구 14개 — 이름은 앞머리 없이(3단계 ④: Claude Code 가 `mcp__plugin_meshwork_meshwork__` 를 붙인다).
 *
 * | 도구 | 옛 team-relay | 요청(PROTO 6) |
 * |---|---|---|
 * | send · reply · progress | team_send · team_reply · team_ack | message.send · message.reply · thread.status |
 * | history · memory · agree | team_history · team_memory · team_agree | thread.* · memory.* · agree.* |
 * | status · doctor · away · room | 같은 이름 | room.get · diag.get · presence.set · session.hold |
 * | route | team_route | (이 기기 안 — 질문 배분) |
 * | join · owner | team_join · team_owner | 초대 링크(브라우저) · room.invite · invites · invite_revoke · kick · notice |
 * | login | team_server | 기기 코드 로그인 · 조직 고르기 · 로그아웃 |
 *
 * 일반 세션(팀 세션이 아님)에서는 route · doctor 만 쓴다(PRD §8.4). 결과 글은 에이전트가 읽고 사용자에게 옮긴다.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Session } from '@meshwork-ai/client-core'
import { formatCode } from '@meshwork-ai/i18n'

import { loadConfig } from '../core/config'
import { addRoute, labelOf, removeRoute, renderRoutes } from '../core/routes'
import { choiceLabel, classifyRooms, renderRooms } from '../core/rooms'
import { MIN_NODE, PLUGIN_VERSION } from '../core/version'
import type { Candidate, RoomRef } from './names'
import type { Plugin } from './plugin'
import { clip, errorText, notReadyText, shortTime } from './text'

export type Args = Record<string, string | undefined>
export interface ToolResult {
  [key: string]: unknown
  content: { type: 'text'; text: string }[]
  isError?: boolean
}

const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] })
const fail = (text: string): ToolResult => ({
  content: [{ type: 'text', text: `✗ ${text}` }],
  isError: true,
})

/** 일반 세션에서도 쓰는 도구 — 서버와 상관없이 이 기기 안에서 끝난다 */
const LOCAL_TOOLS = new Set(['doctor', 'route'])
const NOT_TEAM =
  '이 세션에서는 Meshwork 를 쓸 수 없습니다 — meshwork-claude 로 켠 세션에서 다시 해 주세요'

/** 처음부터 불러 둔다 — 대화 중간에 이름만 있는 도구를 고르지 못해 옛 도구를 쓰는 일을 막으려고(연결 계약 §4.4) */
const ALWAYS = { 'anthropic/alwaysLoad': true }

const s = (description: string, extra: Record<string, unknown> = {}) => ({
  type: 'string',
  description,
  ...extra,
})

export const TOOLS = [
  {
    name: 'send',
    description:
      '팀원 · 역할에게 **새 대화**를 시작한다(사용자가 새로 묻거나 알리라고 할 때만). 받은 메시지에 답할 때는 send 가 아니라 reply 를 쓴다. 상대가 퇴근 · 오프라인이면 서버가 보관했다가 전한다.',
    inputSchema: {
      type: 'object',
      properties: {
        to: s('받는 팀원 이름(그 방에서의 이름) 또는 역할 이름'),
        message: s('보낼 내용'),
        room: s(
          '방 이름(선택) — 같은 이름이 여러 방에 있으면 필요하다. 없으면 이 세션이 받는 방에서 찾는다',
        ),
        expect: s(
          '답을 기대하나(선택, 기본 reply) — 알리기만("배포했어요")이면 none. none 이면 답이 없어도 무응답 알림이 나지 않는다',
          { enum: ['reply', 'none'] },
        ),
      },
      required: ['to', 'message'],
    },
  },
  {
    name: 'reply',
    description:
      '받은 팀 메시지에 답한다 — 꼬리표의 thread 만 넣으면 받는 사람과 방은 서버가 정한다. 답하면 상대의 무응답 알림이 풀린다. 공지(kind="notice")와 [이미 답함] 이 온 질문에는 답하지 않는다.',
    inputSchema: {
      type: 'object',
      properties: {
        thread: s('받은 메시지 꼬리표의 thread 값 그대로'),
        message: s('답장 내용'),
        expect: s(
          '답을 기대하나(선택, 기본 none) — 답하려면 꼭 알아야 하는 것을 되물을 때만 reply(한 번)',
          { enum: ['reply', 'none'] },
        ),
      },
      required: ['thread', 'message'],
    },
  },
  {
    name: 'progress',
    description:
      '받은 질문에 바로 답하지 못할 때 진행 상황을 알린다 — 작업 중이면 working, 사용자에게 확인이 필요하면 asking. 보내지 않으면 묻는 쪽에 무응답이 뜬다.',
    inputSchema: {
      type: 'object',
      properties: {
        thread: s('받은 메시지 꼬리표의 thread 값'),
        status: s('working = 처리 중 · asking = 사람(사용자)에게 확인 중', {
          enum: ['working', 'asking'],
        }),
      },
      required: ['thread', 'status'],
    },
  },
  {
    name: 'history',
    description:
      '내가 끼어 있는 지난 대화를 본다(남의 1:1 대화는 볼 수 없다). 예전에 물었던 것은 다시 묻기 전에 여기서 먼저 찾는다. thread 를 주면 그 대화의 메시지, q 를 주면 내용 찾기, 아니면 대화 목록.',
    inputSchema: {
      type: 'object',
      properties: {
        thread: s('대화 하나만(선택) — thr_…'),
        q: s('찾을 말(선택) — 사람 · 내용'),
        peer: s('상대 이름(선택)'),
        room: s('방 이름(선택)'),
        limit: s('몇 건(선택, 기본 20 · 최대 100)'),
        before: s('이 id 보다 앞(선택) — 앞 결과 끝에 적힌 값으로 이전 페이지'),
      },
    },
  },
  {
    name: 'memory',
    description:
      '방 메모리 — 방장 · 관리자가 방마다 정리한 짧은 사실(설명 1 + 내용 최대 3, 칸마다 150자). 세션을 켤 때 이미 들어 있으니 따로 볼 필요는 없다(view 는 지금 내용을 다시 볼 때). ' +
      '사용자에게 물어 얻은 답이 **코드로는 알 수 없고 앞으로도 매번 같을 것 같으면** propose 로 제안한다 — 방장(없으면 관리자)이 승인하면 그 방 모든 세션에 들어간다. ' +
      '방장이면 describe(설명) · add · edit · remove(내용)로 직접 고치고 approve · reject 로 제안을 처리한다.',
    inputSchema: {
      type: 'object',
      properties: {
        action: s('할 일', {
          enum: ['view', 'propose', 'describe', 'add', 'edit', 'remove', 'approve', 'reject'],
        }),
        room: s('방 이름(선택 — 이 세션이 받는 방이 하나면 그 방)'),
        text: s(
          'propose · add · edit: 내용 한 문장(예: "금요일 배포 금지 — 주말 호출 방지") · describe: 방 설명(빈 글이면 지움)',
        ),
        pos: s('edit · remove: 내용 번호(1~3)'),
        proposal_id: s('approve · reject: 제안 id — 꼬리표의 proposal(mpr_…)'),
        replace: s('approve: 3칸이 다 찼을 때 이 제안으로 바꿀 내용 번호(1~3)'),
        reason: s('reject: 거절 이유(제안한 사람에게 간다)'),
      },
      required: ['action'],
    },
  },
  {
    name: 'agree',
    description:
      '합의 대장 — 문답 끝에 인터페이스 · 결정에 합의하면 propose 로 기록을 제안한다(상대가 확인해야 확정 · 확정되면 방 전원이 본다). confirm · reject 는 나에게 온 제안(kind="agree") 처리 — 직전 대화와 맞을 때만 confirm. list 는 합의 보기.',
    inputSchema: {
      type: 'object',
      properties: {
        action: s('할 일', { enum: ['propose', 'confirm', 'reject', 'list'] }),
        to: s('propose: 합의 상대 이름'),
        summary: s('propose: 합의 한 문장(예: "source_ref 는 string[] · 빈 배열 허용")'),
        details: s('propose: 자세히(선택 — 스키마 · 예시 등)'),
        thread: s('propose: 이 합의가 나온 대화의 thread(선택)'),
        room: s('propose · list: 방 이름(선택)'),
        agree_id: s('confirm · reject: 꼬리표의 agree(agr_…)'),
        reason: s('reject: 대화와 어떻게 다른지'),
        peer: s('list: 상대 이름으로 거르기(선택)'),
      },
      required: ['action'],
    },
  },
  {
    name: 'status',
    description:
      '팀 연결 상태 — 서버 · 조직 · 나 · 이 세션이 받는 방 · 참가한 방 · 방 사람들의 상태 · 자동 답장. auto_reply 로 자동 답장을 켜고 끈다(끄면 답장 초안을 사용자에게 보이고 승인받은 뒤 보낸다).',
    inputSchema: {
      type: 'object',
      properties: { auto_reply: s('자동 답장 켜기 · 끄기(선택)', { enum: ['on', 'off'] }) },
    },
  },
  {
    name: 'doctor',
    description:
      '팀 연결 자가 진단 — 플러그인 · 런타임 · 설정 · 로그인 · 서버 연결 · 받는 방 · 보관 메시지 · 규약을 ✓ · ✗ 로 점검하고 할 일을 적는다. "팀 메시지가 안 와요" 의 첫 진단.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'away',
    description:
      '퇴근 · 출근. 퇴근(on)이면 세션이 켜져 있어도 팀 메시지가 서버에 보관되고(보관 기한이 멈춤) 출근(off)하면 한꺼번에 온다. 퇴근 중에도 보내기는 된다.',
    inputSchema: {
      type: 'object',
      properties: { mode: s('on = 퇴근 · off = 출근', { enum: ['on', 'off'] }) },
      required: ['mode'],
    },
  },
  {
    name: 'room',
    description:
      '이 세션이 받을 방을 정한다(참가한 방 중에서). 방 이름 없이 부르면 방마다 누가 받는지 보여 주고 고르게 한다. 다른 세션이 받던 방을 가져오면 그 세션은 받지 못하게 되므로 사용자가 원할 때만 쓴다. --resume 으로 다시 켜면 받던 방을 되찾는다.',
    inputSchema: {
      type: 'object',
      properties: { rooms: s('받을 방 이름(여럿이면 쉼표로 · 선택)') },
    },
  },
  {
    name: 'route',
    description:
      '질문 배분 — 팀 질문의 낱말이나 방을 이 기기의 세션에 맡겨 둔다. 내 소관이 아닌 질문은 ① action:"list" 로 보고 꼬리표의 room 과 같은 방이 등록돼 있으면(낱말보다 먼저) 그 세션에, 아니면 낱말이 맞는 세션에 SendMessage 로 위임한다 ② 등록이 없으면 send 로 그 사람 · 역할에게 넘기거나 사용자에게 확인한다 ③ 넘기지 못해 직접 답할 때는 그렇다고 밝힌다.',
    inputSchema: {
      type: 'object',
      properties: {
        action: s('할 일', { enum: ['list', 'add', 'remove'] }),
        keywords: s('맞춰 볼 낱말(add · remove — keywords 또는 room 중 하나)'),
        room: s('방 이름 — 이 방에서 온 질문은 지정한 세션으로(낱말보다 먼저)'),
        session: s('맡을 세션 이름(add 에 필요)'),
      },
      required: ['action'],
    },
  },
  {
    name: 'join',
    description:
      '초대 링크로 방에 참가한다 — 링크를 브라우저로 열어 준다. 화면에서 조직 · 방 · 초대한 사람을 확인하고 사람이 [참가]를 눌러야 참가된다(플러그인이 대신 참가하지 않는다). 참가하면 이 세션이 그 방을 받는다.',
    inputSchema: {
      type: 'object',
      properties: { link: s('초대 링크(https://<서버>/join/…) 또는 끝의 코드') },
      required: ['link'],
    },
  },
  {
    name: 'owner',
    description:
      '방장 · 관리자 — 초대 링크 만들기(invite) · 살아 있는 링크 보기(invites) · 링크 취소(revoke) · 방에서 내보내기(kick — 그 방에서만) · 방 전원 공지(notice). 방 메모리는 memory 도구.',
    inputSchema: {
      type: 'object',
      properties: {
        action: s('할 일', { enum: ['invite', 'invites', 'revoke', 'kick', 'notice'] }),
        room: s('방 이름'),
        name: s('invite: 그 방에서 쓸 이름 제안(선택) · kick: 내보낼 사람 이름'),
        invite: s('revoke: 초대 링크 번호(inv_… — invites 로 본다)'),
        text: s('notice: 공지 내용'),
      },
      required: ['action', 'room'],
    },
  },
  {
    name: 'login',
    description:
      'Meshwork 로그인 · 조직 · 로그아웃. 로그인은 확인 코드를 보이고 브라우저를 연다 — 사람이 회사 계정으로 로그인하고 코드가 같은지 확인한 뒤 허용한다. 처음에는 서버 주소가 필요하다(다음부터 기억). org 는 붙을 조직 바꾸기, logout 은 이 기기 로그아웃.',
    inputSchema: {
      type: 'object',
      properties: {
        action: s('할 일(기본 login)', { enum: ['login', 'org', 'logout'] }),
        server: s('login: 서버 주소(처음 한 번 · 예: meshwork.example.com)'),
        org: s('org: 붙을 조직 이름(선택 — 없으면 고르는 창)'),
      },
    },
  },
].map((t) => ({ ...t, _meta: ALWAYS }))

/** 도구 하나를 처리한다 — 던진 오류도 글로 바꾼다 */
export async function callTool(p: Plugin, name: string, args: Args): Promise<ToolResult> {
  if (!p.host.isTeam && !LOCAL_TOOLS.has(name)) return fail(NOT_TEAM)
  try {
    switch (name) {
      case 'send':
        return await send(p, args)
      case 'reply':
        return await reply(p, args)
      case 'progress':
        return await progress(p, args)
      case 'history':
        return await history(p, args)
      case 'memory':
        return await memory(p, args)
      case 'agree':
        return await agree(p, args)
      case 'status':
        return await status(p, args)
      case 'doctor':
        return await doctor(p)
      case 'away':
        return await away(p, args)
      case 'room':
        return await room(p, args)
      case 'route':
        return route(p, args)
      case 'join':
        return await joinRoom(p, args)
      case 'owner':
        return await owner(p, args)
      case 'login':
        return await login(p, args)
      default:
        return fail(`모르는 도구: ${name}`)
    }
  } catch (e) {
    return fail(errorText(e, { lang: p.lang, name: p.dir.name }))
  }
}

// ── 공통 ────────────────────────────────────────────────────────

/** 붙어 있고 세션이 열렸으면 그 세션 — 아니면 할 일 한 줄 */
async function ready(p: Plugin): Promise<Session | ToolResult> {
  if (!(await p.link.ready(8_000)) || !p.link.session) {
    return fail(notReadyText(p.link.state, { lang: p.lang }))
  }
  return p.link.session
}

const isResult = (x: unknown): x is ToolResult => !!x && typeof x === 'object' && 'content' in x

/** 사람 확인 여부 — 플러그인은 답장 방식 설정 기준(명세 §7.3) */
function review(p: Plugin): { by: 'human' | 'none'; basis: 'setting' } {
  return { by: p.autoReply ? 'none' : 'human', basis: 'setting' }
}

/** 방 고르기 — 이름을 주면 그 방, 아니면 이 세션이 받는 방이 하나일 때 그 방 */
function pickRoom(p: Plugin, session: Session, input: string | undefined): RoomRef | ToolResult {
  if (input) {
    const r = p.dir.room(input)
    return (
      r ??
      fail(
        `'${input}' 방에 참가하지 않았습니다 — status 로 참가한 방을 보세요(새 방은 초대 링크로 /meshwork:join)`,
      )
    )
  }
  const held = session.held.map((id) => p.dir.room(id)).filter((r): r is RoomRef => !!r)
  if (held.length === 1) return held[0]!
  if (!held.length)
    return fail(
      '이 세션이 받는 방이 없습니다 — room 을 넣거나 /meshwork:room 으로 받을 방을 정하세요',
    )
  return fail(
    `어느 방인지 room 을 넣어 주세요 — 이 세션이 받는 방: ${held.map((r) => r.name).join(', ')}`,
  )
}

function limitOf(v: string | undefined, dflt = 20): number {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? Math.min(n, 100) : dflt
}

/** 그 방 구성원 이름 → id (못 찾으면 글) */
async function memberIn(
  p: Plugin,
  room: RoomRef,
  name: string,
): Promise<{ id: string; name: string } | ToolResult> {
  const m = await p.dir.member(room.id, name)
  return m
    ? { id: m.member, name: m.name }
    : fail(`'${room.name}' 방에 '${name}'님이 없습니다 — status 로 방 사람을 보세요`)
}

/** 참가한 방 어디서든 이름 → 구성원 id(첫 번째) */
async function memberAnywhere(p: Plugin, name: string): Promise<string | undefined> {
  for (const r of p.dir.rooms) {
    const m = await p.dir.member(r.id, name).catch(() => undefined)
    if (m) return m.member
  }
  return undefined
}

function stateLabel(p: Plugin, state: string): string {
  return formatCode('threadState', state, {}, { lang: p.lang })
}

// ── send · reply · progress ──────────────────────────────────────

async function send(p: Plugin, a: Args): Promise<ToolResult> {
  const to = a.to?.trim()
  const text = a.message ?? ''
  if (!to || !text.trim()) return fail('to 와 message 가 필요합니다')
  const session = await ready(p)
  if (isResult(session)) return session
  let rooms: RoomRef[]
  if (a.room) {
    const r = p.dir.room(a.room)
    if (!r) return fail(`'${a.room}' 방에 참가하지 않았습니다 — status 로 참가한 방을 보세요`)
    rooms = [r]
  } else {
    rooms = session.held.map((id) => p.dir.room(id)).filter((r): r is RoomRef => !!r)
    if (!rooms.length)
      return fail(
        '이 세션이 받는 방이 없어 보낼 수 없습니다 — /meshwork:room 으로 받을 방을 정하세요',
      )
  }
  const found: Candidate[] = (
    await Promise.all(rooms.map((r) => p.dir.resolve(r.id, to).catch(() => [])))
  ).flat()
  if (!found.length) {
    const where = a.room
      ? `'${rooms[0]!.name}' 방`
      : `이 세션이 받는 방(${rooms.map((r) => r.name).join(', ')})`
    return fail(`${where}에서 '${to}'(사람 · 역할)을 찾지 못했습니다 — status 로 방 사람을 보세요`)
  }
  const inRooms = [...new Set(found.map((c) => c.room))]
  if (inRooms.length > 1) {
    return fail(
      `'${to}'이(가) 여러 방에 있습니다(${inRooms.map((r) => p.dir.roomName(r)).join(', ')}) — 어느 방인지 사용자에게 확인한 뒤 room 을 넣어 다시 보내세요`,
    )
  }
  if (found.length > 1) {
    const list = found
      .map((c) => `${c.kind === 'role' ? '역할' : '구성원'} '${c.name}'`)
      .join(' · ')
    return fail(`'${to}'이(가) 여럿입니다(${list}) — 사용자에게 누구인지 확인하세요`)
  }
  const c = found[0]!
  if (c.kind === 'member' && c.id === p.me) return fail('나 자신에게는 보낼 수 없습니다')
  const roomName = p.dir.roomName(c.room) ?? c.room
  if (!session.held.includes(c.room)) {
    return fail(
      `이 세션은 '${roomName}' 방을 받지 않아 그 방으로 보낼 수 없습니다 — 사용자가 원하면 /meshwork:room ${roomName}`,
    )
  }
  const expect = a.expect === 'none' ? 'none' : 'reply'
  const r = await session.call('message.send', {
    room: c.room,
    to: { kind: c.kind, id: c.id },
    text,
    expect,
    review: review(p),
  })
  const label = c.kind === 'role' ? `'${c.name}' 역할` : `'${c.name}'님`
  if (expect === 'reply')
    p.asked.set(r.thread, { to: c.name, room: c.room, preview: clip(text, 60) })
  const lines = [`✓ ${label}에게 보냈습니다 (방 ${roomName} · 대화 ${r.thread})`]
  if (c.kind === 'role') {
    if (r.assigned) lines.push(`  ↳ '${p.dir.name(r.assigned) ?? r.assigned}'님이 받았습니다`)
    else lines.push('  ↳ 지금 답할 수 있는 사람이 없어 보관했습니다 — 생기면 그 사람에게 갑니다')
  } else if (r.state === 'queued')
    lines.push('  지금은 받을 곳이 없어 서버가 보관했습니다 — 받을 수 있게 되면 전합니다')
  if (r.note) lines.push(`  ${formatCode('note', r.note, {}, { lang: p.lang })}`)
  if (r.note === 'open_thread') {
    const open = [...p.received.entries()].find(([, v]) => v.from === c.name)
    lines.push(
      `  💡 지금 보낸 것이 그 질문의 답이라면 reply(thread: "${open?.[0] ?? '받은 메시지의 thread'}")로 다시 보내세요 — 지금 보낸 것은 새 대화로 갔습니다.`,
    )
  }
  return ok(lines.join('\n'))
}

async function reply(p: Plugin, a: Args): Promise<ToolResult> {
  const thread = a.thread?.trim()
  if (!thread)
    return fail(
      'thread 가 필요합니다 — 받은 메시지 꼬리표의 thread 값을 그대로 넣으세요. 새 대화는 send 입니다',
    )
  if (!(a.message ?? '').trim()) return fail('message 가 필요합니다')
  if (p.answeredElsewhere.has(thread)) {
    return fail(
      '이 질문은 다른 곳(앱 등)에서 이미 답했습니다 — 답하지 않습니다. 보충할 말이 있으면 사용자에게 확인하세요',
    )
  }
  const session = await ready(p)
  if (isResult(session)) return session
  const expect = a.expect === 'reply' ? 'reply' : 'none'
  const r = await session.call('message.reply', {
    thread,
    text: a.message!,
    expect,
    review: review(p),
  })
  p.repliedHere.add(thread)
  const got = p.received.get(thread)
  // 되물었으면 이번 주기는 내가 묻는 쪽 — 무응답 · 만료 알림을 받는다
  if (expect === 'reply')
    p.asked.set(thread, {
      to: got?.from ?? '상대',
      room: got?.room ?? '',
      preview: clip(a.message!, 60),
    })
  const lines = [`✓ 답장을 보냈습니다${got ? ` ('${got.from}'님에게)` : ''} (대화 ${thread})`]
  if (r.state === 'queued')
    lines.push('  상대가 지금 받을 수 없어 서버가 보관했습니다 — 받을 수 있게 되면 전합니다')
  return ok(lines.join('\n'))
}

async function progress(p: Plugin, a: Args): Promise<ToolResult> {
  const thread = a.thread?.trim()
  if (!thread) return fail('thread 가 필요합니다')
  if (a.status !== 'working' && a.status !== 'asking')
    return fail('status 는 working 또는 asking 입니다')
  const session = await ready(p)
  if (isResult(session)) return session
  await session.call('thread.status', { thread, status: a.status })
  return ok(
    a.status === 'working'
      ? `✓ '처리 중' 으로 알렸습니다 (대화 ${thread}) — 묻는 쪽의 무응답 시계가 멈춥니다`
      : `✓ '사람에게 확인 중' 으로 알렸습니다 (대화 ${thread}) — 사용자에게 확인한 뒤 reply 로 답하세요`,
  )
}

// ── history ──────────────────────────────────────────────────────

async function history(p: Plugin, a: Args): Promise<ToolResult> {
  const session = await ready(p)
  if (isResult(session)) return session
  const c = p.link.client!
  const limit = limitOf(a.limit)
  const name = (id: string) => p.dir.name(id) ?? id
  const msgLine = (m: {
    ts: string
    room: string | null
    from: { name: string } | null
    kind: string
    text?: string
    code?: string
    thread: string | null
    msg: string
  }) =>
    `  [${shortTime(m.ts)}]${m.room ? ` [${p.dir.roomName(m.room) ?? m.room}]` : ''} ${m.from?.name ?? '서버'}${m.kind === 'reply' ? ' ↩' : ''}: ${clip(m.text ?? m.code ?? '', 200)}${m.thread ? ` (${m.thread})` : ''}`
  if (a.thread) {
    const r = await c.call('thread.get', {
      thread: a.thread.trim(),
      limit,
      ...(a.before ? { before: a.before } : {}),
    })
    const t = r.thread
    const head = `대화 ${t.id} — ${name(t.asker)} → ${t.to.kind === 'member' ? name(t.to.id) : t.to.kind === 'role' ? `역할 ${name(t.to.id)}` : '방 전체'} · ${stateLabel(p, t.state)}`
    const lines = [head, ...r.messages.map(msgLine)]
    if (r.more && r.messages.length)
      lines.push(`  … 앞 메시지가 더 있습니다 — before: "${r.messages[0]!.msg}"`)
    return ok(lines.join('\n'))
  }
  const roomRef = a.room ? p.dir.room(a.room) : undefined
  if (a.room && !roomRef) return fail(`'${a.room}' 방에 참가하지 않았습니다`)
  if (a.q) {
    const r = await c.call('thread.search', {
      q: a.q,
      limit,
      ...(roomRef ? { room: roomRef.id } : {}),
      ...(a.before ? { before: a.before } : {}),
    })
    if (!r.hits.length)
      return ok(
        r.more && r.next
          ? `맞는 것이 아직 없습니다 — 더 찾으려면 before: "${r.next}"`
          : '맞는 메시지가 없습니다',
      )
    const lines = [`'${a.q}' 찾기 (${r.hits.length}건):`, ...r.hits.map(msgLine)]
    if (r.more && r.next) lines.push(`  … 더 있습니다 — before: "${r.next}"`)
    return ok(lines.join('\n'))
  }
  const peer = a.peer ? await memberAnywhere(p, a.peer) : undefined
  if (a.peer && !peer) return fail(`'${a.peer}'님을 참가한 방에서 찾지 못했습니다`)
  const r = await c.call('thread.list', {
    box: 'all',
    limit,
    ...(roomRef ? { room: roomRef.id } : {}),
    ...(peer ? { peer } : {}),
    ...(a.before ? { before: a.before } : {}),
  })
  if (!r.threads.length) return ok('조건에 맞는 대화가 없습니다')
  for (const t of r.threads) await p.dir.detail(t.room).catch(() => null)
  const lines = r.threads.map((t) => {
    const to =
      t.to.kind === 'member'
        ? name(t.to.id)
        : t.to.kind === 'role'
          ? `역할 ${name(t.to.id)}`
          : '방 전체'
    const last = t.last ? ` — ${t.last.from?.name ?? '서버'}: ${clip(t.last.text ?? '', 120)}` : ''
    return `  [${shortTime(t.sentAt)}] [${p.dir.roomName(t.room) ?? t.room}] ${name(t.asker)} → ${to} · ${stateLabel(p, t.state)}${last} (${t.id})`
  })
  const out = [`지난 대화 (${r.threads.length}건):`, ...lines]
  if (r.more) out.push(`  … 더 있습니다 — before: "${r.threads[r.threads.length - 1]!.id}"`)
  return ok(out.join('\n'))
}

// ── memory ───────────────────────────────────────────────────────

async function memory(p: Plugin, a: Args): Promise<ToolResult> {
  const session = await ready(p)
  if (isResult(session)) return session
  const c = p.link.client!
  const action = a.action ?? ''
  if (action === 'approve' || action === 'reject') {
    if (!a.proposal_id) return fail('proposal_id 가 필요합니다 — 제안 꼬리표의 proposal 값입니다')
    const replace = a.replace ? Number(a.replace) - 1 : undefined
    if (replace !== undefined && !(Number.isInteger(replace) && replace >= 0 && replace <= 2))
      return fail('replace 는 1~3 중 하나입니다')
    await session.call('memory.resolve', {
      proposal: a.proposal_id.trim(),
      result: action,
      ...(replace !== undefined ? { replace } : {}),
      ...(a.reason ? { reason: a.reason } : {}),
    })
    return ok(
      action === 'approve'
        ? '✓ 제안을 방 메모리에 넣었습니다 — 제안한 사람에게 알렸습니다'
        : '✓ 제안을 거절했습니다 — 제안한 사람에게 이유와 함께 알렸습니다',
    )
  }
  const room = pickRoom(p, session, a.room)
  if (isResult(room)) return room
  if (action === 'propose') {
    if (!a.text?.trim()) return fail('text(제안할 한 문장)가 필요합니다')
    const r = await session.call('memory.propose', { room: room.id, text: a.text })
    return ok(
      `✓ '${room.name}' 방 메모리에 제안했습니다 (${r.proposal}) — ${r.to === 'owners' ? '방장에게 갔습니다' : '방장이 없어 조직 관리자가 콘솔에서 처리합니다'}. 72시간 안에 처리되지 않으면 폐기됩니다.`,
    )
  }
  const cur = await c.call('memory.get', { room: room.id })
  if (action === 'view') {
    const lines = [renderMemory(p, room.name, cur)]
    if (cur.proposals?.length) {
      lines.push('', '대기 중인 제안:')
      for (const x of cur.proposals)
        lines.push(`  ${x.id} · ${p.dir.name(x.by) ?? x.by} · ${shortTime(x.ts)}: ${x.text}`)
    }
    return ok(lines.join('\n'))
  }
  const items = cur.items.slice()
  let desc = cur.desc
  const pos = Number(a.pos)
  const inRange = Number.isInteger(pos) && pos >= 1 && pos <= items.length
  if (action === 'describe') desc = a.text ?? ''
  else if (action === 'add') {
    if (!a.text?.trim()) return fail('text 가 필요합니다')
    items.push(a.text)
  } else if (action === 'edit') {
    if (!inRange) return fail(`pos 는 1~${items.length} 중 하나입니다`)
    if (!a.text?.trim()) return fail('text 가 필요합니다')
    items[pos - 1] = a.text
  } else if (action === 'remove') {
    if (!inRange) return fail(`pos 는 1~${items.length} 중 하나입니다`)
    items.splice(pos - 1, 1)
  } else return fail(`모르는 action: ${action}`)
  const r = await session.call('memory.set', { room: room.id, desc, items, rev: cur.rev })
  return ok(
    `✓ '${room.name}' 방 메모리를 고쳤습니다 (판 ${r.rev}) — 그 방의 새 세션부터 들어갑니다\n\n${renderMemory(p, room.name, { ...cur, desc, items })}`,
  )
}

function renderMemory(
  p: Plugin,
  roomName: string,
  m: { desc: string; items: string[]; updatedAt: string | null; updatedBy: string | null },
): string {
  if (!m.desc && !m.items.length) return `'${roomName}' 방 메모리: 비어 있습니다`
  const by = m.updatedBy ? ` — ${p.dir.name(m.updatedBy) ?? m.updatedBy}` : ''
  const lines = [
    `'${roomName}' 방 메모리${m.updatedAt ? ` (${shortTime(m.updatedAt)} 수정${by})` : ''}`,
  ]
  if (m.desc) lines.push(`설명  ${m.desc}`)
  m.items.forEach((t, i) => lines.push(`${i + 1}. ${t}`))
  if (m.items.length < 3) lines.push(`(내용 ${m.items.length}/3)`)
  return lines.join('\n')
}

// ── agree ────────────────────────────────────────────────────────

async function agree(p: Plugin, a: Args): Promise<ToolResult> {
  const session = await ready(p)
  if (isResult(session)) return session
  const c = p.link.client!
  switch (a.action) {
    case 'propose': {
      if (!a.to?.trim() || !a.summary?.trim())
        return fail('propose 에는 to 와 summary 가 필요합니다')
      let roomId = a.thread
        ? (p.received.get(a.thread)?.room ?? p.asked.get(a.thread)?.room)
        : undefined
      if (a.thread && !roomId)
        roomId = (await c.call('thread.get', { thread: a.thread, limit: 1 }).catch(() => null))
          ?.thread.room
      const room = roomId ? p.dir.room(roomId) : pickRoom(p, session, a.room)
      if (!room) return fail('그 대화의 방을 찾지 못했습니다 — room 을 넣어 주세요')
      if (isResult(room)) return room
      const who = await memberIn(p, room, a.to)
      if (isResult(who)) return who
      const r = await session.call('agree.propose', {
        room: room.id,
        to: who.id,
        summary: a.summary,
        ...(a.details ? { details: a.details } : {}),
        ...(a.thread ? { thread: a.thread } : {}),
      })
      p.proposed.set(r.agree, { to: who.name, summary: a.summary })
      return ok(
        `✓ '${who.name}'님에게 합의를 제안했습니다 (${r.agree}) — 확인하면 '${room.name}' 방 전원이 보는 합의 대장에 기록됩니다. 72시간 안에 확인이 없으면 만료됩니다`,
      )
    }
    case 'confirm':
    case 'reject': {
      if (!a.agree_id) return fail('agree_id 가 필요합니다 — 제안 꼬리표의 agree 값입니다')
      const r = await session.call('agree.resolve', {
        agree: a.agree_id.trim(),
        result: a.action,
        ...(a.reason ? { reason: a.reason } : {}),
      })
      return ok(
        r.state === 'confirmed'
          ? `✓ 합의를 확정했습니다 (${r.agree}) — 방 전원이 봅니다`
          : `✓ 합의 제안을 거절했습니다 (${r.agree}) — 제안한 사람에게 이유가 갑니다`,
      )
    }
    case 'list': {
      const roomRef = a.room ? p.dir.room(a.room) : undefined
      if (a.room && !roomRef) return fail(`'${a.room}' 방에 참가하지 않았습니다`)
      const peer = a.peer ? await memberAnywhere(p, a.peer) : undefined
      if (a.peer && !peer) return fail(`'${a.peer}'님을 찾지 못했습니다`)
      const r = await c.call('agree.list', {
        ...(roomRef ? { room: roomRef.id } : {}),
        ...(peer ? { peer } : {}),
        limit: 50,
      })
      if (!r.entries.length) return ok('합의가 없습니다')
      for (const e of r.entries) await p.dir.detail(e.room).catch(() => null)
      const n = (id: string) => p.dir.name(id) ?? id
      const label: Record<string, string> = {
        confirmed: '확정',
        pending: '확인 대기',
        rejected: '거절',
        expired: '만료',
      }
      const lines = r.entries.map(
        (e) =>
          `  [${shortTime(e.ts)}] [${p.dir.roomName(e.room) ?? e.room}] ${n(e.proposer)} → ${n(e.to)} · ${label[e.state] ?? e.state}: ${e.summary}${e.details ? ` — ${clip(e.details, 160)}` : ''} (${e.id})`,
      )
      return ok(
        [`합의 (${r.entries.length}건 — 확정은 방 전원 · 나머지는 당사자만 보임):`, ...lines].join(
          '\n',
        ),
      )
    }
    default:
      return fail(`모르는 action: ${a.action ?? '(없음)'} — propose · confirm · reject · list`)
  }
}

// ── status · away · room ─────────────────────────────────────────

const PRESENCE: Record<string, string> = { online: '🟢', away: '🟡', off: '🌙', offline: '⚪' }

async function status(p: Plugin, a: Args): Promise<ToolResult> {
  if (a.auto_reply === 'on' || a.auto_reply === 'off')
    p.link.save({ autoReply: a.auto_reply === 'on' })
  else if (a.auto_reply) return fail(`auto_reply 는 on · off 입니다: ${a.auto_reply}`)
  const cfg = p.link.config()
  const autoLine = `자동 답장: ${p.autoReply ? '켜짐 (규약 안에서 바로 답함)' : '꺼짐 (답장 초안을 사용자에게 보이고 승인받은 뒤 보냄)'}`
  const session = await ready(p)
  if (isResult(session)) {
    return ok(
      [
        `✗ ${session.content[0]!.text.replace(/^✗ /, '')}`,
        cfg.server ? `서버: ${cfg.server}` : null,
        autoLine,
      ]
        .filter(Boolean)
        .join('\n'),
    )
  }
  const c = p.link.client!
  const w = p.link.welcome!
  await p.heartbeat()
  const rooms = (await c.call('room.list', {})).rooms
  p.dir.setRooms(
    rooms.map((r) => ({
      id: r.id,
      name: r.name,
      myName: r.myName,
      role: r.role,
      archived: r.archived,
    })),
  )
  const held = new Set(session.held)
  const list = classifyRooms(
    Object.fromEntries(rooms.map((r) => [r.name, r.myName])),
    rooms.filter((r) => held.has(r.id)).map((r) => r.name),
    rooms.filter((r) => p.heldElsewhere.includes(r.id)).map((r) => r.name),
  )
  const lines = [
    `Meshwork — '${w.org.name}' 조직 @ ${new URL(cfg.server!).host}`,
    `나: ${w.me.name}${w.me.role === 'admin' ? ' (조직 관리자)' : ''} · ${p.off ? '🌙 퇴근 중 — 팀 메시지는 보관됩니다(away off 로 출근)' : '🟢 출근'}`,
    `이 세션이 받는 방: ${session.held.map((r) => p.dir.roomName(r) ?? r).join(', ') || '(없음 — /meshwork:room 으로 받을 방을 정하세요)'}`,
    rooms.length
      ? `참가한 방 ${rooms.length}개\n${renderRooms(list)}`
      : '참가한 방: (없음 — 초대 링크로 /meshwork:join)',
  ]
  for (const id of session.held) {
    const d = await p.dir.detail(id).catch(() => null)
    if (!d) continue
    const people = d.members
      .filter((m) => m.member !== p.me)
      .map(
        (m) =>
          `${PRESENCE[m.presence] ?? ''}${m.kind === 'service' ? '🤖' : ''}${m.name}${m.noack ? '⚠️' : ''}${m.always ? '(상시)' : ''}`,
      )
      .join(' ')
    lines.push(`  [${d.name}] ${people || '(혼자)'}`)
  }
  if (session.held.length)
    lines.push(
      '  🟢 출근 · 🟡 자리 비움 · 🌙 퇴근(보관) · ⚪ 오프라인(보관) · ⚠️ 최근 무응답 · 🤖 봇',
    )
  lines.push(autoLine)
  if (p.link.contextChanged)
    lines.push('ℹ️ 세션을 켠 뒤 팀 규약 · 방 메모리가 바뀌었습니다 — 새 세션부터 들어갑니다')
  const notice = p.noticeLine()
  if (notice) lines.push(`📢 ${notice}`)
  return ok(lines.join('\n'))
}

async function away(p: Plugin, a: Args): Promise<ToolResult> {
  if (a.mode !== 'on' && a.mode !== 'off') return fail('mode 는 on(퇴근) · off(출근) 입니다')
  const session = await ready(p)
  if (isResult(session)) return session
  const c = p.link.client!
  if (a.mode === 'on') {
    await c.call('presence.set', { presence: 'off' })
    p.off = true
    p.exportState()
    return ok(
      '🌙 퇴근했습니다 — 팀 메시지는 서버에 보관되고(보관 기한이 멈춤) 출근하면 한꺼번에 옵니다. 보내기는 계속 됩니다.',
    )
  }
  const before = await c.call('diag.get', {}).catch(() => null)
  await c.call('presence.set', { presence: 'online' })
  p.off = false
  p.exportState()
  const n = before?.queued.count ?? 0
  return ok(
    n > 0
      ? `✓ 출근했습니다 — 보관 ${n}건이 곧 옵니다.${n >= 2 ? ' 하나씩 답하기 전에 누가 · 무엇을 · 얼마나 급한지 사용자에게 먼저 요약하세요.' : ''}`
      : '✓ 출근했습니다 — 보관된 메시지는 없습니다.',
  )
}

async function room(p: Plugin, a: Args): Promise<ToolResult> {
  const session = await ready(p)
  if (isResult(session)) return session
  const c = p.link.client!
  const rooms = (await c.call('room.list', {})).rooms
  p.dir.setRooms(
    rooms.map((r) => ({
      id: r.id,
      name: r.name,
      myName: r.myName,
      role: r.role,
      archived: r.archived,
    })),
  )
  await p.heartbeat()
  const held = new Set(session.held)
  const byName = Object.fromEntries(rooms.map((r) => [r.name, r.myName]))
  const list = classifyRooms(
    byName,
    rooms.filter((r) => held.has(r.id)).map((r) => r.name),
    rooms.filter((r) => p.heldElsewhere.includes(r.id)).map((r) => r.name),
  )
  let wanted: RoomRef[]
  if (!a.rooms?.trim()) {
    const header = `이 세션이 받는 방: ${session.held.map((r) => p.dir.roomName(r) ?? r).join(', ') || '(없음)'}`
    if (!rooms.length) return ok(`${header}\n참가한 방이 없습니다 — 초대 링크로 /meshwork:join`)
    const body = `${header}\n\n참가한 방 ${rooms.length}개\n${renderRooms(list)}`
    const selectable = list.filter((r) => r.mark !== 'mine')
    if (!selectable.length) return ok(body)
    const picked = await p.host.choose({
      message: '이 세션이 받을 방을 고르세요',
      title: '받을 방',
      options: selectable.map((r) => ({ value: r.room, label: choiceLabel(r) })),
    })
    if (picked === null) return ok(`${body}\n\n→ /meshwork:room <방 이름> 으로 정하세요`)
    wanted = [p.dir.room(picked)!]
  } else {
    const names = a.rooms
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
    const missing = names.filter((n) => !p.dir.room(n))
    if (missing.length)
      return fail(
        `참가하지 않은 방입니다: ${missing.join(', ')} — 초대 링크를 받아 /meshwork:join 하세요`,
      )
    wanted = names.map((n) => p.dir.room(n)!)
  }
  const r = await session.hold(
    wanted.map((x) => x.id),
    true,
  )
  p.link.remember(session.held)
  p.exportState()
  const n = (ids: string[]) => ids.map((id) => p.dir.roomName(id) ?? id).join(', ')
  return ok(
    [
      `✓ 이 세션이 받는 방: ${n(session.held) || '(없음)'}`,
      r.taken.length
        ? `↪ 다른 세션이 받던 방을 가져왔습니다: ${n(r.taken)} — 그 세션은 이제 받지 못합니다`
        : null,
      r.lost.length ? `⚠️ 받지 못한 방: ${n(r.lost)}` : null,
      '--resume 으로 다시 켜면 이 방들을 되찾습니다.',
    ]
      .filter(Boolean)
      .join('\n'),
  )
}

// ── route ────────────────────────────────────────────────────────

function route(p: Plugin, a: Args): ToolResult {
  const routes = p.link.config().routes ?? []
  switch (a.action) {
    case 'list': {
      const r = renderRoutes(routes)
      return ok(r ?? '질문 배분이 비어 있습니다 — route(action:"add") 로 등록할 수 있습니다')
    }
    case 'add': {
      if ((!a.keywords && !a.room) || !a.session)
        return fail('add 에는 session 과 함께 keywords 또는 room 이 필요합니다')
      const r = addRoute(routes, a.session, a.keywords, a.room)
      p.link.save({ routes: r.routes })
      return ok(`✓ 등록${r.replaced ? '(같은 항목을 바꿈)' : ''}: ${labelOf(r.entry)}`)
    }
    case 'remove': {
      if (!a.keywords && !a.room) return fail('remove 에는 keywords 또는 room 이 필요합니다')
      const r = removeRoute(routes, a.keywords, a.room)
      if (!r.removed) return fail('그런 항목이 없습니다 — action:"list" 로 확인하세요')
      p.link.save({ routes: r.routes })
      return ok(`✓ 지움: ${a.room ? `[방 ${a.room}]` : `"${a.keywords}"`}`)
    }
    default:
      return fail(`모르는 action: ${a.action ?? '(없음)'} — list · add · remove`)
  }
}

// ── join · owner ─────────────────────────────────────────────────

async function joinRoom(p: Plugin, a: Args): Promise<ToolResult> {
  const input = a.link?.trim()
  if (!input) return fail('초대 링크가 필요합니다 — /meshwork:join <초대 링크>')
  const server = p.link.config().server
  if (!server) return fail(notReadyText(p.link.state, { lang: p.lang }))
  let url: URL
  try {
    url = /^[a-z][a-z0-9+.-]*:/i.test(input)
      ? new URL(input)
      : new URL(`/join/${encodeURIComponent(input)}`, server)
  } catch {
    return fail('초대 링크가 올바르지 않습니다')
  }
  if (url.origin !== new URL(server).origin || !/^\/join\/[^/]+$/.test(url.pathname)) {
    return fail(
      `이 링크는 지금 서버(${new URL(server).host})의 초대 링크가 아닙니다 — 다른 서버라면 그 서버로 /meshwork:login 한 뒤 여세요`,
    )
  }
  p.joinedAt = Date.now()
  const opened = await p.host.openBrowser(url.toString())
  return ok(
    [
      opened
        ? '브라우저에서 초대 링크를 열었습니다.'
        : `브라우저를 열지 못했습니다 — 이 주소를 브라우저에서 여세요: ${url.toString()}`,
      '→ 화면에서 조직 · 방 · 초대한 사람을 확인하고 [참가]를 누르세요. 참가하면 이 세션이 그 방을 받고 여기에 「방 참가」 가 옵니다.',
      '(초대는 사람이 직접 수락해야 해서 플러그인이 대신 참가하지 않습니다)',
    ].join('\n'),
  )
}

async function owner(p: Plugin, a: Args): Promise<ToolResult> {
  const session = await ready(p)
  if (isResult(session)) return session
  const c = p.link.client!
  if (!a.room) return fail('room 이 필요합니다')
  const r = p.dir.room(a.room)
  if (!r) return fail(`'${a.room}' 방에 참가하지 않았습니다`)
  switch (a.action) {
    case 'invite': {
      const x = await c.call('room.invite', {
        room: r.id,
        ...(a.name?.trim() ? { name: a.name.trim() } : {}),
      })
      return ok(
        [
          `✓ 초대 링크 (1회용 · ${shortTime(x.expiresAt)} 까지 · '${r.name}' 방${a.name ? ` · 이름 '${a.name}'` : ''}):`,
          '',
          `  ${x.link}`,
          '',
          '받을 사람에게 전하세요 — 링크를 열고 로그인한 뒤 [참가]를 누르면 됩니다.',
          `링크 주소는 지금만 보입니다(목록에는 번호만). 잘못 보냈으면 /meshwork:owner revoke ${r.name} ${x.invite}`,
        ].join('\n'),
      )
    }
    case 'invites': {
      const x = await c.call('room.invites', { room: r.id })
      if (!x.invites.length) return ok(`'${r.name}' 방에 살아 있는 초대 링크가 없습니다`)
      await p.dir.detail(r.id).catch(() => null)
      const lines = x.invites.map(
        (i) =>
          `  ${i.id} · ${p.dir.name(i.createdBy) ?? i.createdBy} · ${shortTime(i.createdAt)} 만듦 · ${shortTime(i.expiresAt)} 까지${i.name ? ` · 이름 '${i.name}'` : ''}`,
      )
      return ok(
        [
          `'${r.name}' 방의 살아 있는 초대 링크 ${x.invites.length}개(주소는 만들 때만 보입니다):`,
          ...lines,
        ].join('\n'),
      )
    }
    case 'revoke': {
      if (!a.invite?.trim())
        return fail('invite(초대 링크 번호 inv_…)가 필요합니다 — invites 로 봅니다')
      await c.call('room.invite_revoke', { room: r.id, invite: a.invite.trim() })
      return ok(`✓ 초대 링크 ${a.invite.trim()} 를 취소했습니다 — 그 링크로는 참가할 수 없습니다`)
    }
    case 'kick': {
      if (!a.name?.trim()) return fail('kick 에는 name(내보낼 사람 이름)이 필요합니다')
      const who = await memberIn(p, r, a.name)
      if (isResult(who)) return who
      await c.call('room.kick', { room: r.id, member: who.id })
      p.dir.invalidate(r.id)
      return ok(
        `✓ '${who.name}'님을 '${r.name}' 방에서 내보냈습니다(다른 방 · 조직은 그대로). 그 사람 앞으로 보관돼 있던 그 방 메시지는 폐기되고 보낸 사람들에게 알려집니다`,
      )
    }
    case 'notice': {
      if (!a.text?.trim()) return fail('notice 에는 text(공지 내용)가 필요합니다')
      // 방장이 에이전트에게 시킨 공지 — 세션으로 보낸다(쓴 쪽 = 에이전트 · 그 방을 받는 세션만 — 명세 §10.5)
      if (!session.held.includes(r.id)) {
        return fail(
          `이 세션은 '${r.name}' 방을 받지 않아 그 방에 공지할 수 없습니다 — 사용자가 원하면 /meshwork:room ${r.name}`,
        )
      }
      const x = await session.call('room.notice', { room: r.id, text: a.text })
      return ok(`✓ '${r.name}' 방 공지를 보냈습니다 — 바로 ${x.sent}명 · 보관 ${x.queued}명`)
    }
    default:
      return fail(
        `모르는 action: ${a.action ?? '(없음)'} — invite · invites · revoke · kick · notice`,
      )
  }
}

// ── login ────────────────────────────────────────────────────────

async function login(p: Plugin, a: Args): Promise<ToolResult> {
  const action = a.action ?? 'login'
  if (action === 'logout') {
    const r = await p.link.logout()
    p.exportState()
    if (!r.had) return ok('로그인돼 있지 않습니다')
    return ok(
      r.revoked
        ? '✓ 로그아웃했습니다 — 이 기기의 로그인을 서버에서 폐기했고 토큰을 지웠습니다(이 기기의 다른 터미널도 끊깁니다)'
        : '✓ 이 기기의 토큰을 지웠습니다 — 다만 서버에 닿지 못해 폐기는 못 했습니다. 앱이나 조직 콘솔의 기기 목록에서 이 기기를 끊으세요',
    )
  }
  if (action === 'org') {
    if (p.link.state.kind === 'no_server' || p.link.state.kind === 'logged_out') {
      await p.link.ready(0)
      if (p.link.state.kind === 'no_server' || p.link.state.kind === 'logged_out')
        return fail(notReadyText(p.link.state, { lang: p.lang }))
    }
    const { org, orgs } = await p.link.switchOrg(a.org)
    p.exportState()
    if (org)
      return ok(
        `✓ '${org.name}' 조직에 붙습니다 — 이 세션의 받는 방은 /meshwork:status 로 확인하세요`,
      )
    const active = orgs.filter((o) => o.membership === 'active')
    if (!active.length) return fail(notReadyText({ kind: 'no_org', orgs }, { lang: p.lang }))
    return ok(
      `${a.org ? `'${a.org}' 조직을 찾지 못했습니다` : '조직을 고르지 않았습니다'} — 속한 조직: ${active.map((o) => `'${o.name}'`).join(', ')} · /meshwork:login org <조직 이름> 으로 고르세요`,
    )
  }
  if (action !== 'login') return fail(`모르는 action: ${action} — login · org · logout`)
  const cfg = p.link.config()
  const loggedIn =
    p.link.state.kind === 'open' ||
    p.link.state.kind === 'connecting' ||
    p.link.state.kind === 'reconnecting'
  if (loggedIn && (!a.server || cfg.server === safeOrigin(a.server))) {
    return ok(
      `이미 로그인돼 있습니다 ('${cfg.orgName ?? cfg.org}' 조직 @ ${cfg.server ? new URL(cfg.server).host : ''}) — 다른 계정으로 바꾸려면 /meshwork:login logout 뒤 다시 로그인하세요`,
    )
  }
  const t = await p.link.beginLogin(a.server)
  p.exportState()
  const opened = await p.host.openBrowser(t.verificationUriComplete)
  return ok(
    [
      `Meshwork 로그인 — ${new URL(t.server).host}`,
      '',
      `  확인 코드: ${t.userCode}`,
      '',
      opened
        ? '브라우저에서 로그인 화면을 열었습니다.'
        : `브라우저에서 이 주소를 여세요: ${t.verificationUri}`,
      `→ 회사 계정으로 로그인한 뒤, 승인 화면의 코드가 위 코드와 같은지 확인하고 [허용]을 누르세요(${Math.round(t.expiresIn / 60)}분 안에).`,
      '끝나면 이 세션에 「로그인 완료」 가 옵니다.',
    ].join('\n'),
  )
}

function safeOrigin(input: string): string | undefined {
  try {
    return new URL(/^https:\/\//i.test(input.trim()) ? input.trim() : `https://${input.trim()}`)
      .origin
  } catch {
    return undefined
  }
}

// ── doctor ───────────────────────────────────────────────────────

/** 이 파일(번들)이 놓인 플러그인 폴더 — 소스는 plugin/app, 번들은 plugin/dist */
function pluginDir(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return /[\\/](dist|app)$/.test(here) ? dirname(here) : here
}

function versionCmp(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0)
  return 0
}

async function doctor(p: Plugin): Promise<ToolResult> {
  const lines: string[] = ['Meshwork 자가 진단']
  const check = (good: boolean, label: string, detail: string, fix?: string): void => {
    lines.push(`  ${good ? '✓' : '✗'} ${label}: ${detail}`)
    if (!good && fix) lines.push(`     → ${fix}`)
  }
  const info = (label: string, detail: string): void => void lines.push(`  ℹ️ ${label}: ${detail}`)

  // ── 이 기기 ──
  check(
    p.host.nodeMajor >= MIN_NODE,
    '런타임',
    `${p.host.runtime} · 플러그인 v${PLUGIN_VERSION}`,
    `Node ${MIN_NODE} 이상이 필요합니다 — https://nodejs.org 에서 설치한 뒤 새 세션을 여세요`,
  )
  check(
    p.host.isTeam,
    '팀 세션',
    p.host.isTeam ? '예 (meshwork-claude)' : '아니요 — 이 세션에서는 팀 기능을 쓸 수 없습니다',
    'meshwork-claude 로 켠 세션에서 /meshwork:doctor 를 다시 실행하세요',
  )
  const cfgPath = p.paths.config
  const cfg = loadConfig(cfgPath)
  for (const [label, path] of [
    ['설정 파일', cfgPath],
    ['토큰 파일', p.paths.tokens],
  ] as const) {
    if (!existsSync(path)) continue
    const mode = statSync(path).mode & 0o777
    check(
      mode === 0o600,
      `${label} 권한`,
      `0${mode.toString(8)}`,
      `chmod 600 ${path} 을 실행하세요(본인만 읽기)`,
    )
  }
  const dir = pluginDir()
  check(
    existsSync(join(dir, 'dist', 'guard.mjs')) &&
      existsSync(join(dirname(dir), 'hooks', 'hooks.json')),
    '보호 훅',
    '토큰 · 설정 폴더 · 플러그인 설치본 · 훅을 끄는 설정을 막음',
    '플러그인을 다시 설치하세요(/plugin)',
  )
  // 업데이트하면 이미 떠 있던 세션은 옛 코드로 돈다 — 새 세션이 필요하다(명세 D.3)
  try {
    const versions = readdirSync(dirname(dirname(dir))).filter((d) => /^\d+\.\d+\.\d+$/.test(d))
    const newer = versions
      .filter((v) => versionCmp(v, PLUGIN_VERSION) > 0)
      .sort(versionCmp)
      .pop()
    if (newer)
      check(
        false,
        '실행 중 버전',
        `v${PLUGIN_VERSION} (설치본은 v${newer})`,
        '업데이트 전 버전으로 돌고 있습니다 — 새 세션을 여세요',
      )
  } catch {
    /* 소스에서 돌면 버전 폴더가 없다 */
  }
  const settings = (() => {
    try {
      return readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8')
    } catch {
      return ''
    }
  })()
  const statusLine = settings.match(/"statusLine"\s*:\s*\{[^}]*\}/)?.[0] ?? ''
  if (/meshwork/.test(statusLine)) check(true, '상태줄', '등록됨')
  else if (/team-relay/.test(statusLine))
    info(
      '상태줄',
      `지금은 team-relay 것입니다(시범 기간엔 그대로) — 이사 날 "command": "${p.paths.statusline.replace(homedir(), '~')}" 로 바꾸세요`,
    )
  else
    check(
      false,
      '상태줄',
      '미설정',
      `~/.claude/settings.json 에 "statusLine": { "type": "command", "command": "${p.paths.statusline.replace(homedir(), '~')}" } 를 넣으세요 — 연결이 끊겨도 상태줄이 알려 줍니다`,
    )
  try {
    if (
      /"team-relay@/.test(
        readFileSync(join(homedir(), '.claude', 'plugins', 'installed_plugins.json'), 'utf8'),
      )
    ) {
      info(
        'team-relay',
        '같이 설치돼 있습니다 — 시범 기간에는 정상입니다(켜는 명령이 다름). 이사 날 지우세요',
      )
    }
  } catch {
    /* 설치 목록을 못 읽음 */
  }
  if (!p.host.isTeam) return ok(lines.join('\n'))

  // ── 로그인 · 연결 ──
  check(!!cfg?.server, '서버', cfg?.server ?? '모름', '/meshwork:login <서버 주소> 로 로그인하세요')
  if (!cfg?.server) return ok(lines.join('\n'))
  const isReady = await p.link.ready(5_000)
  const st = p.link.state
  check(
    isReady,
    '연결',
    isReady ? `붙음 — '${p.link.welcome?.org.name}' 조직` : notReadyText(st, { lang: p.lang }),
  )
  if (!isReady || !p.link.client) return ok(lines.join('\n'))
  try {
    const d = await p.link.client.call('diag.get', {})
    const held = p.link.session?.held ?? []
    check(
      held.length > 0 || !p.dir.rooms.length,
      '이 세션이 받는 방',
      held.map((r) => p.dir.roomName(r) ?? r).join(', ') || '(없음)',
      '/meshwork:room 으로 이 세션이 받을 방을 정하세요',
    )
    const elsewhere = [...new Set(d.heldElsewhere.map((x) => x.room))]
    if (elsewhere.length)
      info(
        '다른 세션이 받는 방',
        `${elsewhere.map((r) => p.dir.roomName(r) ?? r).join(', ')} — 정상일 수 있습니다. 이 세션에서 받으려면 /meshwork:room (그 세션은 받지 못하게 됩니다)`,
      )
    if (p.off) lines.push('  🌙 퇴근 중 — 받는 메시지는 보관됩니다(/meshwork:away off 로 출근)')
    check(
      d.queued.count === 0 || p.off,
      '보관 메시지',
      d.queued.count === 0 ? '없음' : `${d.queued.count}건${p.off ? ' (퇴근 중 — 정상)' : ''}`,
      '받는 세션이 없는 방 앞으로 쌓였을 수 있습니다 — /meshwork:status 로 받는 방을 확인하세요',
    )
    const injected = p.link.context?.rules?.rev
    check(
      injected === d.rulesRev && !p.link.contextChanged,
      '팀 규약',
      injected === undefined
        ? `서버 판 ${d.rulesRev} — 이 세션은 최소 규약으로 시작함`
        : injected === d.rulesRev
          ? `판 ${d.rulesRev} — 최신`
          : `서버 판 ${d.rulesRev} / 이 세션 판 ${injected}`,
      '새 세션을 열면 새 규약 · 방 메모리가 들어갑니다',
    )
    const skew = Math.abs(Date.now() - Date.parse(d.serverTime))
    check(
      skew < 60_000,
      '시계',
      `서버와 ${Math.round(skew / 1000)}초 차이`,
      '보관 만료 · 무응답은 서버 시각 기준입니다 — 이 기기 시계를 맞추세요',
    )
  } catch (e) {
    check(false, '서버 진단', errorText(e, { lang: p.lang }))
  }
  const notice = p.noticeLine()
  if (notice) info('공지', notice)
  return ok(lines.join('\n'))
}
