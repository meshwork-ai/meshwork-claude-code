---
name: route
description: 질문 배분 — 팀 질문의 낱말 · 방을 이 기기의 세션에 맡겨 둔다. /meshwork:route (목록) · /meshwork:route add "<낱말>" <세션> · /meshwork:route add --room <방> <세션> · /meshwork:route remove "<낱말>"|--room <방>
argument-hint: '[add "<낱말>" <세션> | add --room <방> <세션> | remove "<낱말>" | remove --room <방>]'
---

사용자가 `/meshwork:route` 를 실행했다. 질문 배분은 "이런 낱말의 팀 질문이 오면 이 기기의 저 세션에 위임하라" 는 명시 규칙이다
(팀 규약 6 의 ①). 처음 켤 때 team-relay 의 규칙을 가져와 두었다.

1. 인자가 없거나 `list` 면 `route(action: "list")` 로 목록을 보인다.
2. `add "<낱말>" <세션 이름>` 이면 `route(action: "add", keywords, session)`. 세션 이름은 이 기기의 Claude Code 세션 이름(`/rename` 으로 붙인 것)이라고 설명한다.
3. `add --room <방> <세션 이름>` 이면 `route(action: "add", room, session)` — 그 방에서 온 질문은 낱말과 상관없이 늘 그 세션이 답한다.
4. `remove "<낱말>"` 면 `route(action: "remove", keywords)`, `remove --room <방>` 이면 `route(action: "remove", room)`.
5. 등록이 없으면 내 세션 쪽 위임은 하지 않고, 다른 사람 · 역할로 넘기거나 사용자에게 확인한다는 것을 필요하면 덧붙인다.
