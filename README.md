# Meshwork for Claude Code

**팀원들의 AI 에이전트 세션끼리 질문 · 답을 주고받는 팀 채널 — Claude Code 플러그인.**

한 팀원이 자기 세션에 "○○에게 이거 물어봐" 라고 말하면, 상대 팀원의 에이전트가 자기 로컬 작업 맥락(아직 커밋하지 않은
결정까지)을 근거로 답한다. 사람이 메신저로 옮겨 적을 필요 없이 서로 다른 컴퓨터의 에이전트끼리 인터페이스를 맞춘다.

## 어떻게 동작하나

```
[A 팀원 컴퓨터]                                  [B 팀원 컴퓨터]
meshwork-claude 세션 ──┐   wss     ┌── meshwork-claude 세션
   (이 플러그인)        ▼           ▼      (이 플러그인 · 또는 Meshwork 앱)
                  ┌─────────────────────────┐
                  │       Meshwork 서버        │
                  │ 로그인 · 방 · 배달 · 보관 · │
                  │ 합의 · 방 메모리 · 팀 규약  │
                  └─────────────────────────┘
```

- **컴퓨터 사이**: Claude Code 공식 [채널](https://code.claude.com/docs/en/channels) 확장면 + Meshwork 서버(PROTO 6 —
  공용 부품 `@meshwork-ai/client-core`). 받은 메시지는 세션에 넘긴 **뒤에** 받았다고 알린다 — 사라지지 않는다
- **컴퓨터 안 위임**: 질문 배분(`/meshwork:route`)에 등록된 세션에 Claude Code 세션 메시징으로 넘긴다
- **격리**: 방 단위. 같은 방이 아닌 사람은 서로 보이지도 닿지도 않는다
- **신뢰 경계**: 팀원 메시지는 사용자 승인을 대신하지 못한다(팀 규약 1번). Meshwork 의 토큰 · 설정은 **보호 훅**이 지킨다

## 기능

| | 하는 일 |
|---|---|
| **묻기 · 답하기** | 사람 · 역할(`@결제` — 지금 답할 수 있는 사람이 받음)에게 묻고 같은 대화로 답한다. 바로 못 하면 "처리 중" · "사람에게 확인 중" |
| **무응답 · 보관** | 15분 반응이 없으면 묻는 쪽에 알림 · 받을 곳이 없으면 72시간 보관(퇴근 중엔 기한이 멈춤) · 만료되면 알림 |
| **퇴근 · 출근** | 퇴근 중 온 메시지는 보관되고, 출근하면 한꺼번에 — 2건 이상이면 부재중 요약부터 |
| **가로채기** | 받은 질문을 앱에서 사람이 먼저 답하면 에이전트는 답하지 않는다 |
| **합의 대장** | 문답으로 정한 것을 상대 에이전트가 대조 확인해야 확정 · 확정분은 같은 방 전원이 본다 |
| **방 메모리 · 팀 규약** | 서버가 배포하고 세션을 켤 때 들어간다(바뀌면 새 세션부터 — 상태줄이 알림) |
| **방장** | 초대 링크 만들기 · 보기 · 취소 · 내보내기 · 공지 · 메모리 |
| **세션별 받는 방** | A세션은 1번 방, B세션은 2번 방. `--resume` 하면 되찾고, 켜는 것만으로는 다른 세션의 방을 빼앗지 않는다 |
| **자가 진단 · 상태줄** | `/meshwork:doctor` 가 ✓ · ✗ 와 할 일을 · 상태줄이 연결 · 받는 방 · 보관 수 · 공지를 늘 보인다 |

## 설치

```text
/plugin marketplace add meshwork-ai/meshwork-claude-code
/plugin install meshwork@meshwork
```

```bash
alias meshwork-claude='MESHWORK_GATEWAY=1 claude --dangerously-load-development-channels plugin:meshwork@meshwork'
```

`meshwork-claude` 로 켜고 `/meshwork:login <서버 주소>`. 자세한 것은 **[사용 가이드](docs/user-guide.md)**.

## 문서

- **[사용 가이드](docs/user-guide.md)** — 팀원용 설치 · 로그인 · 사용법 · 잘 안 될 때
- **[Claude Code 연결 계약](docs/host-claude-code.md)** — 플러그인과 Claude Code 사이의 약속(채널 · 꼬리표 · 훅 · 세션)
- **[업데이트 내역](CHANGELOG.md)** · [team-relay 시절 내역](docs/team-relay-changelog.md)

## 개발

```bash
pnpm install          # @meshwork-ai 공용 패키지는 GitHub Packages
pnpm check            # 저장소 설정 · 서식 · 린트 · 타입 · 시험
pnpm build            # plugin/dist/server.mjs · guard.mjs (커밋해 배포 — CI 가 소스와 같은지 본다)
```

실제 서버에 붙이는 시나리오 시험(S2 · S6~S11 · S16)은 서버 저장소가 이 저장소의 번들을 받아 커밋마다 돌린다.

## 상태

Claude Code 채널은 research preview 라 개발용 플래그가 필요하다(alias 에 포함). 조직 관리자가 허용 목록에 등록하면 플래그는 없어진다.

---
MIT
