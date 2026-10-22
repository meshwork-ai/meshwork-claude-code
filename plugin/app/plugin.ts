/**
 * 플러그인 본체 — 서버 알림을 세션에 넣고(채널), 상태를 상태줄에 내보낸다. 도구는 tools.ts.
 *
 * 세션에 넣는 것 · 넣지 않는 것(명세 · 아키텍처 §13):
 *  - 넣음: 이 세션 몫의 메시지(꼬리표 — core/tags.ts) · 내가 물은 질문의 무응답 · 만료 · 담당 변경 · 내가 제안한 합의의 결과 ·
 *    받는 방을 잃음 · 방 참가 · 다른 곳에서 이미 답함(가로채기) · 다시 붙지 않게 됨 · 로그인 결과
 *  - 넣지 않음: 규약 · 방 메모리의 새 전문(새 세션부터 — 상태줄 · doctor) · 서비스 공지 · 조직 공지(상태줄 · doctor 한 줄)
 *
 * **받았다는 알림(ack)은 세션에 넘긴 뒤에** — 넣기가 실패하면 약속을 거절해 ack 하지 않는다(서버가 다시 보낸다 — 연결 계약 §6).
 */
import type { MeshworkClient, Session } from '@meshwork-ai/client-core'
import { type Lang, pickLang } from '@meshwork-ai/i18n'
import type { EvData } from '@meshwork-ai/protocol'

import type { Paths } from '../core/paths'
import { type SessionState, sweepStaleStates, writeState } from '../core/state'
import { type Message, tagMessage } from '../core/tags'
import type { Host } from '../host/types'
import { type Link, type LinkState, type MyOrg } from './link'
import { Directory, type RoomRef } from './names'
import { errorText, notReadyText, stoppedText } from './text'

/** 상태 하트비트 — 상태줄은 60초 넘게 낡으면 「플러그인 미동작」 으로 본다 */
export const HEARTBEAT_MS = Number(process.env.MESHWORK_HEARTBEAT_MS ?? 30_000)
/** join 도구를 쓴 뒤 이 시간 안에 들어온 방은 이 세션이 받는다 */
const JOIN_WINDOW_MS = 10 * 60 * 1000

export class Plugin {
  readonly dir: Directory
  lang: Lang = 'ko'
  /** 받은 질문 — 대화 id → 보낸 사람 · 방 (가로채기 판단) */
  readonly received = new Map<string, { from: string; room?: string; open?: boolean }>()
  /** 이 세션에서 답한 대화 */
  readonly repliedHere = new Set<string>()
  /** 다른 곳(앱 · 다른 기기)에서 이미 답한 대화 — reply 가 거절한다 */
  readonly answeredElsewhere = new Set<string>()
  /** 내가 물은 대화 — 대화 id → 받는 사람 이름 · 방 */
  readonly asked = new Map<string, { to: string; room: string; preview: string }>()
  /** 내가 제안한 합의 — 합의 id → 상대 · 요약 */
  readonly proposed = new Map<string, { to: string; summary: string }>()
  /** join 도구를 쓴 때 — 그 뒤 들어온 방은 이 세션이 받는다 */
  joinedAt = 0
  /** 보관된 내 메시지 수 · 다른 세션이 받는 방 — 하트비트의 diag.get */
  queued = 0
  heldElsewhere: string[] = []
  /** 퇴근 중 */
  off = false
  /** 사람이 「이 세션 동안」 남의 열린 대화 읽기를 허락했나(명세 §10.7 — history 가 묻는다) */
  openRead = false
  orgNotice: { text: string; endsAt: string } | null = null
  serviceNotices: EvData<'service.notice'>['notices'] = []
  private sentName?: string
  private ready!: () => void
  private readonly mcpReady = new Promise<void>((r) => (this.ready = r))

  constructor(
    readonly host: Host,
    readonly link: Link,
    readonly paths: Paths,
    readonly log: (msg: string) => void,
  ) {
    this.dir = new Directory(() => link.client)
    link.onClient((c) => this.wire(c))
    link.onSession = (s) => this.sessionOpened(s)
    link.onStopped = (state, error) => void this.stopped(state, error?.params ?? {})
    link.onLogin = (r) => void this.loggedIn(r)
  }

  /** MCP 가 붙은 뒤 — 그 전에 온 알림은 기다렸다가 넣는다 */
  mcpConnected(): void {
    this.ready()
  }

  get me(): string {
    return this.link.welcome?.me.member ?? ''
  }

  get autoReply(): boolean {
    return this.link.config().autoReply ?? true
  }

  /** 세션에 넣는다 — MCP 가 붙을 때까지 기다린다 · 실패하면 던진다(ack 하지 않게) */
  async notify(content: string, meta: Record<string, string>): Promise<void> {
    await this.mcpReady
    await this.host.notify(content, meta)
  }

  /**
   * 플러그인이 만든 알림 — `author="plugin"` 을 붙인다(from 없음). 팀원 메시지 본문에 같은 글(「[이미 답함]」 등)을 넣어도
   * 꼬리표로 가려지게(안내문이 「from 이 없고 author 가 plugin · system 인 것만」 이라고 적는다).
   * seq 가 붙은 서버 알림을 처리하다 부를 때는 실패를 던져 ack 하지 않게 한다(서버가 다시 보냄)
   */
  private say(content: string, meta: Record<string, string> = { kind: 'system' }): Promise<void> {
    return this.notify(content, { ...meta, author: 'plugin' })
  }

  /** 알리기만 — 실패해도 넘어간다(다시 받을 수 없는 알림 — 로그인 결과 · 연결 끝 · 세션 열림) */
  private tell(content: string, meta: Record<string, string> = { kind: 'system' }): Promise<void> {
    return this.say(content, meta).catch((e: unknown) =>
      this.log(`알림 실패: ${(e as Error).message}`),
    )
  }

  private roomLabel(id: string | null | undefined): string {
    if (!id) return ''
    return this.dir.roomName(id) ?? id
  }

  private holds(room: string | null | undefined): boolean {
    return !!room && !!this.link.session?.held.includes(room)
  }

  // ── 서버 알림 ────────────────────────────────────────────────────

  private wire(client: MeshworkClient): void {
    // 다시 시작해 버린 옛 클라이언트의 알림은 무시한다(알림이 두 번 · 옛 세션에 hold 하지 않게)
    const live = () => this.link.client === client
    client.on('open', (w) => {
      if (!live()) return
      this.lang = pickLang(w.me.lang ?? 'ko')
      this.off = w.me.presence === 'off'
      this.serviceNotices = w.notices
      this.dir.me = w.me.member
      this.dir.remember(w.me.member, w.me.name)
      this.dir.setRooms(w.rooms.map(toRef))
      this.exportState()
    })
    client.on('reconnecting', () => this.exportState())
    client.on('message.new', (m, frame) => (live() ? this.onMessage(m, frame.sid) : undefined))
    client.on('thread.state', (d) => (live() ? this.onThreadState(d) : undefined))
    client.on('thread.assigned', (d) => (live() ? this.onAssigned(d) : undefined))
    client.on('agree.resolved', (d) => (live() ? this.onAgreeResolved(d) : undefined))
    client.on('session.room_lost', (d, frame) =>
      live() ? this.onRoomLost(d, frame.sid) : undefined,
    )
    client.on('me.rooms_changed', (d) => (live() ? this.onRoomsChanged(d) : undefined))
    client.on('room.changed', ({ room }) => {
      if (!live()) return
      this.dir.invalidate(room)
      void client.call('room.list', {}).then(
        (r) => {
          this.dir.setRooms(r.rooms.map(toRef))
          this.link.save({ rooms: roomsConfig(r.rooms) }, { roomsFromServer: true })
        },
        () => undefined,
      )
    })
    client.on('presence.changed', (d) => {
      if (!live()) return
      if (d.member === this.me) this.off = d.presence === 'off'
    })
    client.on('me.changed', (d) => {
      if (!live()) return
      this.lang = pickLang(d.lang ?? 'ko')
      if (d.lang) this.link.save({ lang: d.lang })
    })
    client.on('org.notice', ({ notice }) => {
      if (!live()) return
      this.orgNotice = { text: notice.text, endsAt: notice.endsAt }
      this.exportState()
    })
    client.on('service.notice', ({ notices }) => {
      if (!live()) return
      this.serviceNotices = notices
      this.exportState()
    })
    client.on('sessionLost', ({ sid }) => {
      if (!live()) return
      // 서버가 이 세션을 모름(5분 넘게 끊김) — 받던 방으로 새로 연다(가져오지는 않음)
      if (this.link.session?.sid !== sid) return
      const held = this.link.session.held
      this.link.session = undefined
      void this.link.openSession(held)
    })
    client.on('error', ({ error }) =>
      this.log(`연결 오류: ${(error as Error)?.message ?? String(error)}`),
    )
  }

  private async onMessage(m: Message, sid: string | undefined): Promise<void> {
    // 내가 다른 곳(앱 · 다른 터미널)에서 보낸 것 — 이 세션에 넣지 않는다
    if (m.from?.member && m.from.member === this.me) return
    // 표시용 사본은 사람 기기 몫
    if (m.copy) return
    // 세션 없이 온 것(본인 · 방 대상 알림)은 이 세션이 받는 방 것이거나 본인에게 온 것만
    if (!sid && !(m.room === null || this.holds(m.room))) return
    if (sid && this.link.session && sid !== this.link.session.sid) return
    if (m.room && m.to?.kind === 'role') await this.dir.roleNames(m.room)
    const tagged = tagMessage(m, {
      lang: this.lang,
      roomName: (id) => this.dir.roomName(id),
      name: this.dir.name,
    })
    const needsAnswer = m.kind === 'question' || (m.kind === 'reply' && m.expect === 'reply')
    if (needsAnswer && !this.autoReply) tagged.meta.autoreply = 'off'
    if (m.thread && m.from && (needsAnswer || m.kind === 'agree')) {
      this.received.set(m.thread, {
        from: m.from.name,
        ...(m.room ? { room: m.room } : {}),
        ...(m.open ? { open: true } : {}),
      })
      this.answeredElsewhere.delete(m.thread)
      this.repliedHere.delete(m.thread)
    }
    if (m.from) this.dir.remember(m.from.member, m.from.name)
    // 넣지 못하면 던진다 — client-core 가 ack 하지 않고 다시 받는다
    await this.notify(tagged.content, tagged.meta)
  }

  private async onThreadState(d: EvData<'thread.state'>): Promise<void> {
    const mine = this.asked.get(d.thread)
    const fromThisSession = !!d.fromSid && d.fromSid === this.link.session?.sid
    if (d.state === 'answered') {
      // 받은 질문이 다른 곳에서 답해짐 — 이 세션은 답하지 않는다(가로채기 — 명세 §8.1)
      const got = this.received.get(d.thread)
      if (got && !this.repliedHere.has(d.thread) && !this.answeredElsewhere.has(d.thread)) {
        this.answeredElsewhere.add(d.thread)
        const where =
          !d.by || d.by === this.me
            ? '내 다른 기기(앱 등)'
            : `'${this.dir.name(d.by) ?? '다른 사람'}'`
        await this.say(
          `[이미 답함] '${got.from}'님의 질문은 ${where}에서 이미 답했습니다 — 이 질문에는 답하지 마세요.`,
          {
            kind: 'answered',
            thread: d.thread,
            ...(got.room ? { room: this.roomLabel(got.room) } : {}),
          },
        )
      }
      return
    }
    // 무응답 · 만료는 이 세션이 물은 것만(다른 세션 · 앱이 물은 것은 그쪽이 알린다)
    if (!fromThisSession && !mine) return
    // 다른 세션(다른 터미널 · 앱)이 물은 것은 그쪽이 알린다 — 이 세션이 물었으면 sid 가 바뀌었어도(세션을 새로 열었음) 알린다
    if (d.fromSid && !fromThisSession && !mine) return
    const to = mine?.to ?? (d.assigned ? this.dir.name(d.assigned) : undefined) ?? '상대'
    const room = mine?.room ?? ''
    if (d.state === 'noack') {
      await this.say(
        `[무응답] '${to}'님이 아직 답하지 않았습니다 — 세션이 바쁘거나 자리를 비웠을 수 있습니다. 기다릴지, 다른 사람에게 물을지 사용자에게 알려 판단을 받으세요. 스스로 다시 보내지 마세요.`,
        { kind: 'noack', thread: d.thread, ...(room ? { room: this.roomLabel(room) } : {}) },
      )
    } else if (d.state === 'expired') {
      const why =
        d.reason === 'recipient_removed'
          ? `'${to}'님이 방에서 빠져`
          : '보관 기한 안에 받을 곳이 없어'
      await this.say(
        `[보관 만료] ${why} '${to}'님에게 보낸 질문이 폐기되었습니다${mine?.preview ? `: ${mine.preview}` : ''} — 사용자에게 알리세요.`,
        { kind: 'expired', thread: d.thread, ...(room ? { room: this.roomLabel(room) } : {}) },
      )
    }
  }

  private async onAssigned(d: EvData<'thread.assigned'>): Promise<void> {
    const mine = this.asked.get(d.thread)
    if (!mine || d.assigned === this.me) return
    let name = this.dir.name(d.assigned)
    if (!name && mine.room)
      name = (await this.dir.detail(mine.room).catch(() => null))?.members.find(
        (x) => x.member === d.assigned,
      )?.name
    await this.say(
      `[담당 변경] '${mine.to}'에게 보낸 질문을 '${name ?? d.assigned}'님이 받았습니다.`,
      { kind: 'assigned', thread: d.thread, room: this.roomLabel(mine.room) },
    )
  }

  private async onAgreeResolved(d: EvData<'agree.resolved'>): Promise<void> {
    const mine = this.proposed.get(d.agree)
    if (!mine || d.by === this.me) return
    this.proposed.delete(d.agree)
    const text =
      d.state === 'confirmed'
        ? `[합의 확정] '${mine.to}'님이 합의를 확정했습니다 — 방 전원이 봅니다: ${mine.summary}`
        : d.state === 'rejected'
          ? `[합의 거절] '${mine.to}'님이 합의 제안을 거절했습니다${d.reason ? ` — ${d.reason}` : ''}: ${mine.summary}`
          : `[합의 만료] '${mine.to}'님이 기한 안에 확인하지 않아 합의 제안이 만료되었습니다: ${mine.summary}`
    await this.say(text, { kind: 'agree_result', agree: d.agree })
  }

  private async onRoomLost(d: EvData<'session.room_lost'>, sid: string | undefined): Promise<void> {
    if (!this.link.session || (sid && sid !== this.link.session.sid)) return
    this.link.remember(this.link.session.held)
    const name = this.roomLabel(d.room)
    const text = {
      taken: `[받는 방 이전] '${name}' 방을 다른 세션이 가져갔습니다 — 이 세션은 그 방 메시지를 더 이상 받지 않습니다. 이 세션에서 다시 받으려면 /meshwork:room (그 세션은 받지 못하게 됩니다).`,
      removed: `[방에서 빠짐] '${name}' 방에서 빠졌습니다 — 이 세션은 그 방 메시지를 더 이상 받지 않습니다.`,
      deleted: `[방 삭제] '${name}' 방이 삭제되었습니다.`,
      archived: `[방 보관] '${name}' 방이 보관되었습니다 — 기록은 볼 수 있지만 새 메시지는 보낼 수 없습니다.`,
    }[d.reason]
    this.exportState()
    await this.say(text, { kind: 'system', room: name })
  }

  private async onRoomsChanged(d: EvData<'me.rooms_changed'>): Promise<void> {
    const held = new Set(this.link.session?.held ?? [])
    this.dir.addRooms(d.added.map(toRef))
    this.dir.removeRooms(d.removed)
    const cfg = this.link.config()
    const rooms = { ...(cfg.rooms ?? {}) }
    for (const r of d.added) rooms[r.id] = { name: r.name, myName: r.myName }
    for (const id of d.removed) delete rooms[id]
    this.link.save({ rooms }, { roomsFromServer: true })
    for (const r of d.added) {
      // join 도구를 쓴 세션 · 아무 방도 받지 않는 세션이 그 방을 받는다(다른 세션 것을 가져오지는 않음)
      const take = Date.now() - this.joinedAt < JOIN_WINDOW_MS || held.size === 0
      let got = false
      if (take && this.link.session) {
        const h = await this.link.session.hold([r.id]).catch(() => null)
        got = !!h?.held.includes(r.id)
        if (got) this.link.remember(this.link.session.held)
      }
      await this.say(
        got
          ? `[방 참가] '${r.name}' 방에 '${r.myName}' 으로 참가했습니다 — 이 세션이 그 방 메시지를 받습니다.`
          : `[방 참가] '${r.name}' 방에 '${r.myName}' 으로 참가했습니다 — 이 세션에서 받으려면 /meshwork:room ${r.name}`,
        { kind: 'system', room: r.name },
      )
    }
    for (const id of d.removed) {
      if (held.has(id)) continue // 받던 방은 session.room_lost 가 알린다
      await this.say(`[방에서 빠짐] '${cfg.rooms?.[id]?.name ?? id}' 방에서 빠졌습니다.`)
    }
    this.exportState()
  }

  /** 세션이 열림 — 받지 못한 방(다른 세션이 받는 중)을 알린다 */
  private sessionOpened(s: Session): void {
    this.exportState()
    if (!s.lost.length) return
    const names = s.lost.map((r) => `'${this.roomLabel(r)}'`).join(', ')
    void this.tell(
      `[받지 못한 방] ${names} — 다른 세션이 이미 받는 중이라 이 세션은 받지 않습니다(켜는 것만으로는 가져오지 않습니다). 이 세션에서 받으려면 /meshwork:room (그 세션은 받지 못하게 됩니다).`,
    )
  }

  private async stopped(state: LinkState, params: Record<string, unknown>): Promise<void> {
    this.exportState()
    const opts = { lang: this.lang, name: this.dir.name }
    const text =
      state.kind === 'stopped' ? stoppedText(state, opts, params) : notReadyText(state, opts)
    await this.tell(`[Meshwork 연결 끝] ${text}`)
  }

  private async loggedIn(
    r: { ok: true; orgs: MyOrg[]; org: MyOrg | null } | { ok: false; error: unknown },
  ): Promise<void> {
    this.exportState()
    if (!r.ok) {
      await this.tell(`[로그인 실패] ${errorText(r.error, { lang: this.lang })}`)
      return
    }
    if (r.org) {
      await this.tell(
        `[로그인 완료] '${r.org.name}' 조직에 붙습니다 — /meshwork:status 로 받는 방을 확인하세요.`,
      )
      return
    }
    const pending = r.orgs.filter((o) => o.membership === 'pending')
    await this.tell(
      r.orgs.some((o) => o.membership === 'active')
        ? '[로그인 완료] 붙을 조직을 골라야 합니다 — /meshwork:login org'
        : pending.length
          ? `[로그인 완료] ${pending.map((o) => `'${o.name}'`).join(', ')} 조직이 나를 추가했지만 아직 수락하지 않았습니다 — 브라우저에서 수락한 뒤 /meshwork:login org`
          : '[로그인 완료] 아직 속한 조직이 없습니다 — 조직 관리자에게 초대(미리 등록)를 요청하세요.',
    )
  }

  // ── 상태줄 · 하트비트 ───────────────────────────────────────────

  linkKind(): SessionState['link'] {
    const s = this.link.state
    if (s.kind === 'no_server' || s.kind === 'logged_out') return 'login'
    if (s.kind === 'no_org') return 'org'
    if (s.kind === 'reconnecting') return 'offline'
    return s.kind
  }

  /** 상태줄에 보일 공지 한 줄 — 장애 · 점검 > 조직 공지 > 안내 */
  noticeLine(now = Date.now()): string | null {
    const live = this.serviceNotices.filter(
      (n) => Date.parse(n.startsAt) <= now && (!n.endsAt || Date.parse(n.endsAt) > now),
    )
    const pick =
      live.find((n) => n.kind === 'incident') ?? live.find((n) => n.kind === 'maintenance')
    if (pick) return pick.text
    if (this.orgNotice && Date.parse(this.orgNotice.endsAt) > now) return this.orgNotice.text
    return live[0]?.text ?? null
  }

  exportState(): void {
    // 상태줄은 의존성 없이 sed 로 읽는다 — 글 칸에서 따옴표 · 역슬래시 · 쉼표 · 줄바꿈을 걷는다(잘못 잘리지 않게)
    const plain = (t: string) => t.replace(/["\\,\r\n]/g, ' ')
    const s = this.link.state
    const held = this.link.session?.held ?? []
    const joined = this.dir.rooms.map((r) => r.id)
    writeState(this.paths.home, {
      updatedAt: Date.now(),
      sessionId: this.host.sessionId,
      ppid: process.ppid,
      team: this.host.isTeam,
      link: this.linkKind(),
      stopped: s.kind === 'stopped' ? (s.code ?? s.reason) : null,
      held: held.map((r) => plain(this.dir.roomTitle(r) ?? r)),
      empty: joined
        .filter((r) => !held.includes(r) && !this.heldElsewhere.includes(r))
        .map((r) => plain(this.dir.roomTitle(r) ?? r)),
      queued: this.queued,
      off: this.off,
      contextChanged: this.link.contextChanged,
      notice: ((n) => (n ? plain(n) : null))(this.noticeLine()),
    })
  }

  /** 30초마다 — 보관 수 · 다른 세션이 받는 방 · 세션 이름 */
  async heartbeat(): Promise<void> {
    const client = this.link.client
    if (client && this.link.state.kind === 'open') {
      try {
        const d = await client.call('diag.get', {})
        this.queued = d.queued.count
        const mine = new Set(this.link.session?.held ?? [])
        this.heldElsewhere = [
          ...new Set(
            d.heldElsewhere
              .map((x) => x.room)
              .concat(d.sessions.flatMap((x) => (x.sid === this.link.session?.sid ? [] : x.rooms))),
          ),
        ].filter((r) => !mine.has(r))
      } catch {
        /* 다음 박동에 */
      }
      const name = this.host.sessionName()
      if (name && name !== this.sentName && this.link.session) {
        this.sentName = name
        void this.link.session.update({ name }).catch(() => (this.sentName = undefined))
      }
    }
    this.exportState()
  }

  startHeartbeat(): () => void {
    sweepStaleStates(this.paths.home)
    this.exportState()
    const t = setInterval(() => void this.heartbeat(), HEARTBEAT_MS)
    t.unref?.()
    return () => clearInterval(t)
  }
}

function toRef(r: {
  id: string
  name: string
  myName: string
  role: 'owner' | 'member'
  archived: boolean
  open?: boolean | undefined
}): RoomRef {
  return {
    id: r.id,
    name: r.name,
    myName: r.myName,
    role: r.role,
    archived: r.archived,
    open: r.open === true,
  }
}

function roomsConfig(
  rooms: { id: string; name: string; myName: string }[],
): Record<string, { name: string; myName: string }> {
  return Object.fromEntries(rooms.map((r) => [r.id, { name: r.name, myName: r.myName }]))
}
