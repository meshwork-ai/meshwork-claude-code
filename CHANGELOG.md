# 업데이트 내역 — Meshwork for Claude Code

버전을 올리면 여기에 `## <버전> · <제목> — <날짜>` 를 적는다(빌드가 확인한다). 이사 날까지는 0.x, 이사 날 1.0.0.
team-relay 시절의 내역은 [docs/team-relay-changelog.md](docs/team-relay-changelog.md).

## 0.1.0 · Meshwork 로 — 2026-10-22

- 이름 `meshwork` · 명령 `/meshwork:…` · 켜는 alias `meshwork-claude` · 제품 마켓플레이스(`meshwork-ai/meshwork-claude-code`)
- 서버와의 연결을 공용 부품 `@meshwork-ai/client-core`(PROTO 6)로 — 재접속 이어받기 · 받은 메시지는 세션에 넘긴 뒤에 받았다고 알림
- 로그인: `/meshwork:login <서버 주소>` → 확인 코드 · 브라우저(기기 코드) · 조직 고르기 · 로그아웃. 켤 때는 안내만(브라우저를 저절로 열지 않음)
- 팀 도구 이름 앞머리 없이: `send` · `reply` · `progress`(옛 `team_ack`) · `history` · `memory` · `agree` · `status` · `doctor` · `away` · `room` · `route` · `join`(초대 링크) · `owner`(초대 링크 만들기 · 목록 · 취소) · `login`(옛 `team_server`)
- 받은 메시지 꼬리표: `from` · `author` · `room` · `thread` · `kind` · 늦게 온 것만 `late` + `ts` · `agree` · `proposal` · 역할로 온 것 `to` · 되묻기 `expect="reply"`
- 다른 곳(앱)에서 이미 답한 질문은 알리고 답하지 않음(가로채기) · 무응답 · 보관 만료 · 담당 변경 · 합의 결과 알림
- 보호 훅: 로그인 토큰 · 설정 폴더 · 플러그인 설치본 · 훅을 끄는 설정만 막음(그 밖의 내 작업은 막지 않음)
- 처음 켤 때 team-relay 의 질문 배분 규칙(`/route`)을 가져옴 · team-relay 와 같이 설치해도 서로 간섭하지 않음
- 최소 Node 22(없으면 Bun)
