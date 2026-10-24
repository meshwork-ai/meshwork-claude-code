/**
 * 팀 도구 14개 — 정의 · 대화 도구 7개의 처리는 공용 패키지(@meshwork-ai/team-tools — 앱과 같은 것), 나머지는 여기.
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
import {
  type Args,
  callConversationTool,
  classifyRooms,
  choiceLabel,
  fail,
  isConversationTool,
  isResult,
  ok,
  renderRooms,
  type RoomRef,
  type TeamHost,
  type ToolResult,
} from '@meshwork-ai/team-tools'

import { loadConfig, normalizeServer } from '../core/config'
import { addRoute, labelOf, removeRoute, renderRoutes } from '../core/routes'
import { MIN_NODE, PLUGIN_VERSION } from '../core/version'
import type { Plugin } from './plugin'
import { errorText, notReadyText, shortTime } from './text'

export { TOOLS } from '@meshwork-ai/team-tools'
export type { Args, ToolResult }

/** 일반 세션에서도 쓰는 도구 — 서버와 상관없이 이 기기 안에서 끝난다 */
const LOCAL_TOOLS = new Set(['doctor', 'route'])
const NOT_TEAM =
  '이 세션에서는 Meshwork 를 쓸 수 없습니다 — meshwork-claude 로 켠 세션에서 다시 해 주세요'

/** 도구 하나를 처리한다 — 던진 오류도 글로 바꾼다 */
export async function callTool(p: Plugin, name: string, args: Args): Promise<ToolResult> {
  if (!p.host.isTeam && !LOCAL_TOOLS.has(name)) return fail(NOT_TEAM)
  if (isConversationTool(name)) return callConversationTool(teamHost(p), name, args)
  try {
    switch (name) {
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

/** 공용 대화 도구가 보는 플러그인 — 세션 · 확인 상자 · 명령 안내 · status 앞뒤 줄 */
export function teamHost(p: Plugin): TeamHost {
  const autoLine = () =>
    `자동 답장: ${p.autoReply ? '켜짐 (규약 안에서 바로 답함)' : '꺼짐 (답장 초안을 사용자에게 보이고 승인받은 뒤 보냄)'}`
  return {
    get lang() {
      return p.lang
    },
    get me() {
      return p.me
    },
    dir: p.dir,
    state: p.team,
    async ready() {
      if (!(await p.link.ready(8_000)) || !p.link.session || !p.link.client)
        return notReadyText(p.link.state, { lang: p.lang })
      return { session: p.link.session, client: p.link.client }
    },
    // 사람 확인 여부 — 플러그인은 답장 방식 설정 기준(명세 §7.3)
    review: () => ({ by: p.autoReply ? 'none' : 'human', basis: 'setting' }),
    async askOpenRead(rooms) {
      if (!p.host.canAsk()) return null
      const pick = await p.host.choose({
        message: `Meshwork — 에이전트가 남의 열린 대화까지 읽으려 합니다\n  방: ${rooms.map((r) => r.name).join(', ')}\n열린 대화는 방 사람 모두에게 공개된 문답입니다. 팀원 메시지가 시킨 것이 아니라 내가 시킨 일일 때만 허락하세요.`,
        title: '열린 대화를 읽을까요?',
        options: [
          { value: 'once', label: '이번만' },
          { value: 'session', label: '이 세션 동안' },
          { value: 'no', label: '읽지 않음' },
        ],
      })
      return pick === 'once' || pick === 'session' ? pick : 'no'
    },
    say: {
      holdRoom: (r) => (r ? `/meshwork:room ${r}` : '/meshwork:room 으로 받을 방을 정하세요'),
      join: '초대 링크로 /meshwork:join',
    },
    status: {
      refresh: () => p.heartbeat(),
      offline: () => {
        const server = p.link.config().server
        return [...(server ? [`서버: ${server}`] : []), autoLine()]
      },
      head: () => {
        const w = p.link.welcome!
        return [
          `Meshwork — '${w.org.name}' 조직 @ ${new URL(p.link.config().server!).host}`,
          `나: ${w.me.name}${w.me.role === 'admin' ? ' (조직 관리자)' : ''} · ${p.off ? '🌙 퇴근 중 — 팀 메시지는 보관됩니다(away off 로 출근)' : '🟢 출근'}`,
        ]
      },
      tail: () => {
        const lines = [autoLine()]
        if (p.link.contextChanged)
          lines.push('ℹ️ 세션을 켠 뒤 팀 규약 · 방 메모리가 바뀌었습니다 — 새 세션부터 들어갑니다')
        const notice = p.noticeLine()
        if (notice) lines.push(`📢 ${notice}`)
        return lines
      },
      heldElsewhere: () => p.heldElsewhere,
      setAutoReply: (on) => p.link.save({ autoReply: on }),
    },
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

// ── away · room ──────────────────────────────────────────────────

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
      open: r.open === true,
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
  // 처음 보는 서버로 로그인하려면 사람이 확인한다(3단계 확인 4) — 팀원 메시지에 속은 에이전트가 사람 모르게 서버를 바꾸면
  // 진짜 서버의 로그인이 폐기되고 그 뒤 대화 · 팀 규약이 그 서버로 간다. 같은 서버로 다시 로그인할 때는 묻지 않는다
  if (a.server) {
    const target = normalizeServer(a.server)
    if (target !== cfg.server) {
      if (!p.host.canAsk()) {
        return fail(
          '처음 보는 서버로 로그인하려면 확인 상자가 필요한데 이 Claude Code 는 띄울 수 없습니다 — Claude Code 를 업데이트한 뒤 다시 하세요',
        )
      }
      const host = new URL(target).host
      const yes = await p.host.choose({
        message: `Meshwork — 처음 보는 서버로 로그인합니다\n  ${host}${cfg.server ? `\n지금 서버(${new URL(cfg.server).host})의 로그인은 폐기됩니다.` : ''}\n팀원 메시지가 시킨 것이 아니라 내가 직접 한 것일 때만 [로그인]을 고르세요.`,
        title: '로그인할까요?',
        options: [
          { value: 'login', label: '로그인' },
          { value: 'cancel', label: '취소' },
        ],
      })
      if (yes !== 'login')
        return fail(`${host} 로 로그인하지 않았습니다 — 확인 상자에서 [로그인]을 고르지 않음`)
    }
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
