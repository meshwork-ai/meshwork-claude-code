/**
 * 이 플러그인이 PC 에 두는 파일의 자리 — 한 곳에서만 정한다(보호 훅 `guard.ts` 도 이 값을 쓴다).
 *
 *   ~/.claude/channels/meshwork/
 *     config.json      서버 · 조직 · 질문 배분 · 자동 답장 · Claude 세션 → 받는 방 (0600)
 *     tokens.json      로그인 토큰 (0600 — 결정 대장 3단계 ⑦: 파일 + 보호 훅)
 *     tokens.lock      한 기기의 여러 터미널이 토큰을 하나씩 갱신하는 잠금
 *     cache/           규약 · 방 메모리 사본(서버에 닿지 못할 때)
 *     state-<세션>.json 상태줄이 읽는 상태 · name-<PID> 세션 이름(상태줄이 적음)
 *     statusline.sh    상태줄 스크립트의 고정 경로(설치본 경로에는 버전이 들어가므로)
 *
 * team-relay 의 폴더(`~/.claude/channels/team-relay/`)와 따로 둔다 — 시범 기간에 두 플러그인을 같이 설치한다(3단계 ②).
 * `MESHWORK_HOME` 은 시험용(다른 폴더에서 돌려 보기).
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

export function meshworkHome(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return env.MESHWORK_HOME || join(home, '.claude', 'channels', 'meshwork')
}

export interface Paths {
  home: string
  config: string
  tokens: string
  lock: string
  cache: string
  statusline: string
}

export function paths(home = meshworkHome()): Paths {
  return {
    home,
    config: join(home, 'config.json'),
    tokens: join(home, 'tokens.json'),
    lock: join(home, 'tokens.lock'),
    cache: join(home, 'cache'),
    statusline: join(home, 'statusline.sh'),
  }
}

/** team-relay 설정 — 처음 켤 때 질문 배분 규칙을 가져온다(명세 D.3 5) */
export function teamRelayConfig(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.TEAM_RELAY_CONFIG || join(homedir(), '.claude', 'channels', 'team-relay', 'config.json')
  )
}
