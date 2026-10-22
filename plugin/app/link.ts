/**
 * 서버와의 연결 — 로그인(기기 코드) · 조직 고르기 · 연결(client-core) · 세션 · 규약 · 방 메모리 받기 · 로그아웃.
 *
 * - 토큰은 `tokens.json`(0600 — 3단계 ⑦) · 한 기기의 여러 터미널은 파일 잠금으로 하나씩 갱신(client-core)
 * - 로그인은 **사람이 명령할 때만**(3단계 ⑧) — 켤 때는 상태만 알리고 브라우저를 열지 않는다
 * - 프로세스 하나 = 연결 하나 + 세션 하나(명세 §5.1). 다시 붙으면 client-core 가 같은 sid 로 이어받는다
 * - 다른 터미널이 로그인 · 로그아웃해도 토큰 파일이 같다 — 로그인 전 상태면 도구를 쓸 때마다 파일을 다시 본다
 */
import { hostname, release, type } from 'node:os'

import {
  type CloseReason,
  type Context,
  createClient,
  deviceCodeLogin,
  loadContext,
  LoginStoppedError,
  logout,
  type MeshworkClient,
  MeshworkError,
  type OpenSocket,
  type Session,
  TokenManager,
} from '@meshwork-ai/client-core'
import { fileCache, fileLock, fileTokenStore, nodeSocket } from '@meshwork-ai/client-core/node'
import type { OpResult } from '@meshwork-ai/protocol'
import { clientHeader, HEADERS, myOrg } from '@meshwork-ai/protocol/http'

import {
  type Config,
  loadConfig,
  normalizeServer,
  rememberedRooms,
  saveConfig,
} from '../core/config'
import type { Paths } from '../core/paths'
import { CLIENT_ID, CLIENT_NAME, PLUGIN_VERSION } from '../core/version'
import type { Host } from '../host/types'

export type Welcome = OpResult<'hello'>
export type MyOrg = ReturnType<typeof myOrg.parse>

/** 지금 어디까지 — 상태줄 · doctor · 도구가 본다 */
export type LinkState =
  /** 서버 주소도 모름(처음) */
  | { kind: 'no_server' }
  /** 로그인 필요(처음 · 만료 · 로그아웃 · 기기 폐기) — reason 은 알린 사유 */
  | { kind: 'logged_out'; reason?: string }
  /** 조직을 골라야 함 */
  | { kind: 'no_org'; orgs: MyOrg[] }
  | { kind: 'connecting' }
  | { kind: 'open' }
  | { kind: 'reconnecting' }
  /** 다시 붙지 않음 — 낡은 버전 · 조직에서 빠짐 · 받아 주지 않음 */
  | { kind: 'stopped'; reason: CloseReason; code?: string }

export interface LoginTicket {
  server: string
  userCode: string
  verificationUri: string
  verificationUriComplete: string
  expiresIn: number
}

export interface LinkDeps {
  host: Host
  paths: Paths
  /** 시험용 — 소켓 · HTTP 바꿔 끼우기 */
  openSocket?: OpenSocket
  fetch?: typeof fetch
  log(msg: string): void
}

/** 연결이 바뀔 때마다(로그인 · 조직 바꾸기 · 다시 시작) 새 클라이언트에 알림 처리를 단다 */
export type Wire = (client: MeshworkClient) => void

const CLIENT = { name: CLIENT_NAME, version: PLUGIN_VERSION }

/** 기기가 밝히는 이름 · OS — 승인 화면에 보인다(64자까지 — HTTP API §2.2) */
function deviceName(): string {
  return `${hostname()} · Claude Code`.slice(0, 64)
}
function deviceOs(): string {
  const name =
    process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : type()
  return `${name} ${release()}`.slice(0, 64)
}

export class Link {
  state: LinkState = { kind: 'no_server' }
  client?: MeshworkClient
  session?: Session
  welcome?: Welcome
  /** 이 세션을 켤 때 넣은 규약 · 방 메모리 */
  context?: Context
  /** 켠 뒤 규약 · 방 메모리가 바뀜 — 새 세션부터(명세 §12) */
  contextChanged = false
  /** 진행 중인 로그인 */
  private pendingLogin?: { ticket: Promise<LoginTicket>; abort: AbortController; server: string }
  private tokens?: TokenManager
  private watch?: AbortController
  private opening?: Promise<Session | null>
  private wire?: Wire
  private readonly store
  private readonly lock

  constructor(private readonly deps: LinkDeps) {
    this.store = fileTokenStore(deps.paths.tokens)
    this.lock = fileLock(deps.paths.lock)
  }

  config(): Config {
    return loadConfig(this.deps.paths.config) ?? {}
  }

  save(patch: Config, opts: { roomsFromServer?: boolean } = {}): Config {
    return saveConfig(this.deps.paths.config, patch, {
      ...opts,
      sessionId: this.deps.host.sessionId,
    })
  }

  onClient(wire: Wire): void {
    this.wire = wire
  }

  /**
   * 켤 때 — 로그인돼 있으면 붙기 시작하고, 규약 · 방 메모리를 최대 waitMs 기다린다(못 받으면 사본 — 명세 §12).
   * 돌려준 것이 이 세션의 MCP 안내문에 들어간다. 로그인 전이면 null
   */
  async boot(waitMs = 1_500): Promise<Context | null> {
    if (!(await this.prepare())) return null
    const client = this.start()
    const rooms = rememberedRooms(this.config(), this.deps.host.sessionId)
    this.watch = new AbortController()
    try {
      this.context = await loadContext(client, {
        rooms,
        cache: fileCache(this.deps.paths.cache),
        waitMs,
        signal: this.watch.signal,
        onUpdate: () => (this.contextChanged = true),
      })
    } catch {
      this.context = undefined
    }
    return this.context ?? null
  }

  /** 로그인 · 조직이 갖춰졌나 — 갖춰지지 않았으면 상태를 그에 맞게 */
  private async prepare(): Promise<boolean> {
    const cfg = this.config()
    if (!cfg.server) {
      this.state = { kind: 'no_server' }
      return false
    }
    if (!(await this.store.load())) {
      if (this.state.kind !== 'logged_out') this.state = { kind: 'logged_out' }
      return false
    }
    if (!cfg.org) {
      const orgs = await this.listOrgs().catch(() => null)
      const picked = orgs ? await this.pickOrg(orgs, cfg.org) : null
      if (!picked) {
        this.state = { kind: 'no_org', orgs: orgs ?? [] }
        return false
      }
    }
    return true
  }

  private tokenManager(server: string): TokenManager {
    return new TokenManager({
      server,
      client: CLIENT,
      clientId: CLIENT_ID,
      store: this.store,
      lock: this.lock,
      ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
    })
  }

  /** 새 클라이언트로 붙는다 — 첫 welcome 뒤 세션을 연다 */
  private start(): MeshworkClient {
    const cfg = this.config()
    this.tokens = this.tokenManager(cfg.server!)
    const client = createClient({
      server: cfg.server!,
      org: cfg.org!,
      client: CLIENT,
      tokens: this.tokens,
      openSocket: this.deps.openSocket ?? nodeSocket,
      ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
    })
    this.client = client
    this.session = undefined
    this.welcome = undefined
    this.state = { kind: 'connecting' }
    client.on('open', (w) => {
      if (this.client !== client) return
      this.welcome = w
      this.state = { kind: 'open' }
      this.save(
        {
          orgName: w.org.name,
          rooms: Object.fromEntries(w.rooms.map((r) => [r.id, { name: r.name, myName: r.myName }])),
        },
        { roomsFromServer: true },
      )
      if (!this.session) void this.openSession()
    })
    client.on('reconnecting', () => {
      if (this.client === client && this.state.kind === 'open')
        this.state = { kind: 'reconnecting' }
    })
    client.on('closed', ({ reason, error }) => {
      if (this.client !== client) return
      this.closed(reason, error)
    })
    this.wire?.(client)
    client.connect().catch(() => undefined) // 실패는 closed · reconnecting 으로 알려진다
    return client
  }

  /** 세션을 연다 — 이 Claude 세션이 기억한 방(없으면 참가한 방이 하나일 때 그 방) */
  openSession(rooms?: string[]): Promise<Session | null> {
    if (this.opening) return this.opening
    const client = this.client
    if (!client) return Promise.resolve(null)
    const want = rooms ?? rememberedRooms(this.config(), this.deps.host.sessionId)
    const name = this.deps.host.sessionName()
    this.opening = client
      .openSession({
        ...(want.length ? { rooms: want } : {}),
        dir: this.deps.host.workDir,
        engine: 'claude',
        ...(name ? { name } : {}),
      })
      .then(
        (s) => {
          if (this.client !== client) return null
          this.session = s
          if (s.held.length) this.remember(s.held)
          this.onSession?.(s)
          return s
        },
        (e: unknown) => {
          this.deps.log(`세션을 열지 못함: ${(e as Error).message}`)
          return null
        },
      )
      .finally(() => (this.opening = undefined))
    return this.opening
  }

  /** 세션이 열렸을 때 — 받지 못한 방 알리기 등(app 이 단다) */
  onSession?: (s: Session) => void

  /** 이 Claude 세션이 받는 방을 기억한다(`--resume` 하면 되찾음) */
  remember(held: string[]): void {
    const sid = this.deps.host.sessionId
    if (!sid) return
    this.save({ sessions: { [sid]: held } })
  }

  /** 붙어 있고 세션이 열렸나 — 아니면 timeoutMs 까지 기다린다 */
  async ready(timeoutMs = 5_000): Promise<boolean> {
    if (
      this.state.kind === 'logged_out' ||
      this.state.kind === 'no_server' ||
      this.state.kind === 'no_org'
    ) {
      // 다른 터미널이 그사이 로그인했을 수 있다
      if (await this.prepare()) this.restart()
      else return false
    }
    const until = Date.now() + timeoutMs
    while (Date.now() < until) {
      if (this.state.kind === 'stopped' || this.state.kind === 'logged_out') return false
      if (this.state.kind === 'open' && this.session && !this.session.closed) return true
      if (this.state.kind === 'open' && !this.session && !this.opening) void this.openSession()
      await new Promise((r) => setTimeout(r, 50))
    }
    return this.state.kind === 'open' && !!this.session && !this.session.closed
  }

  /** 닫고 처음부터 — 로그인 · 조직 바꾸기 뒤 */
  restart(): void {
    this.stopClient()
    void this.prepare().then((ok) => ok && this.start())
  }

  private stopClient(): void {
    this.watch?.abort()
    this.watch = undefined
    const c = this.client
    this.client = undefined
    this.session = undefined
    c?.close()
  }

  /** client-core 가 다시 붙지 않고 끝냄 */
  private closed(reason: CloseReason, error?: MeshworkError): void {
    if (reason === 'closed') return
    const code = error?.code
    if (
      reason === 'revoked' ||
      reason === 'login' ||
      code === 'auth.reauth_required' ||
      code === 'org.login_method_not_allowed'
    ) {
      // 토큰이 죽었거나 그 조직에 붙으려면 다시 로그인해야 함. 죽은 토큰은 지우되 **이 연결의 기기 것일 때만** —
      // 다른 터미널이 그사이 새로 로그인해 저장한 토큰을 지우지 않게
      if (reason === 'revoked' || reason === 'login') void this.forget(this.welcome?.me.device)
      this.state = {
        kind: 'logged_out',
        reason:
          code ?? (reason === 'revoked' ? String(error?.params.reason ?? 'revoked') : 'login'),
      }
    } else if (reason === 'rejected' && (code === 'org.not_member' || code === 'org.unknown')) {
      this.save({ org: undefined })
      this.state = { kind: 'no_org', orgs: [] }
    } else {
      this.state = { kind: 'stopped', reason, ...(code ? { code } : {}) }
    }
    this.onStopped?.(this.state, error)
  }

  /** 죽은 토큰 지우기 — 보관함의 토큰이 그 기기의 것일 때만 */
  private async forget(device: string | undefined): Promise<void> {
    await this.lock
      .run(async () => {
        const t = await this.store.load()
        if (t && (!device || t.device === device)) await this.store.clear()
      })
      .catch(() => undefined)
  }

  /** 다시 붙지 않게 됐을 때 — 사람에게 알리기(app 이 단다) */
  onStopped?: (state: LinkState, error?: MeshworkError) => void

  // ── 로그인 ──────────────────────────────────────────────────────

  /**
   * 기기 코드 로그인을 시작한다 — 코드가 나오면 돌려주고, 승인은 뒤에서 기다린다(최대 10분).
   * 끝나면 onLogin 으로 알린다. 서버가 바뀌면 옛 서버의 토큰을 폐기한다
   */
  async beginLogin(serverInput?: string): Promise<LoginTicket> {
    const cfg = this.config()
    const server = serverInput ? normalizeServer(serverInput) : cfg.server
    if (!server) throw new Error('서버 주소가 필요합니다 — /meshwork:login <서버 주소>')
    if (this.pendingLogin && this.pendingLogin.server === server) return this.pendingLogin.ticket
    this.pendingLogin?.abort.abort()
    const abort = new AbortController()
    let showCode!: (t: LoginTicket) => void
    let failStart!: (e: unknown) => void
    const ticket = new Promise<LoginTicket>((res, rej) => {
      showCode = res
      failStart = rej
    })
    this.pendingLogin = { ticket, abort, server }
    const base = { server, client: CLIENT, ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}) }
    void deviceCodeLogin({
      ...base,
      clientId: CLIENT_ID,
      deviceName: deviceName(),
      deviceOs: deviceOs(),
      signal: abort.signal,
      onCode: (c) => showCode({ server, ...c }),
    }).then(
      async (result) => {
        if (this.pendingLogin?.abort !== abort) return
        this.pendingLogin = undefined
        // 서버가 바뀌었으면 옛 서버의 토큰은 폐기한다(그 서버의 기기 목록에 남지 않게)
        if (cfg.server && cfg.server !== server) {
          this.stopClient()
          await logout({
            server: cfg.server,
            client: CLIENT,
            clientId: CLIENT_ID,
            store: this.store,
            lock: this.lock,
          }).catch(() => undefined)
        }
        await this.lock.run(() => this.store.save(result.tokens))
        this.save({ server })
        const org = await this.pickOrg(result.orgs, cfg.server === server ? cfg.org : undefined)
        this.stopClient()
        if (org) {
          this.state = { kind: 'connecting' }
          this.start()
        } else this.state = { kind: 'no_org', orgs: result.orgs }
        this.onLogin?.({ ok: true, orgs: result.orgs, org })
      },
      (e: unknown) => {
        failStart(e)
        if (this.pendingLogin?.abort !== abort) return
        this.pendingLogin = undefined
        this.onLogin?.({ ok: false, error: e })
      },
    )
    return ticket
  }

  /** 로그인이 끝났을 때(app 이 단다) */
  onLogin?: (
    r: { ok: true; orgs: MyOrg[]; org: MyOrg | null } | { ok: false; error: unknown },
  ) => void

  cancelLogin(): boolean {
    if (!this.pendingLogin) return false
    this.pendingLogin.abort.abort()
    this.pendingLogin = undefined
    return true
  }

  get loggingIn(): boolean {
    return !!this.pendingLogin
  }

  /**
   * 조직 고르기 — 참여 중(active)인 조직이 하나면 그것, 여럿이면 지금 것이 있으면 그것 · 없으면 사람에게 묻는다.
   * 고르면 저장한다. 못 고르면 null
   */
  async pickOrg(orgs: MyOrg[], current?: string, ask = false): Promise<MyOrg | null> {
    const active = orgs.filter((o) => o.membership === 'active')
    if (!active.length) return null
    let picked = !ask ? active.find((o) => o.id === current) : undefined
    if (!picked && active.length === 1 && !ask) picked = active[0]
    if (!picked) {
      const v = await this.deps.host.choose({
        message: '이 기기가 붙을 조직을 고르세요',
        title: '조직',
        options: active.map((o) => ({
          value: o.id,
          label: `${o.name}${o.role === 'admin' ? ' (관리자)' : ''}${o.status === 'suspended' ? ' — 사용 정지' : ''}${o.reauthRequired ? ' — 다시 로그인 필요' : ''}`,
        })),
      })
      picked = active.find((o) => o.id === v)
    }
    if (!picked) return null
    this.save({ org: picked.id, orgName: picked.name })
    return picked
  }

  /** 내가 속한 조직 — `GET /api/me/orgs`(HTTP API §2.5) */
  async listOrgs(): Promise<MyOrg[]> {
    const server = this.config().server
    if (!server) throw new Error('서버 주소를 모릅니다')
    const token = await (this.tokens ?? this.tokenManager(server)).current()
    const res = await (this.deps.fetch ?? fetch)(new URL('/api/me/orgs', server), {
      headers: {
        Authorization: `Bearer ${token}`,
        [HEADERS.client]: clientHeader(CLIENT.name, CLIENT.version),
      },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) throw new Error(`조직 목록을 받지 못했습니다 (HTTP ${res.status})`)
    const body = (await res.json()) as { items?: unknown }
    const parsed = myOrg.array().safeParse(body.items)
    if (!parsed.success) throw new Error('조직 목록 모양이 틀렸습니다')
    return parsed.data
  }

  /** 조직을 바꾼다 — 연결을 새로 */
  async switchOrg(): Promise<{ org: MyOrg | null; orgs: MyOrg[] }> {
    const orgs = await this.listOrgs()
    const org = await this.pickOrg(
      orgs,
      this.config().org,
      orgs.filter((o) => o.membership === 'active').length > 1,
    )
    if (org) this.restart()
    return { org, orgs }
  }

  /** 이 기기 로그아웃 — 서버에서 폐기하고 토큰을 지운다(다른 터미널은 auth.revoked 로 따라 끝남) */
  async logout(): Promise<{ revoked: boolean; had: boolean }> {
    this.cancelLogin()
    const server = this.config().server
    const had = !!(await this.store.load())
    this.stopClient()
    this.state = { kind: 'logged_out', reason: 'device_logout' }
    if (!server || !had) {
      await this.store.clear().catch(() => undefined)
      return { revoked: false, had }
    }
    const r = await logout({
      server,
      client: CLIENT,
      clientId: CLIENT_ID,
      store: this.store,
      lock: this.lock,
      ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
    })
    return { ...r, had }
  }

  /** 그만 — 프로세스가 끝날 때 */
  close(): void {
    this.cancelLogin()
    this.stopClient()
  }
}

export { LoginStoppedError, MeshworkError }
