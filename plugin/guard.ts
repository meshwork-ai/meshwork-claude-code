/**
 * PreToolUse 훅 입구 — Claude Code 가 도구를 쓰기 전에 부른다(`hooks/hooks.json` → `guard.sh` → `dist/guard.mjs`).
 * 표준 입력의 JSON(tool_name · tool_input · cwd)을 읽어 Meshwork 자산을 건드리면 거부를 낸다(판정은 core/guard.ts).
 *
 * **오류 · 모르는 입력은 아무 말 없이 끝낸다(통과)** — 내 작업은 어떤 경우에도 Meshwork 때문에 막히지 않는다.
 * 거부는 공식 JSON 꼴(`permissionDecision: "deny"`) — 권한 무시 모드여도 훅의 거부가 이긴다(1-a 실측).
 */
import { guard } from './core/guard'

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

try {
  const input = JSON.parse(await readStdin()) as Record<string, unknown>
  const reason = guard(input, { env: process.env })
  if (reason) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: reason,
        },
      }),
    )
  }
} catch {
  // 판정하지 못함 — 결정 없이 끝낸다(일반 권한 흐름 그대로)
}
