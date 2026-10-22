/**
 * 호스트 경계 — 이 플러그인이 "어느 에이전트 안에서 도는가" 에 기대는 **전부**.
 *
 * 앱(app/)은 서버와의 대화만 알고, 사용자에게 무언가를 보여 주거나 세션을 알아보는 일은 전부 이 인터페이스를 통한다.
 * 다른 호스트를 붙이면 구현체 하나만 더한다(연결 계약 `docs/host-claude-code.md`).
 */
export interface Host {
  /** 이 세션의 id — 받는 방 기억의 열쇠. 모르면 빈 문자열 */
  readonly sessionId: string
  /** 팀 세션인가 — `meshwork-claude` 로 켠 세션만 서버에 붙는다(PRD §8.4) */
  readonly isTeam: boolean
  /** 런타임 표시 — 진단용 */
  readonly runtime: string
  /** 런타임의 Node 호환 판(주 버전) — bun 이면 그 bun 이 흉내 내는 Node 판 */
  readonly nodeMajor: number
  /** 작업 폴더 — 세션을 열 때 서버에 알린다(조직 콘솔의 활동 기록이 "어느 세션" 을 사람 말로) */
  readonly workDir: string
  /** 세션 이름(/rename 등) — 세션 도중에 바뀔 수 있어 매번 읽는다. 모르면 undefined */
  sessionName(): string | undefined
  /**
   * 세션에 넣는 **유일한 출구**. Claude Code 는 채널 알림으로 넣는다.
   * 약속은 호스트에 넘긴 뒤 풀린다 — 넘기지 못하면 거절(받았다는 알림(ack)을 하지 않게 — 연결 계약 §6)
   */
  notify(content: string, meta?: Record<string, string>): Promise<void>
  /** 사람에게 묻는 상자를 띄울 수 있나(MCP elicitation) — 사람만 답할 수 있다(에이전트는 답하지 못함) */
  canAsk(): boolean
  /** 선택지를 띄워 하나를 받는다. 대화형 화면이 없거나 취소하면 null — 부르는 쪽은 글 안내로 내려간다 */
  choose(spec: ChoiceSpec): Promise<string | null>
  /** 시스템 브라우저로 https 주소를 연다 — 못 열면 false(주소를 글로 보여 준다) */
  openBrowser(url: string): Promise<boolean>
}

export interface ChoiceSpec {
  /** 대화상자 위 문구 */
  message: string
  /** 칸 이름 */
  title: string
  /** 선택지 — value 는 부르는 쪽이 해석하는 값, label 은 사람이 읽는 줄 */
  options: Array<{ value: string; label: string }>
}
