import { afterEach, describe, expect, it, vi } from 'vitest'
import { createInitialDocument, type WorkspaceDocument, type WorkspacePlan } from '../../../shared/models'
import { WorkspaceSynchronizer } from '../workspaceSynchronizer'
import { MemorySyncChannel, MemoryWorkspaceRepository, SharedMemoryStorage } from './syncTestUtils'

const PLAN_ID = 'plan-seed-workbench'

async function createPair(options?: { commitDelay?: number; draftTtl?: number }) {
  const storage = new SharedMemoryStorage()
  const channels: [MemorySyncChannel, MemorySyncChannel] = [new MemorySyncChannel(), new MemorySyncChannel()]
  const first = new WorkspaceSynchronizer(new MemoryWorkspaceRepository(storage), channels[0], options)
  const second = new WorkspaceSynchronizer(new MemoryWorkspaceRepository(storage), channels[1], options)
  await vi.waitFor(() => {
    expect(first.getSnapshot()).not.toBeNull()
    expect(second.getSnapshot()).not.toBeNull()
  })
  return { first, second, channels }
}

function updatePlan(document: WorkspaceDocument, updater: (plan: WorkspacePlan) => WorkspacePlan): WorkspaceDocument {
  return { ...document, plans: document.plans.map((plan) => plan.id === PLAN_ID ? updater(plan) : plan) }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('workspace synchronizer', () => {
  it('shows a live draft in another window and makes that window read-only', async () => {
    vi.useFakeTimers()
    const { first, second } = await createPair({ commitDelay: 10_000, draftTtl: 3000 })

    first.mutate(updatePlan(first.getSnapshot()!.document, (plan) => ({ ...plan, deskWidthMm: 1800 })), '桌面尺寸已更新')

    await vi.advanceTimersByTimeAsync(0)
    expect(second.getSnapshot()?.status).toBe('readonly')
    expect(second.getSnapshot()?.isReadOnly).toBe(true)
    expect(second.getSnapshot()?.document.plans[0].deskWidthMm).toBe(1800)
    second.mutate(updatePlan(second.getSnapshot()!.document, (plan) => ({ ...plan, deskWidthMm: 1200 })), 'ignored')
    expect(second.getSnapshot()?.document.plans[0].deskWidthMm).toBe(1800)

    first.flushNow()
    await vi.advanceTimersByTimeAsync(0)
    expect(second.getSnapshot()?.status).toBe('ready')
    expect(second.getSnapshot()?.isReadOnly).toBe(false)
    expect(second.getSnapshot()?.document.plans[0].deskWidthMm).toBe(1800)
  })

  it('commits a draft without idle windows writing data back', async () => {
    vi.useFakeTimers()
    const storage = new SharedMemoryStorage()
    const first = new WorkspaceSynchronizer(new MemoryWorkspaceRepository(storage), new MemorySyncChannel(), { commitDelay: 10_000 })
    await vi.waitFor(() => expect(first.getSnapshot()).not.toBeNull())
    await vi.advanceTimersByTimeAsync(5000)
    expect(await storage.read()).toBeNull()

    first.mutate(updatePlan(first.getSnapshot()!.document, (plan) => ({ ...plan, deskHeightMm: 900 })), '桌面尺寸已更新')
    first.flushNow()
    await vi.advanceTimersByTimeAsync(0)
    const stored = await storage.read()
    expect(stored?.document.plans[0].deskHeightMm).toBe(900)
  })

  it('detects concurrent edits to the same plan and resolves them explicitly', async () => {
    vi.useFakeTimers()
    const { first, second, channels } = await createPair({ commitDelay: 10_000, draftTtl: 3000 })
    channels[0].setPaused(true)
    channels[1].setPaused(true)

    first.mutate(updatePlan(first.getSnapshot()!.document, (plan) => ({ ...plan, deskWidthMm: 1800 })), 'first')
    first.flushNow()
    await vi.advanceTimersByTimeAsync(0)
    second.mutate(updatePlan(second.getSnapshot()!.document, (plan) => ({ ...plan, deskWidthMm: 1200 })), 'second')
    second.flushNow()
    await vi.advanceTimersByTimeAsync(0)
    channels[0].setPaused(false)
    channels[0].setPaused(false)
    channels[1].setPaused(false)
    await vi.advanceTimersByTimeAsync(0)

    expect(first.getSnapshot()?.status).toBe('conflict')
    expect(second.getSnapshot()?.status).toBe('conflict')
    expect(first.getSnapshot()?.document.plans[0].deskWidthMm).toBe(1800)
    expect(second.getSnapshot()?.document.plans[0].deskWidthMm).toBe(1200)

    await first.resolveConflict('local')
    await vi.advanceTimersByTimeAsync(0)
    expect(first.getSnapshot()?.status).toBe('ready')
    expect(second.getSnapshot()?.status).toBe('ready')
    expect(first.getSnapshot()?.document.plans[0].deskWidthMm).toBe(1800)
    expect(second.getSnapshot()?.document.plans[0].deskWidthMm).toBe(1800)
  })

  it('returns an expired observing window to editable state without saving its view', async () => {
    vi.useFakeTimers()
    const { first, second } = await createPair({ commitDelay: 10_000, draftTtl: 300 })

    first.mutate(updatePlan(first.getSnapshot()!.document, (plan) => ({ ...plan, deskWidthMm: 1700 })), 'first')
    await vi.advanceTimersByTimeAsync(0)
    expect(second.getSnapshot()?.status).toBe('readonly')

    await vi.advanceTimersByTimeAsync(550)
    expect(second.getSnapshot()?.status).toBe('ready')
    expect(second.getSnapshot()?.document.plans[0].deskWidthMm).toBe(createInitialDocument().plans[0].deskWidthMm)
  })
})
