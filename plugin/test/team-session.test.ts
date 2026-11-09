import { describe, expect, it } from 'vitest'

import { teamFromArgs } from '../core/team-session'

describe('팀 세션 판단 — 부모 claude 의 실행 명령(채널 플래그 + 이 플러그인)', () => {
  it('채널 플래그로 이 플러그인을 켠 세션', () => {
    expect(
      teamFromArgs('claude --dangerously-load-development-channels plugin:meshwork@meshwork'),
    ).toBe('team')
    expect(teamFromArgs('/opt/bin/claude --channels plugin:meshwork@meshwork --resume abc')).toBe(
      'team',
    )
    expect(teamFromArgs('claude --channels=plugin:discord@x,plugin:meshwork@meshwork')).toBe('team')
    expect(
      teamFromArgs(
        'claude --dangerously-skip-permissions --dangerously-load-development-channels plugin:meshwork@meshwork',
      ),
    ).toBe('team')
  })

  it('채널 플래그가 없으면 — 이 세션에는 메시지가 오지 않는다(받지 않음)', () => {
    expect(teamFromArgs('claude')).toBe('no-channel')
    expect(teamFromArgs('claude --resume abc')).toBe('no-channel')
    // 이름만 있고 플래그는 없음
    expect(teamFromArgs('claude --plugin-dir plugin:meshwork@meshwork')).toBe('no-channel')
  })

  it('다른 플러그인의 채널만 켰으면 — 이 플러그인은 받지 않는다', () => {
    expect(teamFromArgs('claude --channels plugin:discord@claude-plugins-official')).toBe(
      'other-channel',
    )
  })

  it('한 번 묻고 끝나는(-p) 실행은 팀 세션이 아니다 — 진입점으로(실측 대화형 cli · -p sdk-cli)', () => {
    expect(teamFromArgs('claude -p hi --channels plugin:meshwork@meshwork', 'sdk-cli')).toBe(
      'print',
    )
    expect(teamFromArgs('claude --channels plugin:meshwork@meshwork', 'cli')).toBe('team')
    // 첫 프롬프트 안의 「-p」 는 실행 방식이 아니다(명령 글에는 따옴표가 없다)
    expect(
      teamFromArgs('claude --channels plugin:meshwork@meshwork -p 옵션 설명해 줘', 'cli'),
    ).toBe('team')
  })

  it('명령을 못 읽으면 팀 세션이 아니다(받지 않음 — 서버가 보관)', () => {
    expect(teamFromArgs('')).toBe('unknown')
  })
})
