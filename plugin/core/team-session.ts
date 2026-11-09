/**
 * 팀 세션인가 — 부모 claude 의 실행 명령으로 판단한다(채널 플래그 + 이 플러그인 · 한 번 묻고 끝나는 실행은 아님).
 *
 * 예전에는 별칭이 환경 변수(`MESHWORK_GATEWAY=1`)로 알렸는데, 그 세션 안에서 켠 다른 claude 가 변수를 물려받아 받는 쪽을
 * 가져갔고 · 변수만 켜고 채널 플래그를 빠뜨리면 메시지가 조용히 버려졌다(Claude Code 는 채널로 등록되지 않은 세션의 알림을
 * 오류 없이 버린다). 채널 플래그가 곧 「이 세션에 메시지가 들어간다」 는 뜻이라 그것 하나로 본다.
 *
 * MCP 서버(run.sh 가 exec)와 상태줄의 부모가 그 claude 다 — `ps -o args= -p <부모>` 로 읽는다(실측 2.1.314)
 */
import { execFileSync } from 'node:child_process'

/** team — 팀 세션 · 그 밖은 아닌 까닭(doctor 가 알린다) */
export type TeamCheck = 'team' | 'no-channel' | 'other-channel' | 'print' | 'unknown'

const CHANNEL_FLAGS = ['--channels', '--dangerously-load-development-channels']

export function teamFromArgs(args: string): TeamCheck {
  const words = args.trim().split(/\s+/).filter(Boolean)
  if (!words.length) return 'unknown'
  const channel = words.some((w) => CHANNEL_FLAGS.some((f) => w === f || w.startsWith(`${f}=`)))
  if (!channel) return 'no-channel'
  if (words.includes('-p') || words.includes('--print')) return 'print'
  return args.includes('plugin:meshwork@') ? 'team' : 'other-channel'
}

/** 부모 프로세스의 실행 명령 — 못 읽으면 빈 글. 시험은 MESHWORK_TEST_PARENT_ARGS 로 흉내 낸다 */
export function parentArgs(env: NodeJS.ProcessEnv = process.env, ppid = process.ppid): string {
  const fake = env.MESHWORK_TEST_PARENT_ARGS
  if (fake !== undefined) return fake
  try {
    if (process.platform === 'win32')
      return execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${ppid}").CommandLine`,
        ],
        { encoding: 'utf8', timeout: 5000, windowsHide: true },
      ).trim()
    return execFileSync('ps', ['-o', 'args=', '-p', String(ppid)], {
      encoding: 'utf8',
      timeout: 5000,
    }).trim()
  } catch {
    return ''
  }
}
