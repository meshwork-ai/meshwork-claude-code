/**
 * 번들(dist/server.mjs)을 Claude Code 처럼 띄워 본다 — MCP 서버로 뜨나 · 도구 14개 · 일반 세션 / 팀 세션 / 로그인 전.
 * 서버와 실제로 주고받는 시나리오(S2 · S6~S11 · S16)는 서버 저장소의 통합 시험이 진짜 서버에 붙여 본다.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { BUNDLE, type Running, startPlugin, tempHome } from './harness'

const TOOLS = [
  'send',
  'reply',
  'progress',
  'history',
  'memory',
  'agree',
  'status',
  'doctor',
  'away',
  'room',
  'route',
  'join',
  'owner',
  'login',
]

const running: Running[] = []
const start = async (o: Parameters<typeof startPlugin>[0]) => {
  const r = await startPlugin(o)
  running.push(r)
  return r
}
afterEach(async () => {
  for (const r of running.splice(0)) await r.close()
})

describe('번들 — 일반 세션', () => {
  it('MCP 서버 meshwork 로 뜨고 도구 14개(앞머리 없음 · 처음부터 불러 둠)를 알린다 · 안내문은 한 줄', async () => {
    const p = await start({ team: false })
    expect(p.client.getServerVersion()?.name).toBe('meshwork')
    const tools = (await p.client.listTools()).tools
    expect(tools.map((t) => t.name)).toEqual(TOOLS)
    expect(
      tools.every((t) => (t._meta as Record<string, unknown>)?.['anthropic/alwaysLoad'] === true),
    ).toBe(true)
    expect(p.instructions).toBe(
      'Meshwork: 이 세션은 팀 세션이 아니다 — 팀 기능(팀원에게 묻기 · 답장 등)은 meshwork-claude 로 켠 세션에서만 쓴다.',
    )
  })

  it('팀 도구는 안내만 하고 서버에 붙지 않는다 — route · doctor 는 이 기기 안에서 쓴다', async () => {
    const p = await start({ team: false })
    const sent = await p.call('send', { to: '민준', message: 'x' })
    expect(sent).toEqual({
      isError: true,
      text: expect.stringContaining('meshwork-claude 로 켠 세션'),
    })
    expect((await p.call('login', {})).isError).toBe(true)
    expect((await p.call('route', { action: 'list' })).text).toContain('질문 배분이 비어')
    const doc = await p.call('doctor')
    expect(doc.text).toContain('✗ 팀 세션')
    expect(doc.text).not.toMatch(/[✓✗] 연결:/)
  })

  it('채널 알림을 보내지 않는다(상태줄 상태 파일도 만들지 않음)', async () => {
    const p = await start({ team: false })
    await new Promise((r) => setTimeout(r, 300))
    expect(p.channel).toEqual([])
  })
})

describe('번들 — 팀 세션 · 로그인 전', () => {
  it('안내문 = 도구 안내 + 최소 규약 + 로그인 안내 · 켠 순간 로그인 안내 한 줄(브라우저는 열지 않음)', async () => {
    const p = await start({ team: true })
    expect(p.instructions).toContain('# Meshwork 팀 도구 안내')
    expect(p.instructions).toContain('# Meshwork 팀 규약 (최소)')
    expect(p.instructions).toContain('/meshwork:login <서버 주소>')
    const c = await p.next((x) => x.content.includes('로그인이 필요합니다'))
    expect(c.meta).toEqual({ kind: 'system' })
  })

  it('도구는 무엇을 하면 되는지 알린다 · 상태 파일은 「로그인 필요」', async () => {
    const p = await start({ team: true, sessionId: 'ses-login-1' })
    const st = await p.call('status')
    expect(st.text).toContain('로그인이 필요합니다')
    const state = JSON.parse(
      readFileSync(
        join(p.home, '.claude', 'channels', 'meshwork', 'state-ses-login-1.json'),
        'utf8',
      ),
    ) as Record<string, unknown>
    expect(state).toMatchObject({ team: true, link: 'login', held: [], queued: 0 })
    expect(
      statSync(join(p.home, '.claude', 'channels', 'meshwork', 'state-ses-login-1.json')).mode &
        0o777,
    ).toBe(0o600)
  })

  it('처음 보는 서버로 로그인은 확인 상자가 있어야 — 못 띄우는 클라이언트면 거절(속은 에이전트가 서버를 바꾸지 못하게)', async () => {
    const p = await start({ team: true })
    const r = await p.call('login', { server: 'meshwork.example.com' })
    expect(r).toEqual({ isError: true, text: expect.stringContaining('확인 상자가 필요') })
  })

  it('로그인 — 서버 주소가 없으면 사용법 · http 는 거절(TLS 만)', async () => {
    const p = await start({ team: true })
    expect(await p.call('login', {})).toEqual({
      isError: true,
      text: expect.stringContaining('/meshwork:login <서버 주소>'),
    })
    expect(await p.call('login', { server: 'http://10.0.0.5' })).toEqual({
      isError: true,
      text: expect.stringContaining('https'),
    })
  })

  it('상태줄 스크립트를 버전 없는 고정 경로에 복사한다(실행 권한)', async () => {
    const p = await start({ team: true })
    const path = join(p.home, '.claude', 'channels', 'meshwork', 'statusline.sh')
    expect(readFileSync(path, 'utf8')).toContain('Meshwork 상태줄')
    expect(statSync(path).mode & 0o111).not.toBe(0)
  })
})

describe('번들 — 처음 켤 때 team-relay 의 질문 배분을 가져온다(명세 D.3)', () => {
  it('한 번만 · 이미 있는 낱말 · 방은 지금 것을 둔다', async () => {
    const home = tempHome()
    const tr = join(home, '.claude', 'channels', 'team-relay')
    mkdirSync(tr, { recursive: true })
    writeFileSync(
      join(tr, 'config.json'),
      JSON.stringify({
        url: 'ws://10.0.0.1:9082/ws',
        token: 'secret',
        routes: [
          { keywords: '결제', session: 'backend' },
          { room: 'web3', session: 'web' },
          { bogus: true },
        ],
      }),
    )
    const mw = join(home, '.claude', 'channels', 'meshwork')
    mkdirSync(mw, { recursive: true })
    writeFileSync(
      join(mw, 'config.json'),
      JSON.stringify({ routes: [{ room: 'web3', session: 'mine' }] }),
    )
    const p = await start({ team: false, home })
    const list = (await p.call('route', { action: 'list' })).text
    expect(list).toContain('[방 web3] → mine')
    expect(list).toContain('"결제" → backend')
    expect(list).not.toContain('→ web\n')
    const cfg = JSON.parse(readFileSync(join(mw, 'config.json'), 'utf8')) as Record<string, unknown>
    expect(cfg.routesImported).toBe(true)
    // team-relay 의 토큰 · 주소는 가져오지 않는다
    expect(JSON.stringify(cfg)).not.toContain('secret')
    expect(statSync(join(mw, 'config.json')).mode & 0o777).toBe(0o600)
    await p.close()
    running.splice(running.indexOf(p), 1)
    // 지운 뒤 다시 켜도 다시 가져오지 않는다
    writeFileSync(join(mw, 'config.json'), JSON.stringify({ routes: [], routesImported: true }))
    const again = await start({ team: false, home })
    expect((await again.call('route', { action: 'list' })).text).toContain('질문 배분이 비어')
  })
})

describe('번들 — Claude Code 가 초기화를 마치기 전에는 세션에 넣지 않는다(넣은 것으로 치고 ack 하면 잃음)', () => {
  it('initialize 뒤 initialized 전에는 채널 알림 없음 → initialized 뒤에 온다', async () => {
    const home = tempHome()
    const child = spawn(process.execPath, [BUNDLE], {
      env: {
        ...process.env,
        HOME: home,
        MESHWORK_GATEWAY: '1',
        CLAUDE_CODE_SESSION_ID: 's',
        MESHWORK_NUDGE_DELAY_MS: '10',
        MESHWORK_HOME: '',
        TEAM_RELAY_CONFIG: '',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')))
    const send = (m: unknown) => child.stdin.write(`${JSON.stringify(m)}\n`)
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 't', version: '0' },
      },
    })
    await new Promise((r) => setTimeout(r, 600))
    expect(out).toContain('"id":1')
    expect(out).not.toContain('notifications/claude/channel')
    send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    await new Promise((r) => setTimeout(r, 600))
    expect(out).toContain('notifications/claude/channel')
    child.kill()
  })
})
