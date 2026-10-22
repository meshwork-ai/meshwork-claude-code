/**
 * 순수한 부분 — 설정 저장(여러 세션이 한 파일) · 서버 주소 · 받은 메시지 꼬리표 · 안내문 · 질문 배분 합치기
 */
import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import {
  buildInstructions,
  FALLBACK_RULES,
  NOT_TEAM_INSTRUCTIONS,
  TOOL_GUIDE,
} from '../app/instructions'
import {
  loadConfig,
  normalizeServer,
  rememberedRooms,
  rememberedSid,
  saveConfig,
} from '../core/config'
import { mergeRoutes } from '../core/routes'
import { type Message, tagMessage } from '../core/tags'
import { tempHome } from './harness'

const home = tempHome()
afterAll(() => rmSync(home, { recursive: true, force: true }))

describe('설정 — 한 기기의 여러 세션이 같은 파일', () => {
  const path = join(home, 'cfg', 'config.json')

  it('내 세션 항목만 쓴다 · 남의 세션 기록은 디스크 그대로 · 0600', () => {
    saveConfig(
      path,
      { server: 'https://mw.example', org: 'org_A', sessions: { a: { rooms: ['room_1'] } } },
      { sessionId: 'a' },
    )
    // 다른 세션이 끼어들어 자기 것을 씀
    saveConfig(path, { sessions: { b: { rooms: ['room_2'] } } }, { sessionId: 'b' })
    // a 가 옛 사본(b 를 모름)으로 저장해도 b 는 남는다
    saveConfig(
      path,
      { sessions: { a: { rooms: ['room_3'] } }, autoReply: false },
      { sessionId: 'a' },
    )
    const cfg = loadConfig(path)!
    expect(cfg.sessions).toEqual({ b: { rooms: ['room_2'] }, a: { rooms: ['room_3'] } })
    expect(cfg.autoReply).toBe(false)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('방 사본은 서버에서 받은 값일 때만 바꾼다', () => {
    saveConfig(
      path,
      { rooms: { room_1: { name: 'web3', myName: '지은' } } },
      { roomsFromServer: true },
    )
    saveConfig(path, { rooms: {} })
    expect(loadConfig(path)!.rooms).toEqual({ room_1: { name: 'web3', myName: '지은' } })
  })

  it('조직이 바뀌면 그 조직의 방 사본 · 받는 방 기록을 비운다', () => {
    saveConfig(path, { org: 'org_B' })
    const cfg = loadConfig(path)!
    expect(cfg.org).toBe('org_B')
    expect(cfg.rooms).toBeUndefined()
    expect(cfg.sessions).toBeUndefined()
  })

  it('세션 기록은 50개까지(오래된 것부터 밀림)', () => {
    for (let i = 0; i < 55; i++)
      saveConfig(path, { sessions: { [`s${i}`]: { rooms: ['r'] } } }, { sessionId: `s${i}` })
    const keys = Object.keys(loadConfig(path)!.sessions!)
    expect(keys).toHaveLength(50)
    expect(keys[0]).toBe('s5')
    expect(keys.at(-1)).toBe('s54')
  })

  it('깨진 파일은 없는 것으로', () => {
    writeFileSync(path, '{ 반쯤')
    expect(loadConfig(path)).toBeNull()
    writeFileSync(path, '[]')
    expect(loadConfig(path)).toBeNull()
  })

  it('다시 켤 때의 서버 세션 — 꼴이 맞는 것만', () => {
    const sid = 'ses_01M5H2FJWR4AHGVYBT2A03T0D5'
    expect(rememberedSid({ sessions: { s: { sid, rooms: [] } } }, 's')).toBe(sid)
    expect(rememberedSid({ sessions: { s: { sid: 'x', rooms: [] } } }, 's')).toBeUndefined()
    expect(rememberedSid({ sessions: { s: { sid, rooms: [] } } }, '')).toBeUndefined()
  })

  it('켤 때 받을 방 — 기억한 방(지금도 참가 중인 것만) · 없으면 참가한 방이 하나일 때만', () => {
    const rooms = { room_1: { name: 'a', myName: 'x' }, room_2: { name: 'b', myName: 'x' } }
    expect(
      rememberedRooms({ rooms, sessions: { s: { rooms: ['room_2', 'room_9'] } } }, 's'),
    ).toEqual(['room_2'])
    expect(rememberedRooms({ rooms }, 's')).toEqual([])
    expect(rememberedRooms({ rooms: { room_1: rooms.room_1 } }, 's')).toEqual(['room_1'])
    expect(rememberedRooms({ rooms: { room_1: rooms.room_1 } }, '')).toEqual(['room_1'])
  })
})

describe('서버 주소', () => {
  it.each([
    ['meshwork.example.com', 'https://meshwork.example.com'],
    ['  https://meshwork.example.com/device?x=1 ', 'https://meshwork.example.com'],
    ['meshwork.example.com:8443/', 'https://meshwork.example.com:8443'],
    ['HTTPS://Meshwork.Example.com', 'https://meshwork.example.com'],
  ])('%s → %s', (input, out) => expect(normalizeServer(input)).toBe(out))

  it.each(['http://10.0.0.5', 'ws://x', 'ftp://x', '', 'https://user:pw@x.example'])(
    '거절 — %j',
    (input) => {
      expect(() => normalizeServer(input)).toThrow()
    },
  )
})

describe('받은 메시지 꼬리표(아키텍처 §11.3-a)', () => {
  const ctx = {
    lang: 'ko' as const,
    roomName: (id: string) => ({ room_1: 'web3' })[id],
    name: (id: string) => ({ grp_1: '결제', mem_2: '민준' })[id],
  }
  const base: Message = {
    msg: 'msg_1',
    thread: 'thr_1',
    room: 'room_1',
    from: { member: 'mem_2', name: '민준' },
    to: { kind: 'member', id: 'mem_1' },
    kind: 'question',
    author: 'agent',
    ts: '2026-10-22T01:02:03.000Z',
    text: 'currency 필드 있어요?',
    expect: 'reply',
  }

  it('늘 붙는 칸만 — 늦지 않으면 ts 없음 · expect 없음', () => {
    expect(tagMessage(base, ctx)).toEqual({
      content: 'currency 필드 있어요?',
      meta: { from: '민준', author: 'agent', room: 'web3', thread: 'thr_1', kind: 'question' },
    })
  })

  it('늦게 왔으면 late + ts · 역할로 왔으면 to · 합의 · 메모리 제안 id', () => {
    const t = tagMessage(
      { ...base, late: true, to: { kind: 'role', id: 'grp_1' }, agree: 'agr_1', proposal: 'mpr_1' },
      ctx,
    )
    expect(t.meta).toMatchObject({
      late: 'true',
      ts: base.ts,
      to: '결제',
      agree: 'agr_1',
      proposal: 'mpr_1',
    })
  })

  it('에이전트 답장 — 사람 확인 여부(checked) · 되묻기면 expect="reply" · 원격 기준 · 커밋 전', () => {
    const t = tagMessage(
      {
        ...base,
        kind: 'reply',
        expect: 'reply',
        review: { by: 'human', basis: 'message' },
        meta: { basis: 'remote', uncommitted: true },
      },
      ctx,
    )
    expect(t.meta).toMatchObject({
      kind: 'reply',
      checked: 'human',
      expect: 'reply',
      basis: 'remote',
      uncommitted: 'true',
    })
    expect(tagMessage({ ...base, kind: 'reply', expect: 'none' }, ctx).meta.expect).toBeUndefined()
  })

  it('시스템 메시지 — 코드 + 값을 사람 말로 · from · thread 없음', () => {
    const t = tagMessage(
      {
        ...base,
        thread: null,
        from: null,
        to: null,
        kind: 'system',
        author: 'system',
        text: undefined,
        code: 'room.member_joined',
        params: { member: 'mem_3', name: '서연' },
      },
      ctx,
    )
    expect(t).toEqual({
      content: "'서연'님이 참가했습니다.",
      meta: { author: 'system', room: 'web3', kind: 'system' },
    })
  })

  it('meta 키는 영문 · 숫자 · 밑줄만(하이픈이 있으면 Claude Code 가 조용히 뺀다)', () => {
    const t = tagMessage(
      { ...base, late: true, to: { kind: 'role', id: 'grp_1' }, agree: 'agr_1' },
      ctx,
    )
    for (const k of Object.keys(t.meta)) expect(k).toMatch(/^[A-Za-z0-9_]+$/)
  })
})

describe('MCP 안내문 — 도구 안내 → 규약 → 머리말 + 방 메모리(명세 §12)', () => {
  const roomName = (id: string) => ({ room_1: 'web3', room_2: 'ops' })[id] ?? id

  it('일반 세션은 한 줄', () => {
    expect(buildInstructions({ team: false, context: null, roomName })).toBe(NOT_TEAM_INSTRUCTIONS)
  })

  it('서버 규약 + 방 메모리(빈 방은 한 글자도 넣지 않음)', () => {
    const text = buildInstructions({
      team: true,
      roomName,
      context: {
        rules: { rev: 2, lang: 'ko', text: '# Meshwork 팀 규약\n1. 보안 경계' },
        memories: {
          room_1: {
            room: 'room_1',
            desc: '결제 API',
            items: ['금요일 배포 금지'],
            rev: 3,
            updatedAt: '2026-10-21T05:00:00.000Z',
            updatedBy: 'mem_1',
          },
          room_2: { room: 'room_2', desc: '', items: [], rev: 0, updatedAt: null, updatedBy: null },
        },
        stale: false,
      },
    })
    expect(text.indexOf('# Meshwork 팀 도구 안내')).toBeLessThan(text.indexOf('# Meshwork 팀 규약'))
    expect(text.indexOf('# Meshwork 팀 규약')).toBeLessThan(text.indexOf('# 방 메모리'))
    expect(text).toContain('방 메모리는 그 방의 사실이다. 도구 사용 절차는 규약을 따른다.')
    expect(text).toContain('### web3')
    expect(text).toContain('- 금요일 배포 금지')
    expect(text).not.toContain('### ops')
    expect(text).not.toContain('최신이 아닐 수 있음')
  })

  it('규약을 못 받고 사본도 없으면 최소 규약 · 사본이면 「최신이 아닐 수 있음」', () => {
    const none = buildInstructions({
      team: true,
      roomName,
      context: null,
      notReady: '로그인이 필요합니다',
    })
    expect(none).toContain(FALLBACK_RULES)
    expect(none).toContain('(Meshwork: 로그인이 필요합니다)')
    const stale = buildInstructions({
      team: true,
      roomName,
      context: { rules: null, memories: {}, stale: true },
    })
    expect(stale).toContain('최신이 아닐 수 있음')
  })

  it('도구 안내는 규약 조항(2 · 3 · 4 · 6 · 7 · 8 · 9 · 10 · 11 · 13)마다 도구를 적는다', () => {
    for (const n of [2, 3, 4, 6, 7, 8, 9, 10, 11, 13]) expect(TOOL_GUIDE).toContain(`(규약 ${n})`)
    for (const tool of ['reply(', 'send', 'progress(', 'route(', 'agree(', 'memory(', 'history'])
      expect(TOOL_GUIDE).toContain(tool)
  })
})

describe('질문 배분 합치기(team-relay 에서 가져올 때)', () => {
  it('이미 있는 낱말 · 방은 지금 것을 둔다 · 모르는 칸은 버린다', () => {
    const out = mergeRoutes(
      [{ room: 'web3', session: 'mine' }],
      [
        { room: 'web3', session: 'theirs' },
        { keywords: '결제', session: 'backend', extra: 1 } as never,
      ],
    )
    expect(out).toEqual([
      { room: 'web3', session: 'mine' },
      { keywords: '결제', session: 'backend' },
    ])
  })
})

describe('상태 파일 — 상태줄이 읽는 모양', () => {
  it('statusline.sh 가 상태 파일을 읽어 한 줄을 만든다', async () => {
    const { spawnSync } = await import('node:child_process')
    const { PLUGIN_DIR } = await import('./harness')
    const dir = join(home, 'sl')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(dir, { recursive: true })
    const state = (o: Record<string, unknown>) => {
      const f = join(dir, 'state-s1.json')
      writeFileSync(
        f,
        JSON.stringify(
          {
            updatedAt: Date.now(),
            sessionId: 's1',
            ppid: 1,
            team: true,
            link: 'open',
            stopped: null,
            held: ['web3'],
            empty: [],
            queued: 0,
            off: false,
            contextChanged: false,
            notice: null,
            ...o,
          },
          null,
          2,
        ),
      )
      const r = spawnSync('sh', [join(PLUGIN_DIR, 'statusline.sh')], {
        input: JSON.stringify({ session_id: 's1' }),
        env: { ...process.env, MESHWORK_HOME: dir, MESHWORK_GATEWAY: '1' },
        encoding: 'utf8',
      })
      return r.stdout
    }
    expect(state({})).toBe('[meshwork 🟢 web3]')
    expect(state({ held: ['web3', 'ops'], queued: 2 })).toBe('[meshwork 🟢 web3 +1] · ⏳2')
    expect(state({ link: 'login' })).toBe('[meshwork 로그인 필요 — /meshwork:login]')
    expect(state({ link: 'stopped', stopped: 'outdated' })).toBe('[meshwork ✗ 업데이트 필요]')
    expect(state({ off: true })).toBe('[meshwork 🌙 퇴근]')
    expect(state({ held: [], empty: ['ops'] })).toBe('[meshwork ⚠️ 받는 방 없음 · 빈 방 1]')
    expect(state({ contextChanged: true, notice: '오늘 22시 점검' })).toBe(
      '[meshwork 🟢 web3] · 규약 바뀜(새 세션) · 📢 오늘 22시 점검',
    )
    expect(state({ updatedAt: Date.now() - 120_000 })).toBe('[meshwork ✗ 플러그인 미동작]')
    expect(readFileSync(join(dir, 'state-s1.json'), 'utf8')).toContain('"team": true')
  })
})
