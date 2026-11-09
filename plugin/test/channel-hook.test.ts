import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { PLUGIN_DIR } from './harness'

const run = (home: string, ev: string, input: string) =>
  spawnSync('sh', [join(PLUGIN_DIR, 'channel.sh'), ev], {
    input,
    encoding: 'utf8',
    env: { ...process.env, MESHWORK_HOME: home },
  })

describe('채널 도착 훅(channel.sh)', () => {
  it('이 플러그인의 채널 글이면 일하는 중 + 들어감 · 출력 없음(AI 대화에 들어가지 않게)', () => {
    const home = mkdtempSync(join(tmpdir(), 'mw-chan-'))
    const r = run(
      home,
      'prompt',
      JSON.stringify({
        prompt: '<channel source="plugin:meshwork:meshwork" kind="question">hi</channel>',
      }),
    )
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
    expect(Number(readFileSync(join(home, `chan-${process.pid}.busy`), 'utf8'))).toBeGreaterThan(0)
    expect(existsSync(join(home, `chan-${process.pid}.seen`))).toBe(true)
  })

  it('사람이 친 글은 일하는 중만 · 끝나면 쉬는 중', () => {
    const home = mkdtempSync(join(tmpdir(), 'mw-chan-'))
    run(home, 'prompt', JSON.stringify({ prompt: 'plugin:meshwork:meshwork 설명해 줘' }))
    expect(existsSync(join(home, `chan-${process.pid}.busy`))).toBe(true)
    expect(existsSync(join(home, `chan-${process.pid}.seen`))).toBe(false)
    expect(run(home, 'stop', '{}').stdout).toBe('')
    expect(existsSync(join(home, `chan-${process.pid}.idle`))).toBe(true)
    // 도구를 부르면 다시 일하는 중(다른 Stop 훅이 턴을 막아 이어서 일할 때)
    const before = Number(readFileSync(join(home, `chan-${process.pid}.busy`), 'utf8'))
    expect(run(home, 'tool', '{}').stdout).toBe('')
    expect(
      Number(readFileSync(join(home, `chan-${process.pid}.busy`), 'utf8')),
    ).toBeGreaterThanOrEqual(before)
  })

  it('훅 등록 — 프롬프트 · 끝에 이 스크립트', () => {
    const h = JSON.parse(readFileSync(join(PLUGIN_DIR, '..', 'hooks', 'hooks.json'), 'utf8')) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>
    }
    expect(h.hooks['UserPromptSubmit']![0]!.hooks[0]!.command).toContain('channel.sh" prompt')
    expect(h.hooks['Stop']![0]!.hooks[0]!.command).toContain('channel.sh" stop')
    expect(
      h.hooks['PreToolUse']!.some((x) => x.hooks[0]!.command.includes('channel.sh" tool')),
    ).toBe(true)
  })
})
