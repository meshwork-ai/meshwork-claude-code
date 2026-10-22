/**
 * Meshwork 자산 보호 — Claude Code 공식 PreToolUse 훅의 판정(PRD §8.4 · 아키텍처 §13 · ADR-43).
 *
 * **Meshwork 가 만든 위험만 막는다.** 플러그인은 누가 턴을 시작했는지 모르므로(03 §5) 그 밖(작업 폴더 밖 · `.git` 삭제 등)을
 * 막으면 내 작업까지 막힌다 — 그것은 엔진과 사용자 설정의 몫이다. 막는 것은 셋:
 *  1. **토큰 · 설정 폴더**(`~/.claude/channels/meshwork/`) 읽기 · 쓰기 — 토큰이 새면 남이 나인 척 방에 들어온다
 *  2. **플러그인 설치본**(훅 스크립트가 든 곳) 고치기 — 문지기를 바꿔치면 1번이 풀린다
 *  3. **훅을 끄는 설정**(`disableAllHooks` · `allowManagedHooksOnly` · 이 플러그인 끄기)
 *
 * 판정은 모든 세션 · 모든 도구에서 돈다(팀 세션이 아니어도 — 토큰은 같은 파일). 판정 중 오류는 **통과**(결정 없음) —
 * 내 작업은 어떤 경우에도 Meshwork 때문에 막히지 않는다(아키텍처 §11.3 판정 순서 · 2026-10-20). 그래서 글에 그 경로가
 * 「보이는」 것만으로는 막지 않고(그 경로를 찾거나 문서에 적는 내 작업), **그 경로를 가리킬 때만** 막는다.
 * 셸 명령은 낱말을 경로로 풀어 본다(따옴표 · `~` · `$HOME` · `/./` · 글롭 · `cd` 뒤 상대 경로 · 상위 폴더 옮기기) —
 * 명령을 다 해석할 수는 없다(플러그인 보안은 team-relay 수준 + 이 훅 — 아키텍처 §13).
 */
import { readFileSync, realpathSync } from 'node:fs'
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

const SEARCH_TOOLS = new Set(['Grep', 'Glob'])
/** 우리 플러그인의 팀 도구 — 판정하지 않는다 */
const OWN_MCP = /^mcp__plugin_meshwork_meshwork__/
/** 폴더를 통째로 옮기거나 · 베끼거나 · 묶거나 · 링크하는 명령 — 그 위 폴더(~/.claude · channels)에 쓰면 그 안을 꺼낼 수 있다 */
const BULK = new Set([
  'mv',
  'cp',
  'ln',
  'tar',
  'rsync',
  'zip',
  'ditto',
  'scp',
  'cpio',
  'find',
  'chmod',
  'chown',
  'rm',
])

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

export function guard(input: GuardInput, o: GuardEnv): string | null {
  const tool = str(input.tool_name)
  const args = input.tool_input
  if (!tool || !args || typeof args !== 'object') return null
  if (OWN_MCP.test(tool)) return null
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
    let cur = resolve(p)
    const rest: string[] = []
    for (;;) {
      try {
        return norm(join(realpathSync(cur), ...rest.slice().reverse()))
      } catch {
        const parent = dirname(cur)
        if (parent === cur) return norm(p)
        rest.push(cur.slice(parent.length).replace(/^[\\/]+/, ''))
        cur = parent
      }
    }
  }
  const expand = (p: string, base = cwd): string => {
    const t = p.trim().replace(/^\$\{?HOME\}?(?=[\\/]|$)/, '~')
    if (t === '~') return home
    if (t.startsWith('~/') || t.startsWith('~\\')) return join(home, t.slice(2))
    return isAbsolute(t) ? t : resolve(base, t)
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
  /** 경로(글롭이어도)가 자산을 가리킬 수 있나 */
  const reaches = (p: string, base = cwd): boolean => {
    const full = expand(p, base)
    if (!/[*?[{]/.test(full)) return inside(real(full), asset)
    return globReaches(full, asset, fold, real)
  }
  /** 자산을 품은 위 폴더 중 ~/.claude 안의 것(~/.claude · ~/.claude/channels) */
  const parentOfAsset = (p: string, base = cwd): boolean => {
    const r = real(expand(p, base))
    return r !== asset && inside(asset, r) && inside(r, claudeDir)
  }

  // ── 파일 도구 ──
  const file = FILE_TOOLS[tool]
  if (file) {
    const p = str(a[file.field])
    if (!p) return null
    if (reaches(p)) return REASON_ASSET
    const target = real(expand(p))
    if (file.write && plugins.some((d) => inside(target, d))) return REASON_PLUGIN
    if (file.write && isSettings(target) && disablesHooks(target, a)) return REASON_HOOKS
    return null
  }

  // ── 찾기 도구 — 찾는 곳(path · glob)만 본다. 찾을 글(pattern)에 그 경로가 있어도 막지 않는다(내 작업) ──
  if (SEARCH_TOOLS.has(tool)) {
    const root = str(a.path) ?? cwd
    if (reaches(root) || parentOfAsset(root)) return REASON_ASSET
    const globs = [str(a.glob), tool === 'Glob' ? str(a.pattern) : undefined].filter(
      (x): x is string => !!x,
    )
    for (const g of globs) if (reaches(g, expand(root))) return REASON_ASSET
    return null
  }

  // ── 셸 — `command` 칸이 있는 도구 모두(Bash · PowerShell · Monitor …) ──
  const cmd = str(a.command)
  if (cmd !== undefined) {
    if (inside(real(cwd), asset)) return REASON_ASSET
    return shellVerdict(cmd, { reaches, parentOfAsset, expand, cwd, plugins, real, inside })
  }

  // ── 그 밖의 도구(다른 MCP 포함) — 경로 꼴의 값이 그 폴더를 가리키면 ──
  for (const v of strings(a)) {
    const t = v.trim()
    if (/^([a-z]:)?[\\/~]|^\$\{?HOME\}?[\\/]/i.test(t) && !/\s/.test(t) && reaches(t))
      return REASON_ASSET
  }
  return null
}

interface ShellCtx {
  reaches(p: string, base?: string): boolean
  parentOfAsset(p: string, base?: string): boolean
  expand(p: string, base?: string): string
  cwd: string
  plugins: string[]
  real(p: string): string
  inside(p: string, dir: string): boolean
}

/** 셸 명령 — 따옴표 · 이스케이프를 걷고 낱말마다 경로로 풀어 본다. `cd` 는 그 뒤 상대 경로의 기준을 바꾼다 */
function shellVerdict(cmd: string, x: ShellCtx): string | null {
  // 훅을 끄는 값을 **설정으로 넣을 때만**(`--settings` · 설정 파일에 쓰기) — 그 낱말을 찾는 내 작업은 막지 않는다
  if (hooksOffInText(cmd) && /--settings\b|(settings(\.local)?|managed-settings)\.json/i.test(cmd))
    return REASON_HOOKS
  if (/\bplugin\s+(disable|uninstall|remove)\b[^\n;&|]*\bmeshwork\b/i.test(cmd)) return REASON_HOOKS
  const clean = cmd
    .replace(/\\(.)/g, '$1')
    .replace(/["']/g, '')
    .replace(/\$\{HOME\}|\$HOME/g, '~')
    .replace(/([\\/])\.(?=[\\/])/g, '$1')
    .replace(/([\\/]){2,}/g, '$1')
  // 명령 경계로 나눈다 — 앞 명령의 cd 가 뒤 명령의 기준이 된다
  let base = x.cwd
  for (const part of clean.split(/&&|\|\||[;|&\n]/)) {
    const words = part.trim().split(/\s+/).filter(Boolean)
    if (!words.length) continue
    const verb = (words[0] ?? '').replace(/^.*[\\/]/, '')
    const bulk = BULK.has(verb)
    for (const w0 of words.slice(1)) {
      // `--file=~/.claude/...` · `if=…` 처럼 = 뒤의 경로도
      const w = w0.replace(/^[^=~/\\$]*=/, '')
      // 경로처럼 보이는 낱말만(빠르게) — 통째로 옮기는 명령은 상대 이름(`channels`)도
      if (!bulk && !/[\\/~]|\.claude|meshwork|tokens\.json/i.test(w)) continue
      if (w.startsWith('-')) continue
      if (x.reaches(w, base)) return REASON_ASSET
      if (bulk && x.parentOfAsset(w, base)) return REASON_ASSET
      const r = x.real(x.expand(w, base))
      if (x.plugins.some((d) => x.inside(r, d))) return REASON_PLUGIN
    }
    if ((verb === 'cd' || verb === 'pushd') && words[1]) base = x.expand(words[1], base)
  }
  return null
}

/** 글롭 경로가 자산을 가리킬 수 있나 — 마디마다 맞춰 본다(`**` 는 몇 마디든) */
function globReaches(
  full: string,
  asset: string,
  fold: boolean,
  real: (p: string) => string,
): boolean {
  const split = (p: string) => p.split(/[\\/]+/).filter((s, i) => s || i === 0)
  const g = split(fold ? full.toLowerCase() : full)
  // 글롭 앞의 고정된 부분은 실제 경로로(심볼릭 링크)
  const first = g.findIndex((s) => /[*?[{]/.test(s))
  const fixed = real(g.slice(0, first).join('/') || '/')
  const pat = [...split(fixed), ...g.slice(first)]
  const target = split(asset)
  const seg = (s: string) =>
    new RegExp(
      `^${s
        .replace(/[.+^$()|\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.')
        .replace(/\{([^}]*)\}/g, (_m, alts: string) => `(${alts.split(',').join('|')})`)}$`,
    )
  const walk = (i: number, j: number): boolean => {
    if (j >= target.length) return true // 자산 폴더까지 맞았다 — 그 안을 가리킨다
    if (i >= pat.length) return false
    if (pat[i] === '**') return walk(i + 1, j) || walk(i, j + 1)
    return seg(pat[i]!).test(target[j]!) && walk(i + 1, j + 1)
  }
  return walk(0, 0)
}

/** Claude Code 설정 파일 — 사용자 · 프로젝트 · 로컬 · 관리 설정 */
function isSettings(p: string): boolean {
  return /(^|[\\/])(settings(\.local)?|managed-settings)\.json$/i.test(p)
}

/** 설정에서 훅 · 이 플러그인을 끄는 값 */
function offIn(obj: unknown): { hooksOff: boolean; pluginOff: boolean; pluginOn: boolean } {
  const o = (obj && typeof obj === 'object' ? obj : {}) as Record<string, unknown>
  const plugins = (
    o.enabledPlugins && typeof o.enabledPlugins === 'object' ? o.enabledPlugins : {}
  ) as Record<string, unknown>
  return {
    hooksOff: !!o.disableAllHooks || !!o.allowManagedHooksOnly,
    pluginOff: plugins['meshwork@meshwork'] === false,
    pluginOn: plugins['meshwork@meshwork'] === true,
  }
}

/**
 * 설정 파일을 고친 결과가 훅이나 이 플러그인을 끄나 — JSON 으로 풀어 본다(`A` 같은 이스케이프로 숨겨도).
 * Edit · MultiEdit 는 지금 파일에 고침을 적용해 전후를 견준다(켜져 있던 이 플러그인 줄을 지우는 것도)
 */
function disablesHooks(path: string, a: Record<string, unknown>): boolean {
  const read = (): string | null => {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return null
    }
  }
  const parse = (t: string): unknown => {
    try {
      return JSON.parse(t)
    } catch {
      return undefined
    }
  }
  let before: string | null = null
  let after: string
  if (typeof a.content === 'string') after = a.content
  else {
    before = read()
    const edits: { old_string?: unknown; new_string?: unknown; replace_all?: unknown }[] =
      Array.isArray(a.edits) ? (a.edits as never[]) : [a as never]
    let t = before ?? ''
    for (const e of edits) {
      if (typeof e.old_string !== 'string' || typeof e.new_string !== 'string') continue
      t = e.replace_all
        ? t.split(e.old_string).join(e.new_string)
        : t.replace(e.old_string, () => e.new_string as string)
    }
    after = t
  }
  const was = before === null ? null : parse(before)
  const now = parse(after)
  // JSON 으로 못 풀면(파일이 없음 · 주석 · 반쯤 고침) 쓰려는 글로 본다
  if (now === undefined) return hooksOffInText(writtenText(a))
  const n = offIn(now)
  if (n.hooksOff || n.pluginOff) return true
  if (was !== undefined && was !== null && offIn(was).pluginOn && !n.pluginOn) return true
  return false
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

/** 글에 훅 · 이 플러그인을 끄는 값이 보이나 — `\uXXXX` 이스케이프를 풀고 */
function hooksOffInText(text: string): boolean {
  const t = text.replace(/\\u([0-9a-fA-F]{4})/g, (_m, h: string) =>
    String.fromCharCode(parseInt(h, 16)),
  )
  if (/disableAllHooks|allowManagedHooksOnly/i.test(t)) return true
  return /["']?meshwork@meshwork["']?\s*:\s*false/i.test(t)
}

/** 객체 안의 문자열 값 전부(깊이 제한) */
function strings(v: unknown, depth = 0, out: string[] = []): string[] {
  if (depth > 6 || out.length > 200) return out
  if (typeof v === 'string') out.push(v)
  else if (Array.isArray(v)) for (const x of v) strings(x, depth + 1, out)
  else if (v && typeof v === 'object') for (const x of Object.values(v)) strings(x, depth + 1, out)
  return out
}
