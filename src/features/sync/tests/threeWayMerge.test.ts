import { describe, expect, it } from 'vitest'
import { EMPTY_DOCUMENT, mergeDocuments, type ConflictDetail, type MergePreference } from '../threeWayMerge'
import type { WorkspaceDocument, WorkspacePlan } from '../../../shared/models'

function plan(id: string, overrides: Partial<WorkspacePlan> = {}): WorkspacePlan {
  return { id, name: id, deskWidthMm: 1600, deskHeightMm: 800, items: [], updatedAt: '2026-01-01T00:00:00.000Z', ...overrides }
}

function doc(plans: WorkspacePlan[], activePlanId = plans[0]?.id ?? ''): WorkspaceDocument {
  return { version: 1, plans, activePlanId }
}

function planAt(document: WorkspaceDocument, id: string): WorkspacePlan {
  const found = document.plans.find((entry) => entry.id === id)
  if (!found) throw new Error(`plan ${id} missing`)
  return found
}

describe('mergeDocuments', () => {
  it('passes through unchanged plans', () => {
    const base = doc([plan('a'), plan('b')])
    const result = mergeDocuments(base, base, base)
    expect(result.document).toEqual(base)
    expect(result.conflicts).toEqual([])
  })

  it('takes a one-sided plan edit without conflict', () => {
    const a = plan('a')
    const b = plan('b')
    const base = doc([a, b])
    const remote = doc([a, { ...b, name: 'remote-renamed' }])
    const result = mergeDocuments(base, base, remote)
    expect(result.conflicts).toEqual([])
    expect(planAt(result.document, 'b').name).toBe('remote-renamed')
  })

  it('keeps edits made to different plans on both sides', () => {
    const a = plan('a')
    const b = plan('b')
    const base = doc([a, b])
    const local = doc([{ ...a, name: 'local-a' }, b])
    const remote = doc([a, { ...b, name: 'remote-b' }])
    const result = mergeDocuments(base, local, remote)
    expect(result.conflicts).toEqual([])
    expect(planAt(result.document, 'a').name).toBe('local-a')
    expect(planAt(result.document, 'b').name).toBe('remote-b')
  })

  it('reports a conflict when both sides edited the same plan differently', () => {
    const a = plan('a')
    const base = doc([a])
    const local = doc([{ ...a, deskWidthMm: 1800 }])
    const remote = doc([{ ...a, deskWidthMm: 1200 }])
    const result = mergeDocuments(base, local, remote)
    expect(result.conflicts).toEqual<ConflictDetail[]>([{ kind: 'edited', planId: 'a', planName: 'a' }])
    // 未给偏好时暂取 remote，等待用户裁决
    expect(planAt(result.document, 'a').deskWidthMm).toBe(1200)
  })

  it('resolves same-plan conflict according to preference', () => {
    const a = plan('a')
    const base = doc([a])
    const local = doc([{ ...a, deskWidthMm: 1800 }])
    const remote = doc([{ ...a, deskWidthMm: 1200 }])
    const keepLocal = mergeDocuments(base, local, remote, 'local' satisfies MergePreference)
    expect(keepLocal.conflicts).toEqual([])
    expect(planAt(keepLocal.document, 'a').deskWidthMm).toBe(1800)
    const keepRemote = mergeDocuments(base, local, remote, 'remote')
    expect(planAt(keepRemote.document, 'a').deskWidthMm).toBe(1200)
  })

  it('treats edit-vs-delete of one plan as a conflict while keeping unrelated edits', () => {
    const a = plan('a')
    const b = plan('b')
    const base = doc([a, b])
    // 本窗口在编辑 b，对端把 b 删了；同时本窗口对 a 有不相关改动
    const local = doc([{ ...a, deskWidthMm: 1800 }, { ...b, deskHeightMm: 500 }])
    const remote = doc([a])
    const result = mergeDocuments(base, local, remote)
    expect(result.conflicts).toEqual([{ kind: 'remoteEditedLocalDeleted', planId: 'b', planName: 'b' }])
    // 不相关的 a 改动仍然保留在待裁决文档里
    expect(planAt(result.document, 'a').deskWidthMm).toBe(1800)
  })

  it('honours delete when preferring the deleting side', () => {
    const a = plan('a')
    const base = doc([a])
    const local = doc([{ ...a, deskWidthMm: 1800 }])
    const remote = doc([])
    const result = mergeDocuments(base, local, remote, 'remote')
    expect(result.document.plans).toEqual([])
  })

  it('unions plans created independently on both sides', () => {
    const a = plan('a')
    const base = doc([a])
    const local = doc([a, plan('local-new')])
    const remote = doc([a, plan('remote-new')])
    const result = mergeDocuments(base, local, remote)
    expect(result.conflicts).toEqual([])
    expect(result.document.plans.map((entry) => entry.id).sort()).toEqual(['a', 'local-new', 'remote-new'])
  })

  it('flags same-id plans created independently when their content differs', () => {
    const base = EMPTY_DOCUMENT
    const local = doc([plan('x', { name: 'from-local' })])
    const remote = doc([plan('x', { name: 'from-remote' })])
    const result = mergeDocuments(base, local, remote)
    expect(result.conflicts[0]?.kind).toBe('bothCreated')
  })

  it('tracks one-sided activePlanId switches', () => {
    const a = plan('a')
    const b = plan('b')
    const base = doc([a, b], 'a')
    const local = doc([a, b], 'a')
    const remote = doc([a, b], 'b')
    const result = mergeDocuments(base, local, remote)
    expect(result.document.activePlanId).toBe('b')
  })
})
