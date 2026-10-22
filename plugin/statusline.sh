#!/bin/sh
# Meshwork 상태줄 — Claude Code 가 주기적으로 실행해 한 줄을 받아 간다.
#
# 이 스크립트는 **플러그인 프로세스와 따로** 돈다. 그래서 플러그인이 죽어 있어도 그 사실을 보여 줄 수 있다 —
# 상태 파일의 updatedAt 이 낡은 것이 곧 그 신호다. 의존성 없음(jq 도 쓰지 않는다).
# Claude Code 가 세션 정보를 JSON 으로 표준 입력에 준다 — 그 안의 session_id 로 **이 세션의** 상태 파일만 찾는다.
# 팀 세션이 아니면 그 파일이 없으므로 아무것도 띄우지 않는다.
DIR="${MESHWORK_HOME:-$HOME/.claude/channels/meshwork}"
if [ -n "$MESHWORK_STATE" ]; then
  STATE="$MESHWORK_STATE"
else
  INPUT=$(cat 2>/dev/null)
  SID=$(printf '%s' "$INPUT" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
  [ -n "$SID" ] || exit 0
  STATE="$DIR/state-$(printf '%s' "$SID" | tr -cd 'A-Za-z0-9_-').json"

  # 세션 이름 — /rename · --name 으로 붙인 이름. 플러그인은 이 값을 받을 길이 없어(MCP 에는 오지 않음) 여기서
  # 파일로 건넨다. 열쇠는 $PPID — 상태줄과 플러그인의 부모가 같은 claude 다. 바뀔 때만 쓴다
  if [ "$MESHWORK_GATEWAY" = "1" ]; then
    SNAME=$(printf '%s' "$INPUT" | sed -n 's/.*"session_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
    if [ -n "$SNAME" ]; then
      NF="$DIR/name-$PPID"
      if [ "$(cat "$NF" 2>/dev/null)" != "$SNAME" ]; then
        (umask 077 && mkdir -p "$DIR" 2>/dev/null && printf '%s' "$SNAME" > "$NF.$$.tmp" 2>/dev/null && mv -f "$NF.$$.tmp" "$NF" 2>/dev/null)
      fi
    fi
  fi
fi

NOW=$(date +%s)

# 그 파일이 살아 있나 — updatedAt 이 60초 안이면 플러그인이 돌고 있다
fresh() {
  [ -f "$1" ] || return 1
  u=$(sed -n 's/.*"updatedAt"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' "$1" 2>/dev/null | head -1)
  [ -n "$u" ] || return 1
  [ $(( NOW - u / 1000 )) -le 60 ]
}

# 세션 id 로 된 파일이 없거나 낡았을 때 — 플러그인이 쓰는 세션 id 와 상태줄이 받는 id 가 갈릴 수 있다(--resume).
# 같은 claude 창이 낳은 파일(ppid)을 찾는다. 팀 세션이 아니면 남의 상태를 집지 않는다
if ! fresh "$STATE"; then
  [ "$MESHWORK_GATEWAY" = "1" ] || exit 0
  PICK=""
  for f in "$DIR"/state-*.json; do
    fresh "$f" || continue
    pp=$(sed -n 's/.*"ppid"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' "$f" 2>/dev/null | head -1)
    [ -n "$pp" ] && [ "$pp" = "$PPID" ] || continue
    PICK="$f"; break
  done
  [ -n "$PICK" ] || { printf '[meshwork ✗ 플러그인 미동작]'; exit 0; }
  STATE="$PICK"
fi

RAW=$(cat "$STATE" 2>/dev/null) || exit 0

# 값 뽑기 — "key": value
field() { printf '%s' "$RAW" | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\([^,}]*\).*/\1/p" | head -1 | tr -d '" '; }
text() { printf '%s' "$RAW" | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -1; }
arr_first() { printf '%s' "$RAW" | tr -d '\n' | sed -n "s/.*\"$1\":[[:space:]]*\[[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -1; }
arr_count() {
  BODY=$(printf '%s' "$RAW" | tr -d '\n' | sed -n "s/.*\"$1\":[[:space:]]*\[\([^]]*\)\].*/\1/p" | head -1)
  [ -z "$(printf '%s' "$BODY" | tr -d ' ')" ] && { echo 0; return; }
  printf '%s' "$BODY" | tr ',' '\n' | grep -c '"'
}

[ "$(field team)" = "true" ] || exit 0

# 공지 · 규약 바뀜은 뒤에 붙인다
TAIL=''
[ "$(field contextChanged)" = "true" ] && TAIL="$TAIL · 규약 바뀜(새 세션)"
NOTICE=$(text notice)
[ -n "$NOTICE" ] && TAIL="$TAIL · 📢 $(printf '%s' "$NOTICE" | cut -c1-60)"

case "$(field link)" in
  login)      printf '[meshwork 로그인 필요 — /meshwork:login]%s' "$TAIL"; exit 0 ;;
  org)        printf '[meshwork 조직 고르기 — /meshwork:login org]%s' "$TAIL"; exit 0 ;;
  connecting) printf '[meshwork … 붙는 중]%s' "$TAIL"; exit 0 ;;
  offline)    printf '[meshwork ✗ 연결 끊김 — 다시 붙는 중]%s' "$TAIL"; exit 0 ;;
  stopped)
    case "$(field stopped)" in
      outdated) printf '[meshwork ✗ 업데이트 필요]%s' "$TAIL" ;;
      removed)  printf '[meshwork ✗ 조직에서 빠짐]%s' "$TAIL" ;;
      *)        printf '[meshwork ✗ %s]%s' "$(field stopped)" "$TAIL" ;;
    esac
    exit 0 ;;
esac

[ "$(field off)" = "true" ] && { printf '[meshwork 🌙 퇴근]%s' "$TAIL"; exit 0; }

HELD_N=$(arr_count held)
QUEUED=$(field queued)
[ -z "$QUEUED" ] && QUEUED=0
[ "$QUEUED" -gt 0 ] 2>/dev/null && TAIL=" · ⏳$QUEUED$TAIL"

if [ "$HELD_N" -eq 0 ]; then
  EMPTY_N=$(arr_count empty)
  if [ "$EMPTY_N" -gt 0 ]; then printf '[meshwork ⚠️ 받는 방 없음 · 빈 방 %s]%s' "$EMPTY_N" "$TAIL"
  else printf '[meshwork ⚠️ 받는 방 없음]%s' "$TAIL"; fi
  exit 0
fi

FIRST=$(arr_first held)
if [ "$HELD_N" -gt 1 ]; then printf '[meshwork 🟢 %s +%s]%s' "$FIRST" "$(( HELD_N - 1 ))" "$TAIL"
else printf '[meshwork 🟢 %s]%s' "$FIRST" "$TAIL"; fi
