/** Bun 에서 돌 때만 있는 전역 — 진단 문구에 런타임 버전을 적는 데만 쓴다(host/claude.ts) */
declare const Bun: { readonly version: string } | undefined
