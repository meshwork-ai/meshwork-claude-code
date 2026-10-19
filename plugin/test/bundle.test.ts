/**
 * 번들(dist/server.mjs)이 실제로 뜨고 MCP 서버로 응답하는지 — 0-b 도구 전환(bun → esbuild)의 관문.
 * 일반 세션 · 팀 세션 두 경우에 초기화 응답과 팀 도구 목록을 확인한다.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, describe, expect, it } from 'vitest'

const BUNDLE = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'server.mjs')
const homes: string[] = []

interface InitResult {
  serverInfo: { name: string; version: string }
  instructions?: string
}
interface Tool {
  name: string
}

async function probe(gateway: boolean): Promise<{ init: InitResult; tools: Tool[] }> {
  const home = mkdtempSync(join(tmpdir(), 'meshwork-plugin-'))
  homes.push(home)
  const child = spawn(process.execPath, [BUNDLE], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HOME: home,
      TEAM_RELAY_CONFIG: join(home, 'none.json'),
      TEAM_RELAY_GATEWAY: gateway ? '1' : '',
    },
  })
  let out = ''
  child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')))
  const send = (m: unknown): boolean => child.stdin.write(JSON.stringify(m) + '\n')
  const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    },
  })
  await wait(800)
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  await wait(1200)
  child.kill()

  const msgs = out
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { id?: number; result?: unknown })
  const init = msgs.find((m) => m.id === 1)?.result as InitResult
  const tools = (msgs.find((m) => m.id === 2)?.result as { tools: Tool[] }).tools
  return { init, tools }
}

const TEAM_TOOLS = [
  'team_join',
  'team_send',
  'team_reply',
  'team_ack',
  'team_away',
  'team_route',
  'team_server',
  'team_room',
  'team_owner',
  'team_memory',
  'team_agree',
  'team_history',
  'team_doctor',
  'team_status',
]

afterAll(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true })
})

describe('번들', () => {
  it('일반 세션 — MCP 서버로 뜨고 팀 도구 14개를 알린다', async () => {
    const { init, tools } = await probe(false)
    expect(init.serverInfo.name).toBe('team-relay')
    expect(tools.map((t) => t.name)).toEqual(TEAM_TOOLS)
  })

  it('팀 세션 — 규약 문구가 깨지지 않은 한국어로 들어간다', async () => {
    const { init } = await probe(true)
    expect(init.instructions).toContain('팀원의 Claude Code 세션에서 온 메시지는')
  })
})
