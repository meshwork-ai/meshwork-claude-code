/**
 * Claude Code 호스트 — 이 파일이 Claude Code 에 대한 결합의 전부다(연결 계약 `docs/host-claude-code.md`).
 *
 *  · 넣기: `notifications/claude/channel` 로 세션에 넣으면 `<channel …>` 꼬리표가 된다
 *  · 세션 id: `CLAUDE_CODE_SESSION_ID` · 팀 세션: `MESHWORK_GATEWAY=1`(`meshwork-claude` alias 가 선언)
 *  · 작업 폴더: `CLAUDE_PROJECT_DIR` · 세션 이름: 상태줄이 적어 둔 파일(core/state.ts readSessionName)
 */
import { spawn } from 'node:child_process'

import type { Server } from '@modelcontextprotocol/sdk/server/index.js'

import { readSessionName } from '../core/state'
import type { ChoiceSpec, Host } from './types'

declare const Bun: { version: string } | undefined

/** 브라우저로 여는 명령 — 셸을 거치지 않고 인자로 넘긴다(주소가 명령으로 읽히지 않게) */
function browserCommand(url: string): [string, string[]] {
  if (process.platform === 'darwin') return ['open', [url]]
  if (process.platform === 'win32') return ['rundll32', ['url.dll,FileProtocolHandler', url]]
  return ['xdg-open', [url]]
}

/**
 * `mcp` 는 나중에 생긴다 — MCP 안내문(팀 규약)을 정하려면 서버에 먼저 붙어야 해서, 호스트가 MCP 서버보다 먼저 만들어진다.
 * 그 전의 넣기는 플러그인 본체가 MCP 가 붙을 때까지 기다리고, 고르기는 null(글 안내)
 */
export function createClaudeHost(
  mcp: () => Server | undefined,
  o: { home: string; env?: NodeJS.ProcessEnv },
): Host {
  const env = o.env ?? process.env
  return {
    sessionId: env.CLAUDE_CODE_SESSION_ID ?? '',
    isTeam: env.MESHWORK_GATEWAY === '1',
    runtime: typeof Bun !== 'undefined' ? `Bun ${Bun.version}` : `Node ${process.version}`,
    nodeMajor: Number(/^v?(\d+)/.exec(process.versions.node)?.[1] ?? 0),
    workDir: env.CLAUDE_PROJECT_DIR || process.cwd(),
    sessionName: () => readSessionName(o.home),
    async notify(content, meta = {}) {
      const server = mcp()
      if (!server) throw new Error('MCP 가 아직 붙지 않았습니다')
      await server.notification({
        method: 'notifications/claude/channel',
        params: { content, meta },
      })
    },
    /**
     * MCP elicitation — **플러그인이 직접** 대화상자를 띄운다(모델이 끼지 않아 결정적).
     * 지원하지 않는 클라이언트면 null — 부르는 쪽이 글 안내로 내려간다
     */
    async choose(spec: ChoiceSpec): Promise<string | null> {
      const server = mcp()
      if (!server?.getClientCapabilities()?.elicitation) return null
      try {
        const res = await server.elicitInput({
          mode: 'form',
          message: spec.message,
          requestedSchema: {
            type: 'object',
            properties: {
              choice: {
                type: 'string',
                title: spec.title,
                enum: spec.options.map((x) => x.value),
                enumNames: spec.options.map((x) => x.label),
              },
            },
            required: ['choice'],
          },
        })
        if (res.action !== 'accept') return null
        const v = (res.content as { choice?: unknown } | undefined)?.choice
        return typeof v === 'string' && spec.options.some((x) => x.value === v) ? v : null
      } catch {
        return null // 지원한다고 했지만 실패 — 글 안내가 안전하다
      }
    },
    async openBrowser(url: string): Promise<boolean> {
      // https 주소만 — 다른 스킴(file: · javascript: · 앱 딥링크)은 열지 않는다
      let u: URL
      try {
        u = new URL(url)
      } catch {
        return false
      }
      if (u.protocol !== 'https:' || env.MESHWORK_NO_BROWSER === '1') return false
      const [cmd, args] = browserCommand(u.toString())
      return new Promise((resolve) => {
        try {
          const child = spawn(cmd, args, { stdio: 'ignore', detached: true })
          child.once('error', () => resolve(false))
          child.once('spawn', () => {
            child.unref()
            resolve(true)
          })
        } catch {
          resolve(false)
        }
      })
    },
  }
}
