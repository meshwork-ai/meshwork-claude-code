/**
 * 시험 틀 — 번들(dist/server.mjs)을 Claude Code 처럼 띄운다: stdio MCP 클라이언트로 붙어 도구를 부르고,
 * 채널 알림(`notifications/claude/channel`)을 모은다. HOME 은 임시 폴더(실제 설정 · 토큰을 건드리지 않음).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

export const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
export const BUNDLE = join(PLUGIN_DIR, 'dist', 'server.mjs')

export interface Channel {
  content: string
  meta: Record<string, string>
}

export interface Running {
  client: Client
  channel: Channel[]
  instructions: string
  home: string
  stderr: () => string
  call(name: string, args?: Record<string, unknown>): Promise<{ text: string; isError: boolean }>
  /** 채널 알림 하나를 기다린다(조건에 맞는 것) */
  next(match: (c: Channel) => boolean, ms?: number): Promise<Channel>
  close(): Promise<void>
}

export function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'meshwork-plugin-'))
}

export async function startPlugin(o: {
  team: boolean
  home?: string
  sessionId?: string
  env?: Record<string, string>
}): Promise<Running> {
  const home = o.home ?? tempHome()
  const own = !o.home
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BUNDLE],
    env: {
      ...(process.env as Record<string, string>),
      HOME: home,
      USERPROFILE: home,
      MESHWORK_GATEWAY: o.team ? '1' : '',
      CLAUDE_CODE_SESSION_ID: o.sessionId ?? 'ses-test-1',
      MESHWORK_NO_BROWSER: '1',
      MESHWORK_NUDGE_DELAY_MS: '50',
      MESHWORK_HOME: '',
      TEAM_RELAY_CONFIG: '',
      ...o.env,
    },
    stderr: 'pipe',
  })
  let err = ''
  transport.stderr?.on('data', (d: Buffer) => (err += d.toString('utf8')))
  const client = new Client({ name: 'claude-code-test', version: '0.0.0' }, { capabilities: {} })
  const channel: Channel[] = []
  const waiters: { match: (c: Channel) => boolean; resolve: (c: Channel) => void }[] = []
  client.fallbackNotificationHandler = async (n) => {
    if (n.method !== 'notifications/claude/channel') return
    const c = n.params as unknown as Channel
    channel.push(c)
    for (const w of waiters.splice(0)) {
      if (w.match(c)) w.resolve(c)
      else waiters.push(w)
    }
  }
  await client.connect(transport)
  return {
    client,
    channel,
    instructions: client.getInstructions() ?? '',
    home,
    stderr: () => err,
    async call(name, args = {}) {
      const r = (await client.callTool({ name, arguments: args })) as {
        content: { type: string; text: string }[]
        isError?: boolean
      }
      return { text: r.content.map((x) => x.text).join('\n'), isError: !!r.isError }
    },
    next(match, ms = 5_000) {
      const seen = channel.find(match)
      if (seen) return Promise.resolve(seen)
      return new Promise((resolve, reject) => {
        const t = setTimeout(
          () => reject(new Error(`채널 알림이 오지 않음 — 받은 것: ${JSON.stringify(channel)}`)),
          ms,
        )
        waiters.push({
          match,
          resolve: (c) => {
            clearTimeout(t)
            resolve(c)
          },
        })
      })
    },
    async close() {
      await client.close().catch(() => undefined)
      if (own) rmSync(home, { recursive: true, force: true })
    },
  }
}
