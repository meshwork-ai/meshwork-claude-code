/** 버전 · 클라이언트 이름 — 서버의 최소 버전 검사(명세 §4.1)와 진단에 쓰인다 */

/** 플러그인 판 — `hello.client.version` · `Meshwork-Client` 헤더 · doctor (세 곳을 check-version.ts 가 맞춘다) */
export const PLUGIN_VERSION = '0.2.1'

/** `hello.client.name` — 운영자가 최소 버전을 정하는 이름(운영 콘솔 「클라이언트」) */
export const CLIENT_NAME = 'meshwork-plugin'

/** 기기 코드 로그인의 client_id — 서버가 이것으로 기기 종류를 `plugin` 으로 정한다(명세 §3.2) */
export const CLIENT_ID = 'meshwork-plugin' as const

/** 이 플러그인이 도는 가장 낮은 Node 주 버전 — 내장 WebSocket(3단계 ①) · esbuild target 과 같게 */
export const MIN_NODE = 22
