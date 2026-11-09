/**
 * 채널 도착 확인(⑨ 수정 B) — Claude Code 는 채널로 등록되지 않은 세션 · 조직 정책으로 막힌 세션의 알림을 **오류 없이 버린다**
 * (`await` 는 보낸 것까지만). 그래서 이 세션의 첫 메시지는 「AI 에게 실제로 들어갔다」 를 본 뒤에 받음(ack) 처리한다.
 *
 * 훅(channel.sh)이 claude 프로세스마다 표시를 적는다(실측 2.1.314):
 *  - `UserPromptSubmit` — 일하기 시작(busy) · 글에 이 플러그인의 `<channel …>` 이 있으면 「봄」(seen). 쉬는 중이면 0.1초 뒤
 *  - `Stop` — 쉬는 중(idle). AI 가 일하는 중에 온 채널 글은 턴이 끝난 직후에야 훅이 불린다
 *
 * 쉬는 중인데 몇 초 안에 「봄」 이 없으면 꺼진 것 — 받음 처리를 하지 않고(서버가 보관 · 다시 보냄) 이 세션은 받기를 멈춘다.
 * 일하는 중이면 끝날 때까지 기다린다(끝 · 기다림 모두 메시지를 잃지 않는다)
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 훅 표시 — 시각(ms · perl 이 없는 기기에서는 초 단위) */
export interface ChannelMarks {
  busy?: number
  idle?: number
  seen?: number
}

export class ChannelDropped extends Error {
  override name = 'ChannelDropped'
}

export interface ConfirmDeps {
  now(): number
  read(): ChannelMarks
  sleep(ms: number): Promise<void>
  /** 쉬는 중에 「봄」 을 기다리는 시간 */
  idleMs: number
}

/** sentAt(ms)에 보낸 채널 글이 AI 에게 들어갈 때까지 — 꺼졌으면 ChannelDropped */
export async function waitDelivered(sentAt: number, d: ConfirmDeps): Promise<void> {
  // 훅이 초 단위로 적는 기기도 있다 — 보낸 그 초부터 본다
  const from = Math.floor(sentAt / 1000) * 1000
  for (;;) {
    const m = d.read()
    if ((m.seen ?? 0) >= from) return
    const busy = (m.busy ?? 0) > (m.idle ?? 0)
    if (!busy) {
      // 쉬는 중 — 보낸 때나 일이 끝난 때부터 몇 초
      const since = Math.max(sentAt, m.idle ?? 0)
      if (d.now() - since >= d.idleMs)
        throw new ChannelDropped('채널 알림이 세션에 들어가지 않았습니다')
    }
    await d.sleep(200)
  }
}

/** 훅이 적은 표시 파일 — `<home>/chan-<claude pid>.<busy|idle|seen>` 에 epoch ms */
export function readMarks(home: string, ppid = process.ppid): ChannelMarks {
  const at = (k: keyof ChannelMarks): number | undefined => {
    try {
      const n = Number(readFileSync(join(home, `chan-${ppid}.${k}`), 'utf8').trim())
      return Number.isFinite(n) && n > 0 ? n : undefined
    } catch {
      return undefined
    }
  }
  const m: ChannelMarks = {}
  for (const k of ['busy', 'idle', 'seen'] as const) {
    const v = at(k)
    if (v !== undefined) m[k] = v
  }
  return m
}
