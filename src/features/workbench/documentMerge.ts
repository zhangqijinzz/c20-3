import type { WorkspaceDocument, WorkspacePlan } from '../../shared/models'

export function getPlanSignature(plan: WorkspacePlan): string {
  const { updatedAt: _updatedAt, ...stablePlan } = plan
  return JSON.stringify(stablePlan)
}

export function getChangedPlanIds(base: WorkspaceDocument, next: WorkspaceDocument): string[] {
  const basePlans = new Map(base.plans.map((plan) => [plan.id, plan]))
  const nextPlans = new Map(next.plans.map((plan) => [plan.id, plan]))
  const ids = new Set<string>()
  for (const [id, plan] of nextPlans) {
    const previous = basePlans.get(id)
    if (!previous || getPlanSignature(previous) !== getPlanSignature(plan)) ids.add(id)
  }
  for (const id of basePlans.keys()) {
    if (!nextPlans.has(id)) ids.add(id)
  }
  return [...ids]
}

export interface MergeResult {
  document: WorkspaceDocument | null
  changedIds: string[]
  conflictingIds: string[]
}

export function mergePlanDocuments(
  base: WorkspaceDocument,
  local: WorkspaceDocument,
  remote: WorkspaceDocument,
  localChangedIds: string[],
  remoteChangedIds: string[],
  includeLocal = true,
): MergeResult {
  const conflictingIds = localChangedIds.filter((id) => remoteChangedIds.includes(id))
  if (conflictingIds.length > 0) return { document: null, changedIds: [...new Set([...localChangedIds, ...remoteChangedIds])], conflictingIds }

  const remoteMap = new Map(remote.plans.map((plan) => [plan.id, plan]))
  const localMap = new Map(local.plans.map((plan) => [plan.id, plan]))
  const baseMap = new Map(base.plans.map((plan) => [plan.id, plan]))
  const mergedPlans: WorkspacePlan[] = []
  const usedIds = new Set<string>()

  for (const plan of base.plans) {
    const localChanged = localChangedIds.includes(plan.id)
    const remoteChanged = remoteChangedIds.includes(plan.id)
    const winner = remoteChanged && includeLocal ? remoteMap.get(plan.id)
      : localChanged ? localMap.get(plan.id)
        : remoteChanged ? remoteMap.get(plan.id)
          : localMap.get(plan.id) ?? remoteMap.get(plan.id) ?? plan
    if (winner && !usedIds.has(winner.id)) {
      mergedPlans.push(winner)
      usedIds.add(winner.id)
    }
  }

  for (const plan of remote.plans) {
    if (!baseMap.has(plan.id) && !usedIds.has(plan.id)) {
      mergedPlans.push(plan)
      usedIds.add(plan.id)
    }
  }
  if (includeLocal) {
    for (const plan of local.plans) {
      if (!baseMap.has(plan.id) && !usedIds.has(plan.id)) {
        mergedPlans.push(plan)
        usedIds.add(plan.id)
      }
    }
  }

  return {
    document: { ...remote, plans: mergedPlans, activePlanId: remote.activePlanId },
    changedIds: [...new Set(includeLocal ? [...localChangedIds, ...remoteChangedIds] : remoteChangedIds)],
    conflictingIds: [],
  }
}

export function selectPlansForIds(document: WorkspaceDocument, ids: string[]): WorkspacePlan[] {
  const selected = new Set(ids)
  return document.plans.filter((plan) => selected.has(plan.id))
}
