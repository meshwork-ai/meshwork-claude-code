#!/bin/sh
# 채널 도착 확인 표시(⑨ 수정 B · core/channel-confirm.ts) — 아무것도 출력하지 않는다(UserPromptSubmit 의 출력은 AI 대화에 들어간다).
# $PPID 가 claude 다(실측 2.1.314 — 중간 셸 없음). claude 창마다 표시 — 같은 창의 MCP 서버(플러그인)가 읽는다.
#   prompt — 일하기 시작(busy) · 글에 이 플러그인의 채널 꼬리표가 있으면 들어감(seen)
#   stop   — 쉬는 중(idle)
DIR="${MESHWORK_HOME:-$HOME/.claude/channels/meshwork}"
# 밀리초(끝 · 다음 시작이 같은 초에 찍혀도 순서가 갈리게) — perl 이 없으면 초 × 1000
NOW=$(perl -MTime::HiRes=time -e 'printf "%d", time * 1000' 2>/dev/null) || NOW=$(($(date +%s) * 1000))
mark() {
  (umask 077 && mkdir -p "$DIR" 2>/dev/null &&
    printf '%s' "$NOW" > "$DIR/chan-$PPID.$1.$$" 2>/dev/null &&
    mv -f "$DIR/chan-$PPID.$1.$$" "$DIR/chan-$PPID.$1" 2>/dev/null)
}
case "$1" in
  prompt)
    mark busy
    case "$(cat 2>/dev/null)" in *'<channel source='*'plugin:meshwork:meshwork'*) mark seen ;; esac
    ;;
  stop) mark idle ;;
esac
exit 0
