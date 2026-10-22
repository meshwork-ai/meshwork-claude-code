/**
 * 사람에게 보일 문구 — 서버의 코드 + 값은 `@meshwork-ai/i18n` 으로(명세 §13), 플러그인만의 안내는 여기.
 * 도구 결과는 에이전트가 읽고 사용자에게 옮기므로 **할 일 하나**를 분명히 적는다.
 */
import {
  ClosedError,
  LoginStoppedError,
  MeshworkError,
  TimeoutError,
} from '@meshwork-ai/client-core'
import { formatCode, type Lang } from '@meshwork-ai/i18n'

import type { LinkState } from './link'

export interface TextOptions {
  lang: Lang
  name?: (id: string) => string | undefined
}

/** 실패 → 한 줄 */
export function errorText(e: unknown, o: TextOptions): string {
  if (e instanceof MeshworkError) {
    return formatCode('error', e.code, e.params, {
      lang: o.lang,
      ...(o.name ? { name: o.name } : {}),
    })
  }
  if (e instanceof TimeoutError) return '서버가 제때 답하지 않았습니다 — 잠시 뒤 다시 해 보세요'
  if (e instanceof ClosedError) return '서버와의 연결이 끊겼습니다 — 다시 붙는 대로 다시 해 보세요'
  if (e instanceof LoginStoppedError) {
    if (e.reason === 'denied') return '브라우저에서 로그인을 거절했습니다'
    if (e.reason === 'expired')
      return '로그인 코드가 만료됐습니다(10분) — /meshwork:login 으로 다시 시작하세요'
    return '로그인을 그만뒀습니다'
  }
  return e instanceof Error ? e.message : String(e)
}

/** 연결이 준비되지 않았을 때 — 무엇을 하면 되는지 */
export function notReadyText(state: LinkState, o: TextOptions): string {
  switch (state.kind) {
    case 'no_server':
      return '로그인이 필요합니다 — /meshwork:login <서버 주소> (서버 주소는 다운로드 페이지 · 사용 가이드에 있습니다)'
    case 'logged_out': {
      const why =
        state.reason && state.reason !== 'login'
          ? formatCode(
              state.reason.includes('.') ? 'error' : 'revoke',
              state.reason,
              {},
              { lang: o.lang },
            )
          : null
      return `${why ? `${why} ` : ''}로그인이 필요합니다 — /meshwork:login`
    }
    case 'no_org': {
      const pending = state.orgs.filter((x) => x.membership === 'pending')
      if (pending.length && !state.orgs.some((x) => x.membership === 'active')) {
        return `${pending.map((x) => `'${x.name}'`).join(', ')} 조직이 나를 추가했지만 아직 수락하지 않았습니다 — 브라우저 로그인 화면에서 [수락]한 뒤 /meshwork:login org`
      }
      return '붙을 조직을 골라야 합니다 — /meshwork:login org'
    }
    case 'connecting':
    case 'reconnecting':
      return '서버에 붙는 중입니다 — 잠시 뒤 다시 해 보세요(계속 안 되면 /meshwork:doctor)'
    case 'stopped':
      return stoppedText(state, o)
    case 'open':
      return '이 세션이 아직 열리지 않았습니다 — 잠시 뒤 다시 해 보세요'
  }
}

/** 다시 붙지 않게 된 사유 */
export function stoppedText(
  state: Extract<LinkState, { kind: 'stopped' }>,
  o: TextOptions,
  params: Record<string, unknown> = {},
): string {
  if (state.reason === 'outdated') {
    return 'Meshwork 플러그인 업데이트가 필요합니다 — /plugin 에서 meshwork 를 업데이트한 뒤 새 세션을 여세요'
  }
  if (state.reason === 'removed') {
    const reason = typeof params.reason === 'string' ? params.reason : undefined
    return `${reason ? formatCode('revoke', reason, {}, { lang: o.lang }) : '이 조직에서 빠졌습니다.'} 다른 조직이 있으면 /meshwork:login org`
  }
  if (state.code) return formatCode('error', state.code, params, { lang: o.lang })
  return '서버가 연결을 받아 주지 않았습니다 — /meshwork:doctor 로 확인하세요'
}

/** ISO 시각 → `10/22 14:03` (그 기기 시간대) */
export function shortTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 긴 글 줄이기 — 목록 한 줄에 */
export function clip(text: string, max = 120): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}
