/**
 * Meshwork 자산 보호 — Claude Code 공식 PreToolUse 훅의 판정(PRD §8.4 · 아키텍처 §13 · ADR-43).
 *
 * **Meshwork 가 만든 위험만 막는다.** 플러그인은 누가 턴을 시작했는지 모르므로(03 §5) 그 밖(작업 폴더 밖 · `.git` 삭제 등)을
 * 막으면 내 작업까지 막힌다 — 그것은 엔진과 사용자 설정의 몫이다. 막는 것은 셋:
 *  1. **토큰 · 설정 폴더**(`~/.claude/channels/meshwork/`) 읽기 · 쓰기 — 토큰이 새면 남이 나인 척 방에 들어온다
 *  2. **플러그인 설치본**(훅 스크립트가 든 곳) 고치기 — 문지기를 바꿔치면 1번이 풀린다
 *  3. **훅을 끄는 설정**(`disableAllHooks` · `allowManagedHooksOnly` · 이 플러그인 끄기)
 *
 * 판정은 모든 세션에서 돈다(팀 세션이 아니어도 — 토큰은 같은 파일). 판정 중 오류는 **통과**(결정 없음) —
 * 내 작업은 어떤 경우에도 Meshwork 때문에 막히지 않는다(아키텍처 §11.3 판정 순서 · 2026-10-20).
 * Bash 는 명령 글자에 그 경로가 보이는지로만 본다 — 명령을 다 해석할 수는 없다(플러그인 보안은 team-relay 수준 + 이 훅).
 */
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'

import { meshworkHome } from './paths'

export interface GuardInput {
  tool_name?: unknown
  tool_input?: unknown
  cwd?: unknown
}

export interface GuardEnv {
  env: NodeJS.ProcessEnv
  home?: string
  platform?: NodeJS.Platform
}

const REASON_ASSET =
  'Meshwork 보호 — 로그인 토큰 · 설정 폴더(~/.claude/channels/meshwork)는 읽거나 바꿀 수 없습니다. 로그인 · 설정은 /meshwork:login · /meshwork:status 같은 명령으로 하세요.'
const REASON_PLUGIN =
  'Meshwork 보호 — Meshwork 플러그인 설치본은 고칠 수 없습니다. 업데이트는 /plugin 에서 하세요.'
const REASON_HOOKS =
  'Meshwork 보호 — 훅을 끄거나 Meshwork 플러그인을 끄는 설정은 바꿀 수 없습니다. 필요하면 사용자가 직접 바꾸세요.'

/** 파일을 가리키는 도구 — 경로 칸 */
const FILE_TOOLS: Record<string, { field: string; write: boolean }> = {
  Read: { field: 'file_path', write: false },
  Write: { field: 'file_path', write: true },
  Edit: { field: 'file_path', write: true },
  MultiEdit: { field: 'file_path', write: true },
  NotebookRead: { field: 'notebook_path', write: false },
  NotebookEdit: { field: 'notebook_path', write: true },
  LS: { field: 'path', write: false },
}

const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])
const SEARCH_TOOLS = new Set(['Grep', 'Glob'])
/** 우리 플러그인의 팀 도구 — 판정하지 않는다 */
const OWN_MCP = /^mcp__plugin_meshwork_meshwork__/

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

export function guard(input: GuardInput, o: GuardEnv): string | null {
  const tool = str(input.tool_name)
  const args = input.tool_input
  if (!tool || !args || typeof args !== 'object') return null
  const a = args as Record<string, unknown>
  const platform = o.platform ?? process.platform
  const fold = platform === 'darwin' || platform === 'win32'
  const home = o.home ?? homedir()
  const cwd = str(input.cwd) ?? process.cwd()

  const norm = (p: string): string => {
    const x = resolve(p).replace(/[\\/]+$/, '') || sep
    return fold ? x.toLowerCase() : x
  }
  /** 실제 경로 — 있는 데까지 심볼릭 링크를 풀고 나머지를 붙인다(링크로 돌아 들어오는 것을 막으려고) */
  const real = (p: string): string => {
    let cur = p
    const rest: string[] = []
    for (;;) {
      try {
        return norm(join(realpathSync(cur), ...rest.reverse()))
      } catch {
        const parent = dirname(cur)
        if (parent === cur) return norm(p)
        rest.push(cur.slice(parent.length).replace(/^[\\/]+/, ''))
        cur = parent
      }
    }
  }
  const expand = (p: string): string => {
    const t = p.trim()
    if (t === '~') return home
    if (t.startsWith('~/') || t.startsWith('~\\')) return join(home, t.slice(2))
    return isAbsolute(t) ? t : resolve(cwd, t)
  }
  /** p 가 dir 이거나 그 안인가 — 둘 다 norm 을 거친 값 */
  const inside = (p: string, dir: string): boolean =>
    p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep)

  const asset = real(meshworkHome(o.env, home))
  const claudeDir = real(join(home, '.claude'))
  const plugins = [
    join(home, '.claude', 'plugins', 'cache', 'meshwork'),
    join(home, '.claude', 'plugins', 'marketplaces', 'meshwork'),
    ...(o.env.CLAUDE_PLUGIN_ROOT ? [o.env.CLAUDE_PLUGIN_ROOT] : []),
  ].map(real)
  const touchesAsset = (p: string): boolean => inside(real(expand(p)), asset)

  // ── 파일 도구 ──
  const file = FILE_TOOLS[tool]
  if (file) {
    const p = str(a[file.field])
    if (!p) return null
    const target = real(expand(p))
    if (inside(target, asset)) return REASON_ASSET
    if (file.write && plugins.some((d) => inside(target, d))) return REASON_PLUGIN
    if (file.write && isSettings(target) && disablesHooks(writtenText(a))) return REASON_HOOKS
    return null
  }

  // ── 찾기 도구 — 그 폴더 안이거나, ~/.claude 쪽 위 폴더에서 찾으면(숨은 폴더 안으로 들어감) ──
  if (SEARCH_TOOLS.has(tool)) {
    const root = real(expand(str(a.path) ?? cwd))
    if (inside(root, asset)) return REASON_ASSET
    if (inside(asset, root) && inside(root, claudeDir)) return REASON_ASSET
    for (const pat of [str(a.pattern), str(a.glob)]) {
      if (pat && mentionsAsset(pat, fold)) return REASON_ASSET
      if (tool === 'Glob' && pat && isAbsolute(pat) && touchesAsset(staticPrefix(pat)))
        return REASON_ASSET
    }
    return null
  }

  // ── 셸 — 명령 글자에 보이는 것만 ──
  if (SHELL_TOOLS.has(tool)) {
    const cmd = str(a.command)
    if (!cmd) return null
    const c = fold ? cmd.toLowerCase() : cmd
    if (mentionsAsset(cmd, fold) || c.includes(asset)) return REASON_ASSET
    if (/plugins[\\/](cache|marketplaces)[\\/]meshwork\b/i.test(cmd)) return REASON_PLUGIN
    if (disablesHooks(cmd)) return REASON_HOOKS
    if (/\bplugin\s+(disable|uninstall|remove)\b[^\n;&|]*\bmeshwork\b/i.test(cmd))
      return REASON_HOOKS
    return null
  }

  // ── 다른 MCP 도구 — 어느 값에든 그 폴더가 보이면 ──
  if (tool.startsWith('mcp__') && !OWN_MCP.test(tool)) {
    for (const v of strings(a)) {
      if (mentionsAsset(v, fold)) return REASON_ASSET
      if (/^([a-z]:)?[\\/~]/i.test(v.trim()) && touchesAsset(v)) return REASON_ASSET
    }
  }
  return null
}

/** 글자에 그 폴더가 보이나 — `~/.claude/channels/meshwork` · `$HOME/…` · 상대 경로 꼴 모두 `channels/meshwork` 를 품는다 */
function mentionsAsset(text: string, fold: boolean): boolean {
  const t = fold ? text.toLowerCase() : text
  return /channels[\\/]+meshwork(?![\w-])/.test(t)
}

/** Claude Code 설정 파일 — 사용자 · 프로젝트 · 로컬 · 관리 설정 */
function isSettings(p: string): boolean {
  return /(^|[\\/])(settings(\.local)?|managed-settings)\.json$/i.test(p)
}

/** 쓰려는 글 — Write 의 content · Edit 의 new_string · MultiEdit 의 edits[].new_string */
function writtenText(a: Record<string, unknown>): string {
  const parts = [str(a.content), str(a.new_string)]
  if (Array.isArray(a.edits)) {
    for (const e of a.edits)
      if (e && typeof e === 'object') parts.push(str((e as Record<string, unknown>).new_string))
  }
  return parts.filter(Boolean).join('\n')
}

/** 훅 · 이 플러그인을 끄는 설정 */
function disablesHooks(text: string): boolean {
  if (/disableAllHooks|allowManagedHooksOnly/i.test(text)) return true
  return /["']meshwork@meshwork["']\s*:\s*false/i.test(text)
}

/** Glob 꼴의 고정된 앞부분 — 첫 와일드카드 앞 폴더 */
function staticPrefix(pattern: string): string {
  const i = pattern.search(/[*?[{]/)
  return i < 0 ? pattern : dirname(pattern.slice(0, i) + 'x')
}

/** 객체 안의 문자열 값 전부(깊이 제한) */
function strings(v: unknown, depth = 0, out: string[] = []): string[] {
  if (depth > 6 || out.length > 200) return out
  if (typeof v === 'string') out.push(v)
  else if (Array.isArray(v)) for (const x of v) strings(x, depth + 1, out)
  else if (v && typeof v === 'object') for (const x of Object.values(v)) strings(x, depth + 1, out)
  return out
}
