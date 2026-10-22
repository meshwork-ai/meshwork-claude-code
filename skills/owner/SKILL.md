---
name: owner
description: 방장 · 관리자 — 초대 링크 만들기 · 살아 있는 링크 보기 · 취소 · 방에서 내보내기 · 방 전원 공지 · 방 메모리. 사용법 — /meshwork:owner invite|invites|revoke|kick|notice|memory <방> [이름 · 번호 · 내용]
argument-hint: 'invite|invites|revoke|kick|notice|memory <방> [이름 · 번호 · 내용]'
---

사용자가 `/meshwork:owner <동작> <방> ...` 를 실행했다. 조직 관리자는 모든 방에서 방장 권한이 있다.

1. `invite <방> [이름]` → `owner(action:"invite", room, name?)` — 1회용 초대 링크를 그대로 보이고 받을 사람에게 전하라고 안내한다.
   이름은 그 방에서 쓸 이름 제안(선택). **링크 주소는 지금만 보인다**(목록에는 번호만)는 것도 알린다.
2. `invites <방>` → `owner(action:"invites", room)` — 살아 있는 링크(번호 · 만든 사람 · 만료)를 보인다.
3. `revoke <방> <번호>` → `owner(action:"revoke", room, invite)` — 잘못 보낸 링크를 만료 전에 취소한다.
4. `kick <방> <이름>` → `owner(action:"kick", room, name)` — **그 방에서만** 빠지고 다른 방 · 조직은 그대로라는 점을 함께 알린다.
5. `notice <방> <내용>` → `owner(action:"notice", room, text)` — 바로 받은 수 · 보관한 수를 그대로 전한다.
6. `memory <방>` → `memory(action:"view", room)` 로 지금 내용과 대기 중인 제안을 보이고, 사용자가 원하는 대로:
   - 설명 → `memory(action:"describe", room, text)`
   - 내용 더하기 · 고치기 · 지우기 → `add`(text) · `edit`(pos, text) · `remove`(pos)
   - 제안 처리 → `approve`(proposal_id, 3칸이 다 찼으면 replace) · `reject`(proposal_id, reason)
   메모리는 **설명 1 + 내용 최대 3, 칸마다 150자**다. 넣을 기준은 "코드로는 알 수 없고 답이 매번 같은 것" — 이유가 필요하면 함께 쓴다(예: "금요일 배포 금지 — 주말 호출 방지").
7. "권한이 없습니다" 면 그 방의 방장이 아니라는 뜻이다 — 조직 관리자에게 방장 지정을 요청하라고 안내한다.
