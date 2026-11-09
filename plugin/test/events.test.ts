/**
 * 서버 알림 → 세션 — 플러그인 본체를 가짜 연결로 띄워 본다(번들 시험은 서버에 붙지 않는다)
 */
import { describe, expect, it } from 'vitest'

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Link } from '../app/link'
import { Plugin } from '../app/plugin'
import { paths } from '../core/paths'
import { ChannelDropped } from '../core/channel-confirm'

type Handler = (d: unknown, frame?: unknown) => unknown

function setup(o: { drop?: boolean } = {}) {
  const handlers = new Map<string, Handler[]>()
  const client = {
    on(ev: string, fn: Handler) {
      handlers.set(ev, [...(handlers.get(ev) ?? []), fn])
      return () => {}
    },
  }
  const notes: { content: string; meta: Record<string, string> }[] = []
  let onClient: ((c: unknown) => void) | undefined
  const link = {
    client,
    session: { sid: 'ses_1', held: [] as string[] },
    welcome: { me: { member: 'mem_me' } },
    config: () => ({}),
    onClient: (fn: (c: unknown) => void) => void (onClient = fn),
    halted: 0,
    halt() {
      this.halted++
    },
    state: { kind: 'open' },
    contextChanged: false,
  }
  const host = {
    sessionId: 's',
    isTeam: true,
    teamCheck: 'team',
    runtime: 'node',
    nodeMajor: 24,
    workDir: '/w',
    sessionName: () => undefined,
    notify: async (content: string, meta: Record<string, string>) => {
      if (o.drop) throw new ChannelDropped('꺼짐')
      notes.push({ content, meta })
    },
  }
  const p = new Plugin(host as never, link as never, { home: '/tmp/x' } as never, () => {})
  onClient!(client)
  p.mcpConnected()
  const emit = async (ev: string, d: unknown) => {
    for (const fn of handlers.get(ev) ?? []) await fn(d, { sid: 'ses_1' })
  }
  return { p, notes, emit, link }
}

describe('사람이 「답하지 않기」 한 질문(thread.skipped)', () => {
  it('받은 질문이면 세션에 알린다 — 답하지 마세요 · 한 번만', async () => {
    const { p, notes, emit } = setup()
    p.received.set('thr_1', { from: '이민준' })
    await emit('thread.skipped', { thread: 'thr_1' })
    await emit('thread.skipped', { thread: 'thr_1' })
    expect(notes).toHaveLength(1)
    expect(notes[0]!.content).toContain('[답하지 않음]')
    expect(notes[0]!.content).toContain('이민준')
    expect(notes[0]!.meta).toMatchObject({ kind: 'skipped', thread: 'thr_1', author: 'plugin' })
    // 답장은 서버가 「답하지 않기로 한 대화」 로 거절 — 「다른 곳에서 이미 답함」 으로 보이지 않게 따로 기억
    expect(p.answeredElsewhere.has('thr_1')).toBe(false)
  })

  it('이 세션이 받지 않은 대화 · 이미 답한 대화는 알리지 않는다', async () => {
    const { p, notes, emit } = setup()
    await emit('thread.skipped', { thread: 'thr_x' })
    p.received.set('thr_2', { from: '이민준' })
    p.repliedHere.add('thr_2')
    await emit('thread.skipped', { thread: 'thr_2' })
    expect(notes).toEqual([])
  })
})

describe('채널이 꺼진 세션(⑨ 수정 B)', () => {
  it('첫 글이 들어가지 않으면 — 받음 처리를 하지 않고(던짐) 받기를 멈춘다 · 그 뒤 글은 호스트에 넘기지 않는다', async () => {
    const { p, link } = setup({ drop: true })
    await expect(p.notify('질문', { kind: 'question' })).rejects.toBeInstanceOf(ChannelDropped)
    expect(p.channelDropped).toBe(true)
    expect(link.halted).toBe(1)
    expect(p.linkKind()).toBe('stopped')
    await expect(p.notify('또', { kind: 'question' })).rejects.toBeInstanceOf(ChannelDropped)
    expect(link.halted).toBe(1)
  })
})

describe('채널이 꺼져 멈춘 연결 — 다시 열지 않는다(로그인 · 조직 바꾸기 · 도구)', () => {
  it('halt 뒤 restart · ready 는 열지 않고 멈춤 그대로', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mw-halt-'))
    const link = new Link({
      host: { sessionId: 's', isTeam: true } as never,
      paths: paths(home),
      log: () => {},
    })
    link.halt('channel')
    expect(await link.restart()).toBe(false)
    expect(await link.ready(50)).toBe(false)
    expect(link.state).toEqual({ kind: 'stopped', reason: 'closed', code: 'channel' })
  })

  it('알림이 실패하면 기억하지 않는다 — 다시 받을 때 다시 알린다', async () => {
    const { p, emit } = setup({ drop: true })
    p.received.set('thr_9', { from: '이민준' })
    await expect(emit('thread.skipped', { thread: 'thr_9' })).rejects.toBeInstanceOf(ChannelDropped)
    expect((p as unknown as { skipped: Set<string> }).skipped.has('thr_9')).toBe(false)
  })
})
