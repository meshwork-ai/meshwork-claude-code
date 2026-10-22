#!/bin/sh
# Meshwork 보호 훅 런처 — 있는 런타임으로 판정 번들을 띄운다(run.sh 와 같은 순서).
# 런타임이 없거나 번들이 없으면 **아무 결정 없이 끝낸다(통과)** — 내 작업은 Meshwork 때문에 막히지 않는다.
DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
[ -f "$DIR/dist/guard.mjs" ] || exit 0
command -v node >/dev/null 2>&1 && exec node "$DIR/dist/guard.mjs"
command -v bun  >/dev/null 2>&1 && exec bun  "$DIR/dist/guard.mjs"
exit 0
