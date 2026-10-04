import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NULL_REVISION, type CommitOutcome, type DocumentStore, type StoredRecord } from '../../workbench/storageService'
import type { CommitNotice, SyncBus, SyncMessage } from '../syncBus'
import { SyncSession, type SyncSnapshot } from '../SyncSession'
import type { WorkspaceDocument, WorkspacePlan } from '../../../shared/models'

function plan(id: string, overrides: Partial<WorkspacePlan> = {}): WorkspacePlan {
  return { id, name: id, deskWidthMm: 1600, deskHeightMm: 800, items: [], updatedAt: '2026-01-01T00:00:00.000Z', ...overrides }
}

function doc(plans: WorkspacePlan[], activePlanId = plans[0]?.id ?? ''): WorkspaceDocument {
  return { version: 1, plans, activePlanId }
}

/** 同一个 localStorage 语义的内存存储：所有 session 共享，模拟同一台机器上的 IndexedDB。 */
class SharedMemoryStore implements DocumentStore {
  private record: StoredRecord | null = null

  read(): Promise<StoredRecord | null> {
    return Promise.resolve(this.record === null ? null : JSON.parse(JSON.stringify(this.record)))
  }

  commit(expectedRevision: number, document: WorkspaceDocument, committer: string): Promise<CommitOutcome> {
    const currentRevision = this.record?.revision ?? NULL_REVISION
    if (currentRevision !== expectedRevision) {
      return Promise.resolve({
        ok: false,
        current: this.record
          ? JSON.parse(JSON.stringify(this.record))
          : { revision: NULL_REVISION, document: doc([]), committer: 'empty' },
      })
    }
    this.record = { revision: expectedRevision + 1, document: JSON.parse(JSON.stringify(document)), committer }
    return Promise.resolve({ ok: true, record: JSON.parse(JSON.stringify(this.record)) })
  }

  seed(record: StoredRecord): void {
    this.record = JSON.parse(JSON.stringify(record))
  }
}

class MemorySyncBus implements SyncBus {
  readonly healthy = true
  private peers = new Set<(message: SyncMessage) => void>()

  post(message: SyncMessage): void {
    // 模拟 BroadcastChannel：消息投递给其他订阅者，不回环给发送方
    this.peers.forEach((handler) => handler(message))
  }

  subscribe(handler: (message: SyncMessage) => void): () => void {
    this.peers.add(handler)
    return () => this.peers.delete(handler)
  }
}

function makePair(debounceMs = 10): [SyncSession, SyncSession, SharedMemoryStore] {
  const store = new SharedMemoryStore()
  const bus = new MemorySyncBus()
  const left = new SyncSession(store, bus, { clientId: 'left', debounceMs })
  const right = new SyncSession(store, bus, { clientId: 'right', debounceMs })
  left.start()
  right.start()
  return [left, right, store]
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function collect(session: SyncSession): SyncSnapshot[] {
  const snapshots: SyncSnapshot[] = []
  session.subscribe((snapshot) => snapshots.push(snapshot))
  return snapshots
}

async function flushDebounce(): Promise<void> {
  vi.advanceTimersByTime(50)
  await settle()
}

describe('SyncSession 多窗口协调', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('启动后创建示例文档，两个窗口读到同一份数据', async () => {
    const [left, right] = makePair()
    await settle()
    expect(left.getSnapshot().phase).toBe('live')
    expect(right.getSnapshot().phase).toBe('live')
    expect(left.getSnapshot().document.plans[0]?.id).toBe(right.getSnapshot().document.plans[0]?.id)
  })

  it('一个窗口的提交通过总线热更新到空闲窗口，空闲窗口不产生任何回写', async () => {
    const [left, right, store] = makePair()
    await settle()
    const writesBefore = trackCommits(store)
    const rightSnapshots = collect(right)

    const next: WorkspaceDocument = {
      ...left.getSnapshot().document,
      plans: [{ ...left.getSnapshot().document.plans[0]!, name: '左窗口改名' }],
    }
    left.edit(next)
    await flushDebounce()

    expect(right.getSnapshot().phase).toBe('live')
    expect(right.getSnapshot().document.plans[0]?.name).toBe('左窗口改名')
    expect(right.getSnapshot().revision).toBe(left.getSnapshot().revision)
    expect(writesBefore()).toBe(0) // 右窗口没有任何写操作
    expect(rightSnapshots.some((snapshot) => (snapshot.notice?.message ?? '').includes('已同步其他窗口'))).toBe(true)
  })

  it('两边改不同方案：自动合并，双方都不转只读', async () => {
    const [left, right] = makePair()
    await settle()
    const shared = left.getSnapshot().document
    const secondPlan = plan('plan-b')
    // 左窗口先新建方案 b 并提交
    left.edit(doc([...shared.plans, secondPlan], shared.activePlanId))
    await flushDebounce()
    expect(right.getSnapshot().document.plans).toHaveLength(2)

    // 左改 a 的尺寸，右改 b 的尺寸
    const base = right.getSnapshot().document
    const planA = base.plans.find((entry) => entry.id === base.activePlanId)!
    const leftDoc: WorkspaceDocument = {
      ...base,
      plans: base.plans.map((entry) => entry.id === planA.id ? { ...entry, deskWidthMm: 1900 } : entry),
    }
    const rightDoc: WorkspaceDocument = {
      ...base,
      plans: base.plans.map((entry) => entry.id === 'plan-b' ? { ...entry, deskHeightMm: 600 } : entry),
    }
    left.edit(leftDoc)
    right.edit(rightDoc)
    await flushDebounce()

    for (const session of [left, right]) {
      const merged = session.getSnapshot().document
      expect(session.getSnapshot().phase).toBe('live')
      const a = merged.plans.find((entry) => entry.id === planA.id)!
      const b = merged.plans.find((entry) => entry.id === 'plan-b')!
      expect(a.deskWidthMm).toBe(1900)
      expect(b.deskHeightMm).toBe(600)
    }
  })

  it('两边同时改同一个方案：落后窗口转只读并列明冲突', async () => {
    const [left, right] = makePair()
    await settle()
    const base = left.getSnapshot().document
    const planId = base.activePlanId

    left.edit({ ...base, plans: base.plans.map((entry) => entry.id === planId ? { ...entry, deskWidthMm: 1900 } : entry) })
    right.edit({ ...base, plans: base.plans.map((entry) => entry.id === planId ? { ...entry, deskWidthMm: 1100 } : entry) })
    await flushDebounce()

    // 先提交的一边保持可编辑，另一边进入 stale
    const staleSide = left.getSnapshot().phase === 'stale' ? left : right
    const liveSide = staleSide === left ? right : left
    expect(liveSide.getSnapshot().phase).toBe('live')
    expect(staleSide.getSnapshot().phase).toBe('stale')
    expect(staleSide.getSnapshot().conflicts).toEqual([expect.objectContaining({ kind: 'edited', planId })])
    // 只读窗口里的本地改动仍可见，便于对比
    const stalePlan = staleSide.getSnapshot().document.plans.find((entry) => entry.id === planId)!
    expect([1900, 1100]).toContain(stalePlan.deskWidthMm)
  })

  it('只读窗口忽略继续到来的编辑，不会把旧数据写回去', async () => {
    const [left, right, store] = makePair()
    await settle()
    const base = left.getSnapshot().document
    const planId = base.activePlanId
    left.edit({ ...base, plans: base.plans.map((entry) => entry.id === planId ? { ...entry, deskWidthMm: 1900 } : entry) })
    right.edit({ ...base, plans: base.plans.map((entry) => entry.id === planId ? { ...entry, deskWidthMm: 1100 } : entry) })
    await flushDebounce()

    const staleSide = left.getSnapshot().phase === 'stale' ? left : right
    const before = (await store.read())!.revision
    // 在过期窗口上继续操作应当被忽略
    staleSide.edit({ ...staleSide.getSnapshot().document, plans: [{ ...staleSide.getSnapshot().document.plans[0]!, deskWidthMm: 9999 }] })
    vi.advanceTimersByTime(100)
    await settle()
    const after = (await store.read())!.revision
    expect(after).toBe(before)
  })

  it('选择以其他窗口为准：采用对方内容，恢复可编辑', async () => {
    const [left, right] = makePair()
    await settle()
    const base = left.getSnapshot().document
    const planId = base.activePlanId
    left.edit({ ...base, plans: base.plans.map((entry) => entry.id === planId ? { ...entry, deskWidthMm: 1900 } : entry) })
    right.edit({ ...base, plans: base.plans.map((entry) => entry.id === planId ? { ...entry, deskWidthMm: 1100 } : entry) })
    await flushDebounce()

    const staleSide = left.getSnapshot().phase === 'stale' ? left : right
    await staleSide.resolveConflict('remote')
    await settle()

    expect(staleSide.getSnapshot().phase).toBe('live')
    expect(staleSide.getSnapshot().document.plans.find((entry) => entry.id === planId)!.deskWidthMm)
      .toBe(staleSide === left ? 1900 : 1100)
    expect(staleSide.getSnapshot().conflicts).toEqual([])
  })

  it('选择以本窗口为准：保留本方内容并把裁决结果同步给对方', async () => {
    const [left, right] = makePair()
    await settle()
    const base = left.getSnapshot().document
    const planId = base.activePlanId
    left.edit({ ...base, plans: base.plans.map((entry) => entry.id === planId ? { ...entry, deskWidthMm: 1900 } : entry) })
    right.edit({ ...base, plans: base.plans.map((entry) => entry.id === planId ? { ...entry, deskWidthMm: 1100 } : entry) })
    await flushDebounce()

    let staleSide: SyncSession
    let otherSide: SyncSession
    let expectedWidth: number
    if (left.getSnapshot().phase === 'stale') {
      staleSide = left; otherSide = right; expectedWidth = 1100
    } else {
      staleSide = right; otherSide = left; expectedWidth = 1900
    }
    await staleSide.resolveConflict('local')
    await settle()

    expect(staleSide.getSnapshot().phase).toBe('live')
    const resolvedWidth = staleSide.getSnapshot().document.plans.find((entry) => entry.id === planId)!.deskWidthMm
    expect(resolvedWidth).toBe(expectedWidth)
    // 裁决后的提交广播给对方，两边数据一致
    expect(otherSide.getSnapshot().document.plans.find((entry) => entry.id === planId)!.deskWidthMm).toBe(expectedWidth)
    expect(otherSide.getSnapshot().revision).toBe(staleSide.getSnapshot().revision)
  })

  it('对端撤销冲突改动后，只读窗口在收到后续提交时自动恢复', async () => {
    const [left, right] = makePair()
    await settle()
    const initial = left.getSnapshot().document
    const planId = initial.activePlanId
    const conflictLeft = { ...initial, plans: initial.plans.map((entry) => entry.id === planId ? { ...entry, deskWidthMm: 1900 } : entry) }
    const conflictRight = { ...initial, plans: initial.plans.map((entry) => entry.id === planId ? { ...entry, deskWidthMm: 1100 } : entry) }
    left.edit(conflictLeft)
    right.edit(conflictRight)
    await flushDebounce()

    const liveSide = left.getSnapshot().phase === 'stale' ? right : left
    const staleSide = liveSide === left ? right : left
    expect(staleSide.getSnapshot().phase).toBe('stale')

    // 可编辑的一边把冲突方案改回共同基态（对 stale 方而言远端不再有分叉）
    const liveDoc = liveSide.getSnapshot().document
    const baseWidth = initial.plans.find((entry) => entry.id === planId)!.deskWidthMm
    liveSide.edit({ ...liveDoc, plans: liveDoc.plans.map((entry) => entry.id === planId ? { ...entry, deskWidthMm: baseWidth } : entry) })
    await flushDebounce()

    expect(staleSide.getSnapshot().phase).toBe('live')
    expect(staleSide.getSnapshot().conflicts).toEqual([])
  })

  it('落后窗口通过 refresh（重新聚焦）也能发现更新而不依赖广播', async () => {
    const store = new SharedMemoryStore()
    const seededPlan = plan('seeded', { name: '别的窗口先保存的方案' })
    store.seed({ revision: 3, document: doc([seededPlan], 'seeded'), committer: 'elsewhere' })

    const bus = new MemorySyncBus()
    const session = new SyncSession(store, bus, { clientId: 'late', debounceMs: 10 })
    session.start()
    await settle()
    expect(session.getSnapshot().document.plans[0]?.name).toBe('别的窗口先保存的方案')
    expect(session.getSnapshot().revision).toBe(3)

    // 存储又被推进了一版，但没有总线消息（模拟广播丢失）
    store.seed({ revision: 4, document: doc([plan('seeded', { name: '聚焦时拉到的版本' })], 'seeded'), committer: 'elsewhere' })
    await session.refresh()
    expect(session.getSnapshot().document.plans[0]?.name).toBe('聚焦时拉到的版本')
    expect(session.getSnapshot().revision).toBe(4)
  })
})

function trackCommits(store: SharedMemoryStore): () => number {
  let writes = 0
  const originalCommit = store.commit.bind(store)
  store.commit = (...args) => {
    writes += 1
    return originalCommit(...args)
  }
  return () => writes
}
