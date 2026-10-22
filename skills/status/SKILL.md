---
name: status
description: Meshwork 연결 상태(서버 · 조직 · 이 세션이 받는 방 · 참가한 방 · 방 사람들 · 자동 답장)를 보인다. 자동 답장 바꾸기 — /meshwork:status auto-reply off|on
argument-hint: '[auto-reply on|off]'
---

사용자가 `/meshwork:status` 를 실행했다.

1. 인자가 없으면 `status` 도구를 인자 없이 불러 결과를 그대로 보인다.
2. 인자가 `auto-reply off` 또는 `auto-reply on` 이면 `status` 를 `{ auto_reply: "off" | "on" }` 으로 불러 바꾸고 바뀐 상태를 보인다.
   off 는 "팀 질문에 답하기 전에 초안을 나에게 보여 달라" 는 뜻이라고 설명한다.
3. 내 이름은 **방마다 다를 수 있다** — 결과의 `방 (이름)` 표기를 그대로 전한다. "이 세션이 받는 방" 이 비어 있으면 이 세션은 팀 메시지를
   받지도 보내지도 못한다 — `/meshwork:room <방>` 을 권한다(그 방을 받던 다른 세션은 받지 못하게 된다).
4. "로그인이 필요합니다" · "조직을 골라야 합니다" 면 그 안내(`/meshwork:login` · `/meshwork:login org`)를 그대로 전한다.
5. "이 세션에서는 Meshwork 를 쓸 수 없습니다" 면 meshwork-claude 로 켠 세션이 아니라는 뜻이다 — 그 세션에서 다시 실행하라고 안내한다.
