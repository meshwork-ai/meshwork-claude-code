/**
 * 이름 ↔ id — 사람 · 에이전트는 이름으로 말하고 프로토콜은 id 로 가리킨다(명세 §6.2 — 바꾸는 것은 클라이언트 몫).
 *
 * - 방: welcome · `room.list` 의 사본(방 이름은 조직 안에서 고유)
 * - 구성원: 방마다 `room.get`(그 방에서의 이름 — 같은 방 안에서 겹치지 않는다 · 명세 §4.5). `room.changed` 면 다시 받는다
 * - 받는 사람: `address.resolve` — 서버가 같은 규칙(NFC · 대소문자 무시)으로 구성원 · 역할을 찾는다
 */
import type { MeshworkClient } from '@meshwork-ai/client-core'
import type { OpResult } from '@meshwork-ai/protocol'

export type RoomDetail = OpResult<'room.get'>
export type RoomMember = RoomDetail['members'][number]
export type Candidate = OpResult<'address.resolve'>['candidates'][number]

export interface RoomRef {
  id: string
  name: string
  myName: string
  role: 'owner' | 'member'
  archived: boolean
  /** 열린 방(명세 §10.7) — 이 방에서 시작하는 대화는 방 사람 모두에게 보인다 */
  open: boolean
}

/** 이름 비교 — NFC 정규화 후 대소문자 무시(명세 §4.5 와 같은 규칙) */
export function sameName(a: string, b: string): boolean {
  return a.normalize('NFC').trim().toLowerCase() === b.normalize('NFC').trim().toLowerCase()
}

/** 「민준님」 처럼 붙인 호칭을 뗀다 — 그대로 맞는 이름이 없을 때만 */
export function withoutHonorific(name: string): string | null {
  const t = name.trim()
  const m = t.match(/^(.+?)\s*(님|씨)$/)
  return m ? m[1]! : null
}

export class Directory {
  rooms: RoomRef[] = []
  me = ''
  private readonly members = new Map<string, Promise<RoomDetail>>()
  private readonly roles = new Map<string, Promise<OpResult<'role.list'>['roles']>>()
  /** id → 이름 — 한 번이라도 본 것(알림 문구에 쓴다) */
  private readonly known = new Map<string, string>()

  constructor(private readonly client: () => MeshworkClient | undefined) {}

  /** welcome · room.list 로 방 목록을 바꾼다 */
  setRooms(rooms: RoomRef[]): void {
    this.rooms = rooms
    for (const r of rooms) this.known.set(r.id, r.name)
  }

  addRooms(rooms: RoomRef[]): void {
    const ids = new Set(rooms.map((r) => r.id))
    this.setRooms([...this.rooms.filter((r) => !ids.has(r.id)), ...rooms])
  }

  removeRooms(ids: string[]): void {
    this.setRooms(this.rooms.filter((r) => !ids.includes(r.id)))
    for (const id of ids) this.members.delete(id)
  }

  /** 방이 바뀜(room.changed) — 다음에 다시 받는다 */
  invalidate(room: string): void {
    this.members.delete(room)
    this.roles.delete(room)
  }

  remember(id: string, name: string): void {
    this.known.set(id, name)
  }

  /** 알고 있는 이름 — 모르면 undefined */
  name = (id: string): string | undefined => this.known.get(id)

  roomName = (id: string): string | undefined =>
    this.rooms.find((r) => r.id === id)?.name ?? this.known.get(id)

  /** 보이는 방 이름 — 열린 방이면 표시를 붙인다(status 는 ` [열림]` · 상태 파일은 `(열림)`) */
  roomTitle = (id: string, mark = ' [열림]'): string | undefined => {
    const r = this.rooms.find((x) => x.id === id)
    return r ? `${r.name}${r.open ? mark : ''}` : this.known.get(id)
  }

  /** 방 이름 · id → 방 */
  room(input: string): RoomRef | undefined {
    const t = input.trim().replace(/^#/, '')
    return this.rooms.find((r) => r.id === t) ?? this.rooms.find((r) => sameName(r.name, t))
  }

  /** 그 방의 정보(구성원 포함) — 잠깐 기억한다 */
  async detail(room: string): Promise<RoomDetail> {
    let p = this.members.get(room)
    if (!p) {
      const c = this.client()
      if (!c) throw new Error('서버에 붙어 있지 않습니다')
      p = c.call('room.get', { room })
      this.members.set(room, p)
      p.then(
        (d) => {
          this.known.set(d.id, d.name)
          for (const m of d.members) this.known.set(m.member, m.name)
        },
        () => this.members.delete(room),
      )
    }
    return p
  }

  /** 그 방의 구성원 하나 — 이름으로(그대로 → 호칭 뗀 것) */
  async member(room: string, name: string): Promise<RoomMember | undefined> {
    const d = await this.detail(room)
    const exact = d.members.find((m) => sameName(m.name, name) || m.member === name.trim())
    if (exact) return exact
    const bare = withoutHonorific(name)
    return bare ? d.members.find((m) => sameName(m.name, bare)) : undefined
  }

  /** 그 방에서 부를 수 있는 역할(기능 address.role) — 이름 표시용 */
  async roleNames(room: string): Promise<void> {
    const c = this.client()
    if (!c || !c.features.includes('address.role')) return
    let p = this.roles.get(room)
    if (!p) {
      p = c.call('role.list', { room }).then((r) => r.roles)
      this.roles.set(room, p)
      p.catch(() => this.roles.delete(room))
    }
    for (const r of await p.catch(() => [])) this.known.set(r.id, r.name)
  }

  /** 받는 사람 후보 — 그 방 안에서(서버가 이름을 맞춘다). 없으면 호칭을 떼고 한 번 더 */
  async resolve(room: string, name: string): Promise<Candidate[]> {
    const c = this.client()
    if (!c) throw new Error('서버에 붙어 있지 않습니다')
    const ask = async (n: string) =>
      (await c.call('address.resolve', { room, name: n })).candidates.filter((x) => x.room === room)
    let found = await ask(name.trim())
    if (!found.length) {
      const bare = withoutHonorific(name)
      if (bare) found = await ask(bare)
    }
    for (const x of found) this.known.set(x.id, x.name)
    return found
  }
}
