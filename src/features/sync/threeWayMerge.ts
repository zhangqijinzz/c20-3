import type { WorkspaceDocument, WorkspacePlan } from '../../shared/models'

export type MergePreference = 'local' | 'remote'

export type ConflictKind = 'edited' | 'localEditedRemoteDeleted' | 'remoteEditedLocalDeleted' | 'bothCreated'

export interface ConflictDetail {
  kind: ConflictKind
  planId: string
  planName: string
}

export interface MergeResult {
  document: WorkspaceDocument
  conflicts: ConflictDetail[]
}

/** 空文档。首次使用、存储里还没有任何记录时作为合并基址。 */
export const EMPTY_DOCUMENT: WorkspaceDocument = { version: 1, plans: [], activePlanId: '' }

function planIdentity(plan: WorkspacePlan | undefined): string {
  if (!plan) return '__deleted__'
  return JSON.stringify(plan)
}

function documentsEqual(first: WorkspaceDocument, second: WorkspaceDocument): boolean {
  return JSON.stringify(first) === JSON.stringify(second)
}

/**
 * 以 base 为共同祖先，对本窗口文档 local 与其他窗口提交的 remote 做三方合并。
 *
 * - 只有一边动过的方案：直接采用动过的那一边（新建、删除也一样）。
 * - 两边都动了同一个方案，或各自新建了相同 id 的方案：记为冲突，文档内容暂取 remote，
 *   交由上层（SyncSession）让用户裁决；调用方给出 preference 时按偏好解决，不再产生冲突。
 */
export function mergeDocuments(
  base: WorkspaceDocument,
  local: WorkspaceDocument,
  remote: WorkspaceDocument,
  preference?: MergePreference,
): MergeResult {
  const basePlans = new Map(base.plans.map((plan) => [plan.id, plan]))
  const localPlans = new Map(local.plans.map((plan) => [plan.id, plan]))
  const remotePlans = new Map(remote.plans.map((plan) => [plan.id, plan]))

  const orderedIds: string[] = []
  base.plans.forEach((plan) => orderedIds.push(plan.id))
  local.plans.forEach((plan) => { if (!orderedIds.includes(plan.id)) orderedIds.push(plan.id) })
  remote.plans.forEach((plan) => { if (!orderedIds.includes(plan.id)) orderedIds.push(plan.id) })

  const conflicts: ConflictDetail[] = []
  const plans: WorkspacePlan[] = []

  for (const id of orderedIds) {
    const basePlan = basePlans.get(id)
    const localPlan = localPlans.get(id)
    const remotePlan = remotePlans.get(id)

    const localChanged = planIdentity(basePlan) !== planIdentity(localPlan)
    const remoteChanged = planIdentity(basePlan) !== planIdentity(remotePlan)

    if (!localChanged) {
      if (remotePlan) plans.push(remotePlan)
      continue
    }
    if (!remoteChanged) {
      if (localPlan) plans.push(localPlan)
      continue
    }

    // 两边都动了这个 id
    if (localPlan && remotePlan) {
      const diverged = planIdentity(localPlan) !== planIdentity(remotePlan)
      if (!diverged) {
        plans.push(localPlan)
        continue
      }
      const winner = preference === 'local' ? localPlan : remotePlan
      plans.push(winner)
      if (!preference) {
        conflicts.push({
          kind: basePlan ? 'edited' : 'bothCreated',
          planId: id,
          planName: remotePlan.name || localPlan.name || '未命名方案',
        })
      }
      continue
    }

    if (localPlan && !remotePlan) {
      if (preference === 'local') {
        plans.push(localPlan)
      }
      if (!preference) {
        conflicts.push({ kind: 'remoteEditedLocalDeleted', planId: id, planName: basePlan?.name ?? '未命名方案' })
      }
      continue
    }

    if (!localPlan && remotePlan) {
      if (preference === 'remote') {
        plans.push(remotePlan)
      }
      if (!preference) {
        conflicts.push({ kind: 'localEditedRemoteDeleted', planId: id, planName: remotePlan.name || basePlan?.name || '未命名方案' })
      }
    }
  }

  const activePlanId = mergeActivePlanId(base, local, remote, preference, plans)

  return { document: { version: 1, plans, activePlanId }, conflicts }
}

function mergeActivePlanId(
  base: WorkspaceDocument,
  local: WorkspaceDocument,
  remote: WorkspaceDocument,
  preference: MergePreference | undefined,
  mergedPlans: WorkspacePlan[],
): string {
  const stillExists = (id: string) => mergedPlans.some((plan) => plan.id === id)

  // 解决冲突偏好期间，优先让被选中一方的活动方案生效。
  if (preference === 'local' && stillExists(local.activePlanId)) return local.activePlanId
  if (preference === 'remote' && stillExists(remote.activePlanId)) return remote.activePlanId

  const localChanged = base.activePlanId !== local.activePlanId
  const remoteChanged = base.activePlanId !== remote.activePlanId

  let candidate: string
  if (!localChanged && remoteChanged) candidate = remote.activePlanId
  else if (localChanged && !remoteChanged) candidate = local.activePlanId
  else candidate = remote.activePlanId

  if (stillExists(candidate)) return candidate
  return mergedPlans[0]?.id ?? ''
}

/** 合并结果与给定文档是否完全一致（用于判断一次合并是否其实是空操作）。 */
export function sameDocument(first: WorkspaceDocument, second: WorkspaceDocument): boolean {
  return documentsEqual(first, second)
}
