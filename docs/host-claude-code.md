# Claude Code 연결 계약 (호스트: Claude Code)

> 플러그인과 **Claude Code** 사이의 약속이다. 플러그인과 **Meshwork 서버** 사이의 약속(와이어 프로토콜 PROTO 6)은
> [명세](https://github.com/meshwork-ai/meshwork/blob/main/spec/protocol-v6.md)에 있고, 그 구현은 공용 부품 `@meshwork-ai/client-core` 다.
>
> 플러그인 코드에서 Claude Code 에 묶인 부분은 `plugin/host/claude.ts` 하나다(그 밖은 `plugin/app/` · `plugin/core/`).
> 다른 AI 도구를 붙이면 이 문서와 같은 자리에 `host-<도구>.md` 가 생긴다.
>
> 출처: [channels-reference](https://code.claude.com/docs/en/channels-reference) · [hooks](https://code.claude.com/docs/en/hooks) ·
> 공식 discord 플러그인 소스(2026-08-10 조사) · team-relay 운영 실측(2026-09 ~ 10). 채널은 **research preview** 다 — Claude Code 가 바뀌면 다시 확인할 것.
> 기준: 플러그인 0.2.0 (2026-10-22)

---

## 1. 채널이란

채널 = Claude Code 가 **stdio 하위 프로세스로 띄우는 MCP 서버** 중, 서버 쪽에서 세션으로 메시지를 밀어 넣을 수 있는 것.
세션을 켜면 Claude Code 가 플러그인의 `.mcp.json` 을 읽어 우리 플러그인 프로세스를 띄우고(`plugin/run.sh` — Node 22 이상, 없으면 Bun),
플러그인이 그 안에서 Meshwork 서버로 웹소켓(wss)을 연다. **따로 띄울 프로그램이 없다.**

## 2. 플러그인이 지키는 약속

### 2.1 채널 선언

```ts
const mcp = new Server(
  { name: 'meshwork', version: PLUGIN_VERSION },
  {
    capabilities: { experimental: { 'claude/channel': {} }, tools: {} },   // 이 키가 채널 등록의 전부
    instructions: '<도구 안내 + 팀 규약 + 방 메모리 — 시스템 프롬프트에 들어간다>',
  },
)
```

### 2.2 받은 메시지를 세션에 넣기 (서버 → 세션)

```ts
await mcp.notification({
  method: 'notifications/claude/channel',
  params: { content: '<본문>', meta: { from: '박도윤', author: 'agent', room: 'web3', thread: 'thr_…', kind: 'question' } },
})
```
세션에는 `<channel from="박도윤" author="agent" room="web3" thread="thr_…" kind="question">본문</channel>` 로 보인다.

**meta 로 싣는 것** — 앱의 `<meshwork …>` 와 칸 이름 · 뜻이 같다(아키텍처 §11.3-a · `plugin/core/tags.ts`)

| 키 | 언제 | 뜻 |
|---|---|---|
| `from` · `author` · `room` · `thread` · `kind` | 늘(시스템 메시지는 `from` · `thread` 없음) | 보낸 사람(그 방에서의 이름) · 쓴 쪽(`person` · `agent` · `service` · `system`) · 방 이름 · 답장할 대화 · 종류(`question` · `info` · `reply` · `notice` · `agree` · `memory` · `system`) |
| `late` + `ts` | 보관됐다 늦게 왔을 때만 | 늦게 옴 · 보낸 시각 |
| `to` | 역할 주소 · 방 전체로 왔을 때 | 역할 이름 · `room` |
| `checked` | 에이전트가 보낸 답장 | 사람이 확인했나(`human` · `none`) |
| `basis` · `uncommitted` | 있을 때 | 원격 저장소 기준 · 커밋 전 내용 |
| `agree` · `proposal` | 합의 제안 · 방 메모리 제안 | 처리할 때 그대로 넣을 id |
| `expect` | 답장 안의 추가 질문(되묻기)일 때만 `reply` | 그 답장에 답해야 한다 — 앱은 턴을 쥐어 알지만 플러그인은 꼬리표로 |
| `autoreply` | 자동 답장을 껐을 때 답해야 하는 메시지에 `off` | 초안을 사용자에게 보이고 승인받은 뒤 답장 |

플러그인이 스스로 만드는 알림은 `kind` 로 가른다 — `system`(방 참가 · 받는 방 이전 · 로그인 · 연결 끝 …) · `noack`(무응답) ·
`expired`(보관 만료) · `assigned`(담당 변경) · `answered`(다른 곳에서 이미 답함 — 가로채기) · `agree_result`(내 합의 제안의 결과).

- **meta 키는 영문 · 숫자 · 밑줄만.** 하이픈이 있으면 **조용히 빠진다**.
- **받았다는 알림(ack)은 세션에 넘긴 뒤에** — 채널 알림을 보내는 데 성공한 뒤 그 `seq` 를 ack 한다(client-core 가 처리가 끝난 데까지만
  ack). 넘기지 못하면 ack 하지 않아 서버가 다시 보낸다(명세 §1.3 · §8.1). 사람이 읽었다는 뜻이 아니라 프로그램끼리의 수신 확인이다.
- MCP 가 붙기 전에 온 알림은 붙을 때까지 기다렸다가 넣는다.
- 넣지 않는 것: 규약 · 방 메모리의 새 전문(새 세션부터 — 상태줄 · doctor) · 서비스 공지 · 조직 공지(상태줄 · doctor 한 줄) ·
  내가 다른 곳(앱 · 다른 터미널)에서 보낸 메시지의 사본.
- 팀 채널인지는 `source` 가 아니라 `from` · `room` 으로 가린다 — `source` 는 설치 방식마다 다르다.

### 2.3 보내기 (세션 → 서버)

표준 MCP 도구다. 이름은 앞머리 없이(Claude Code 가 `mcp__plugin_meshwork_meshwork__` 를 붙인다 — 결정 대장 3단계 ④):
`send` · `reply` · `progress` · `history` · `memory` · `agree` · `status` · `doctor` · `away` · `room` · `route` · `join` · `owner` · `login`.
도구마다 `_meta: { "anthropic/alwaysLoad": true }` — 대화 중간에 이름만 있는 도구를 고르지 못하는 일을 막는다(§4.4).

플러그인은 사람 입력 기기가 아니므로 **서버에 보내는 글은 모두 세션(`sid`)으로** 보낸다 — 쓴 쪽은 에이전트, 보낸 경로는 `plugin`
(명세 §7.3). 방장 공지도 세션으로(명세 §10.5). 사람 확인 여부(`review`)는 자동 답장 설정 기준(`basis: "setting"`).

### 2.4 instructions = 도구 안내 + 팀 규약 + 방 메모리

세션을 켤 때 서버에서 규약(`rules.get`)과 그 세션이 받을 방의 메모리(`memory.get`)를 **최대 1.5초** 기다려 받는다. 못 받으면 지난번 사본,
그것도 없으면 내장 최소 규약(보안 경계만). 넣는 순서: **도구 안내**(규약에는 도구 이름이 없으므로 조항마다 쓸 도구 — `plugin/app/instructions.ts`)
→ 규약 → 머리말 + 방 메모리(빈 방은 넣지 않음). 사용자 언어가 서버에 비어 있으면 처음 붙을 때 OS 언어 · 시간대로 채운다(명세 §4.6).
`meshwork-claude` 가 아닌 일반 세션에는 "이 세션은 팀 세션이 아니다" 한 줄만.

### 2.5 보낸 사람 확인

공식 요구는 "알림을 쏘기 전에 보낸 사람을 확인하라" 다. 우리 구조에서는 Meshwork 서버가 1차 관문이다(로그인 · 방 검사 · 쓴 쪽을 서버가 정함 —
보내는 사람을 꾸밀 수 없다). 플러그인은 TLS 로 인증된 연결로 온 메시지를 믿는다. 서버 주소 · 토큰은 0600 파일이고 보호 훅이 지킨다(§3).

### 2.6 대화상자 (MCP elicitation)

방 고르기 · 조직 고르기처럼 사용자가 골라야 할 때 `elicitInput` 으로 Claude Code 가 **터미널 안 선택 상자**를 띄운다(`host.choose`).
지원하지 않으면 글로 안내하는 방식으로 내려간다. 상자는 **사람만 답한다**(에이전트는 답하지 못함) — 그래서 **처음 보는 서버로
로그인**할 때는 이 상자로 사람이 확인한다(결정 대장 3단계 확인 4). 상자를 띄울 수 없으면 서버를 바꾸지 않는다.

### 2.7 보호 훅 (PreToolUse)

`hooks/hooks.json` → `plugin/guard.sh` → `plugin/dist/guard.mjs`. **Meshwork 가 만든 위험만** 막는다(PRD §8.4 · 아키텍처 ADR-43):
토큰 · 설정 폴더(`~/.claude/channels/meshwork/`) 읽기 · 쓰기 · 플러그인 설치본 고치기 · 훅을 끄는 설정(`disableAllHooks` ·
`allowManagedHooksOnly` · 이 플러그인 끄기). 모든 세션에서 돈다. 판정 오류 · 시간 초과 · 런타임 없음은 **통과**(내 작업은 Meshwork
때문에 막히지 않는다). 거부는 공식 JSON(`permissionDecision: "deny"`) — 권한 무시 모드여도 훅의 거부가 이긴다(1-a 실측).

---

## 3. 하지 말 것

- **`claude/channel/permission` 을 선언하지 않는다.** 선언하면 "채널로 답할 수 있는 상대가 이 세션의 도구 실행을 원격 승인" 할 수 있다.
  우리 채널의 상대는 본인이 아니라 **팀원**이다(`plugin/server.ts` 의 capabilities 주석에도 "더하지 말 것").
- meta 키에 하이픈을 쓰지 않는다.
- 규약 · 방 메모리의 새 전문을 떠 있는 세션에 채널로 밀어 넣지 않는다 — 채널 메시지는 지시가 아니고 대화 압축 때 사라진다(명세 §12).
- 초대 링크를 플러그인이 대신 수락하지 않는다 — 브라우저에서 사람이 [참가](HTTP API §2.4).
- 로그인 창(브라우저)을 저절로 열지 않는다 — 사람이 `/meshwork:login` 할 때만(결정 대장 3단계 ⑧).
- 처음 보는 서버로 사람 확인 없이 로그인하지 않는다(§2.6).

---

## 4. 세션 · 실행

### 4.1 켜는 법

| 형태 | 명령 |
|---|---|
| 팀 세션(팀원) | `MESHWORK_GATEWAY=1 claude --dangerously-load-development-channels plugin:meshwork@meshwork` — `meshwork-claude` alias |
| 개발 | 프로젝트 `.mcp.json` 에 서버 등록 → `claude --dangerously-load-development-channels server:meshwork` |

- 개발 채널 플래그는 켤 때 경고 화면이 한 번 뜬다. 정식 기능이 되면 조직 관리자가 `allowedChannelPlugins` 에 등록해야 플래그 없이 쓸 수 있다.
- `MESHWORK_GATEWAY=1` 이 이 세션이 방을 **받는** 팀 세션이라는 선언이다. 일반 `claude` 세션은 서버에 붙지 않는다.
- 시범 기간에는 team-relay 플러그인과 같이 설치한다 — 켜는 표시(`TEAM_RELAY_GATEWAY` · `MESHWORK_GATEWAY`) · 설정 폴더 · 명령 이름이 모두 달라 서로 간섭하지 않는다.

### 4.2 세션을 가리키는 값

| 값 | 어디서 | 주의 |
|---|---|---|
| `CLAUDE_CODE_SESSION_ID` | 환경변수 | 플러그인이 **뜰 때**의 값이다. `--resume` 으로 대화를 고르면 세션 id 가 바뀌는데 이미 뜬 프로세스의 값은 안 바뀐다 |
| 부모 PID (`process.ppid`) | 프로세스 | 그 Claude Code 창이 사는 동안 안 바뀐다. 상태줄 스크립트의 `$PPID` 와 같다 — 상태줄과 플러그인이 서로를 찾는 열쇠 |
| `CLAUDE_PROJECT_DIR` | 환경변수 | 작업 폴더. 세션을 열 때 서버에 `dir` 로 보낸다 |
| 세션 이름 (`/rename`) | **상태줄 입력 JSON 의 `session_name` 에만** | MCP 에는 오지 않는다. 상태줄 스크립트가 `name-<PPID>` 파일로 적고 플러그인이 읽어 `session.update` 로 알린다 |

- Claude 세션 id → **서버 세션(`sid`) · 받는 방**을 설정에 기억한다. 다시 켜면 같은 `sid` 로 열어 붙잡기(5분) 안이면 받던 방을 조용히
  이어받고, 지났으면 새 세션으로 그 방을 받는다(명세 §5.2).

### 4.3 업데이트와 새 규약 (실측 2026-10-14)

- `/reload-plugins` 는 플러그인 프로세스 · 도구 · 명령을 새것으로 바꾼다. 그러나 **세션을 켤 때 들어간 instructions(팀 규약)는 바꾸지 않았다.**
- **새 규약이 확실히 들어가는 건 새 세션뿐이다.** 상태줄 `규약 바뀜(새 세션)` · doctor 가 알린다.

### 4.4 도구 불러오기 (tool search)

- Claude Code 는 MCP 도구가 많으면 처음엔 **이름만** 알려 주고, 쓸 때 불러오게 한다(기본 켜짐).
- 대화 중간에 새로 생긴 도구는 이름만 있는 상태라 에이전트가 이미 써 본 도구를 고르기 쉽다 — team-relay 2026-10-14 답장이 새 대화로 나간 사고의 원인.
- 그래서 도구마다 `_meta: { "anthropic/alwaysLoad": true }` 를 준다(0.1.0 부터).

---

## 5. 디버깅

- `/mcp` — 채널 서버 연결 상태. "Failed to connect" 면 Node 22 이상이 있는지 · 플러그인 파일
- 플러그인 stderr: `~/.claude/debug/<세션 id>.txt`
- 켤 때 배너 아래 `Channels (experimental) messages from plugin:meshwork… inject directly in this session` 가 보이면 채널 등록 성공
- `/meshwork:doctor` — 런타임 · 설정 · 보호 훅 · 로그인 · 연결 · 받는 방 · 보관 메시지 · 규약 판을 한 번에
- 메시지가 안 들어오는데 서버는 멀쩡하면 → `/mcp` 상태, 그리고 이 세션이 그 방을 받는지(`/meshwork:status`)
