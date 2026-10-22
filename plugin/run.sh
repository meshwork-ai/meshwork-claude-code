#!/bin/sh
# Meshwork 플러그인 런처 — 있는 런타임으로 번들을 띄운다.
#
# Claude Code 는 네이티브 프로그램이라 Node 를 보장하지 않는다. Node 가 우선이고(최소 22 — 내장 WebSocket),
# 없으면 Bun 으로 돈다. 둘 다 없으면 이유를 남기고 끝낸다(/mcp 에 연결 실패로 보인다).
DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
command -v node >/dev/null 2>&1 && exec node "$DIR/dist/server.mjs"
command -v bun  >/dev/null 2>&1 && exec bun  "$DIR/dist/server.mjs"
echo "meshwork: node 도 bun 도 찾을 수 없습니다 — Node.js 22 이상을 설치하세요 (https://nodejs.org)" >&2
exit 1
