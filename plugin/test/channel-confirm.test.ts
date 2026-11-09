import { describe, expect, it } from 'vitest'

import { ChannelDropped, waitDelivered, type ChannelMarks } from '../core/channel-confirm'

/** 가짜 시계 · 훅 표시 — 기다리는 동안 시험이 표시를 바꾼다 */
function world(start: ChannelMarks = {}) {
  let now = 100_000
  let marks: ChannelMarks = { ...start }
  const plan: { at: number; set: ChannelMarks }[] = []
  const deps = {
    now: () => now,
    read: () => marks,
    sleep: async (ms: number) => {
      now += ms
      for (const p of plan.splice(0)) {
        if (now >= p.at) marks = { ...marks, ...p.set }
        else plan.push(p)
      }
    },
    idleMs: 5_000,
  }
  return {
    deps,
    at: (ms: number, set: ChannelMarks) => plan.push({ at: 100_000 + ms, set }),
    now: () => now,
  }
}

describe('채널 도착 확인 — 첫 메시지가 정말 AI 에게 들어갔나(⑨ 수정 B · 실측 2.1.314)', () => {
  it('쉬는 중 — 훅이 곧 「봄」 을 적으면 들어간 것', async () => {
    const w = world()
    w.at(300, { seen: 100_300, busy: 100_300 })
    await expect(waitDelivered(100_000, w.deps)).resolves.toBeUndefined()
  })

  it('쉬는 중인데 몇 초 안에 「봄」 이 없으면 — 채널이 꺼진 것(받지 않음)', async () => {
    const w = world({ idle: 90_000 })
    await expect(waitDelivered(100_000, w.deps)).rejects.toBeInstanceOf(ChannelDropped)
    expect(w.now() - 100_000).toBeGreaterThanOrEqual(5_000)
  })

  it('AI 가 일하는 중이면 — 턴이 끝날 때까지 기다린다(훅은 턴이 끝난 직후)', async () => {
    const w = world({ busy: 95_000, idle: 90_000 })
    w.at(60_000, { idle: 160_000 })
    w.at(60_200, { seen: 160_200, busy: 160_200 })
    await expect(waitDelivered(100_000, w.deps)).resolves.toBeUndefined()
  })

  it('일하다 끝났는데 그 뒤 몇 초 안에 「봄」 이 없으면 — 꺼진 것', async () => {
    const w = world({ busy: 95_000, idle: 90_000 })
    w.at(30_000, { idle: 130_000 })
    await expect(waitDelivered(100_000, w.deps)).rejects.toBeInstanceOf(ChannelDropped)
    expect(w.now()).toBeGreaterThanOrEqual(135_000)
  })

  it('보내기 전의 「봄」 은 이번 것이 아니다', async () => {
    const w = world({ seen: 99_000, idle: 99_500 })
    await expect(waitDelivered(100_000, w.deps)).rejects.toBeInstanceOf(ChannelDropped)
  })

  it('함께 기다리던 다른 글이 들어간 것을 보면 — 이 글도 끝(정상 세션을 꺼짐으로 보지 않게)', async () => {
    const w = world({ idle: 90_000 })
    let other = false
    w.at(1_000, {})
    const p = waitDelivered(100_000, { ...w.deps, done: () => other })
    other = true
    await expect(p).resolves.toBeUndefined()
  })

  it('초 단위로 적는 기기 — 같은 초 안의 「봄」 도 이번 것으로 본다', async () => {
    const w = world()
    w.at(100, { seen: 100_000 })
    await expect(waitDelivered(100_400, w.deps)).resolves.toBeUndefined()
  })
})
