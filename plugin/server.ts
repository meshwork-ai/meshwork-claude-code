/**
 * Meshwork 플러그인 — Claude Code 세션과 Meshwork 서버 사이의 다리(Claude Code 가 stdio 하위 프로세스로 띄운다).
 *
 *  - 받기: 서버 알림(client-core) → `notifications/claude/channel` → `<channel …>` 꼬리표로 세션에(넘긴 뒤에 ack)
 *  - 보내기: 팀 도구(MCP) → 서버
 *  - 팀 규약 · 방 메모리 · 도구 안내는 MCP 안내문으로 시스템 프롬프트에(켤 때 한 번 — 명세 §12)
 *  - `meshwork-claude` 로 켠 세션만 서버에 붙는다(`MESHWORK_GATEWAY=1`) — 일반 세션은 안내 한 줄 · route · doctor 만
 *
 * 연결 계약: `docs/host-claude-code.md` · 파일 자리: core/paths.ts
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

import { buildInstructions } from './app/instructions'
import { Link } from './app/link'
import { Plugin } from './app/plugin'
import { notReadyText } from './app/text'
import { type Args, callTool, TOOLS } from './app/tools'
import { loadConfig, saveConfig } from './core/config'
import { paths, teamRelayConfig } from './core/paths'
import { mergeRoutes } from './core/routes'
import type { RouteEntry } from './core/types'
import { MIN_NODE, PLUGIN_VERSION } from './core/version'
import { createClaudeHost } from './host/claude'

const P = paths()
const log = (msg: string): void => void process.stderr.write(`meshwork: ${msg}\n`)

/** MCP 서버는 안내문(팀 규약)을 정한 뒤에 만든다 — 호스트는 그 전에 생겨서 이 자리로 나중에 받는다 */
const holder: { mcp?: Server } = {}
const host = createClaudeHost(() => holder.mcp, { home: P.home })
const link = new Link({ host, paths: P, log })
const plugin = new Plugin(host, link, P, log)

/** 처음 켤 때 한 번 — team-relay 의 질문 배분 규칙을 가져온다(명세 D.3 5 · PRD §8.4) */
function importRoutes(): void {
  const cfg = loadConfig(P.config) ?? {}
  if (cfg.routesImported) return
  let imported: RouteEntry[] = []
  try {
    const old = JSON.parse(readFileSync(teamRelayConfig(), 'utf8')) as { routes?: unknown }
    if (Array.isArray(old.routes)) {
      imported = old.routes.filter(
        (r): r is RouteEntry =>
          !!r &&
          typeof r === 'object' &&
          typeof (r as RouteEntry).session === 'string' &&
          (typeof (r as RouteEntry).keywords === 'string' ||
            typeof (r as RouteEntry).room === 'string'),
      )
    }
  } catch {
    /* team-relay 를 쓰지 않았음 — 가져올 것이 없다 */
  }
  try {
    saveConfig(P.config, { routes: mergeRoutes(cfg.routes ?? [], imported), routesImported: true })
    if (imported.length) log(`team-relay 질문 배분 ${imported.length}개를 가져옴`)
  } catch (e) {
    log(`질문 배분을 가져오지 못함: ${(e as Error).message}`)
  }
}

/**
 * 상태줄 스크립트를 버전 없는 고정 경로로 복사한다 — 설치본 경로에는 버전이 들어가 업데이트마다 설정을 고쳐야 하므로.
 * 사용자는 `~/.claude/channels/meshwork/statusline.sh` 를 한 번 등록한다
 */
function installStatusline(): void {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const src = join(/[\\/]dist$/.test(here) ? dirname(here) : here, 'statusline.sh')
    const body = readFileSync(src, 'utf8')
    let current: string | null = null
    try {
      current = readFileSync(P.statusline, 'utf8')
    } catch {
      /* 처음 */
    }
    if (current === body) return
    mkdirSync(P.home, { recursive: true, mode: 0o700 })
    const tmp = `${P.statusline}.${process.pid}.tmp`
    writeFileSync(tmp, body, { mode: 0o755 })
    renameSync(tmp, P.statusline)
    chmodSync(P.statusline, 0o755)
  } catch {
    /* 설치 실패가 팀 채널을 막아선 안 된다 — doctor 가 미설정으로 알린다 */
  }
}

// ── 켤 때 — 팀 세션이면 붙고 규약 · 방 메모리를 받는다(최대 1.5초 · 못 받으면 사본) ──
importRoutes()
const nodeOk = host.nodeMajor >= MIN_NODE
let context = null
if (host.isTeam && nodeOk) {
  installStatusline()
  context = await link
    .boot(Number(process.env.MESHWORK_CONTEXT_WAIT_MS ?? 1_500))
    .catch((e: unknown) => {
      log(`켤 때 연결 실패: ${(e as Error).message}`)
      return null
    })
}
const cfg0 = loadConfig(P.config) ?? {}
const instructions = buildInstructions({
  team: host.isTeam,
  context,
  roomName: (id) => cfg0.rooms?.[id]?.name ?? id,
  ...(host.isTeam && !nodeOk
    ? {
        notReady: `Node ${MIN_NODE} 이상이 필요합니다(지금 ${host.runtime}) — 설치한 뒤 새 세션을 여세요`,
      }
    : host.isTeam && !context
      ? { notReady: notReadyText(link.state, { lang: 'ko' }) }
      : {}),
})

// ── MCP 서버 ──
const mcp = new Server(
  { name: 'meshwork', version: PLUGIN_VERSION },
  {
    capabilities: {
      // 이 키가 채널 등록의 전부. claude/channel/permission 은 일부러 선언하지 않는다 — 선언하면 팀원이 이 세션의
      // 도구 실행을 원격으로 승인할 수 있게 된다(보안 경계 — 더하지 말 것 · 연결 계약 §3)
      experimental: { 'claude/channel': {} },
      tools: {},
    },
    instructions,
  },
)
holder.mcp = mcp
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))
mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const raw = (req.params.arguments ?? {}) as Record<string, unknown>
  const args: Args = Object.fromEntries(
    Object.entries(raw).map(([k, v]) => [k, v === undefined || v === null ? undefined : String(v)]),
  )
  return callTool(plugin, req.params.name, args)
})

const transport = new StdioServerTransport()
/** 부모 세션이 끝나면(stdin 닫힘) 바로 끝낸다 — 남는 프로세스가 방을 붙잡지 않게 */
const shutdown = (): void => {
  link.close()
  process.exit(0)
}
transport.onclose = shutdown
process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)

await mcp.connect(transport)
plugin.mcpConnected()

if (host.isTeam) {
  plugin.startHeartbeat()
  // 켠 그 순간 한 번 — 로그인이 필요하면 · 받는 방이 없으면(방이 여럿일 때) 알린다. 상태줄은 늘 보인다
  const nudge = setTimeout(
    () => {
      const st = link.state
      if (!nodeOk) {
        void plugin
          .notify(
            `[Meshwork] Node ${MIN_NODE} 이상이 필요합니다(지금 ${host.runtime}) — https://nodejs.org 에서 설치한 뒤 새 세션을 여세요.`,
            { kind: 'system' },
          )
          .catch(() => undefined)
      } else if (st.kind === 'no_server' || st.kind === 'logged_out' || st.kind === 'no_org') {
        void plugin
          .notify(`[Meshwork] ${notReadyText(st, { lang: plugin.lang })}`, { kind: 'system' })
          .catch(() => undefined)
      } else if (
        st.kind === 'open' &&
        link.session &&
        !link.session.held.length &&
        plugin.dir.rooms.length > 1
      ) {
        void plugin
          .notify(
            `[받는 방 없음] 이 세션은 받는 방이 없어 팀 메시지를 받지 않습니다 — /meshwork:room 으로 받을 방을 고르세요.`,
            { kind: 'system' },
          )
          .catch(() => undefined)
      }
    },
    Number(process.env.MESHWORK_NUDGE_DELAY_MS ?? 4_000),
  )
  nudge.unref?.()
}
