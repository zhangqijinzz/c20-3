import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  createId,
  createPlan,
  type DeskItem,
  type DeviceType,
  type LayoutAnalysis,
  type WorkspaceDocument,
  type WorkspacePlan,
  type WorkspaceStatus,
} from '../../shared/models'
import { clampDeskSize, clampItemDimension } from '../../shared/layoutRules'
import { moveCanvasItem, rotateCanvasItem } from '../canvas/canvasViewModel'
import { createMaterialDraft } from '../materials/materialsViewModel'
import { inspectPlan } from '../inspection/inspectionViewModel'
import { BrowserDocumentStore } from './storageService'
import { BrowserSyncBus } from '../sync/syncBus'
import { SyncSession, type SyncSnapshot } from '../sync/SyncSession'
import type { ConflictDetail, MergePreference } from '../sync/threeWayMerge'

export interface WorkspaceViewModel {
  status: WorkspaceStatus
  document: WorkspaceDocument | null
  activePlan: WorkspacePlan | null
  selectedItem: DeskItem | null
  analysis: LayoutAnalysis
  issueIds: string[]
  issueCount: number
  feedback: string
  isPreviewOpen: boolean
  /** 同步通道是否健康（false 时退化为聚焦轮询，顶栏会提示）。 */
  channelHealthy: boolean
  /** 与其他窗口发生冲突、窗口处于只读时的冲突清单。 */
  conflicts: ConflictDetail[]
  resolveConflict: (preference: MergePreference) => void
  selectItem: (id: string | null) => void
  addItem: (type: DeviceType) => void
  removeItem: (id: string) => void
  moveItem: (id: string, x: number, y: number) => void
  rotateItem: (id: string, delta: number) => void
  updateItem: (id: string, patch: Partial<Pick<DeskItem, 'widthMm' | 'heightMm' | 'x' | 'y'>>) => void
  updateDesk: (field: 'deskWidthMm' | 'deskHeightMm', value: number) => void
  createNewPlan: () => void
  duplicatePlan: () => void
  selectPlan: (id: string) => void
  deleteCurrentPlan: () => void
  openPreview: () => void
  closePreview: () => void
}

const emptyInspection = { analysis: { overlapIds: [], outOfBoundsIds: [], coveragePercent: 0, status: 'clear' as const }, issueIds: [], issueCount: 0 }

function createSession(): SyncSession {
  return new SyncSession(new BrowserDocumentStore(), new BrowserSyncBus())
}

export function useWorkspaceViewModel(session?: SyncSession): WorkspaceViewModel {
  const sessionRef = useRef<SyncSession | null>(null)
  if (sessionRef.current === null) {
    sessionRef.current = session ?? createSession()
  }
  const syncSession = sessionRef.current

  const snapshot = useSyncExternalStore(
    useCallback((onChange: () => void) => syncSession.subscribe(onChange), [syncSession]),
    useCallback(() => syncSession.getSnapshot(), [syncSession]),
  )

  useEffect(() => {
    syncSession.start()
    const flushOnHide = () => {
      if (document.visibilityState === 'hidden') syncSession.flushNow()
    }
    window.addEventListener('beforeunload', flushOnHide)
    document.addEventListener('visibilitychange', flushOnHide)
    return () => {
      window.removeEventListener('beforeunload', flushOnHide)
      document.removeEventListener('visibilitychange', flushOnHide)
      syncSession.dispose()
    }
  }, [syncSession])

  const [selectedItemId, setSelectedItemId] = useState<string | null>(null)
  const [isPreviewOpen, setIsPreviewOpen] = useState(false)
  const [dismissedNoticeId, setDismissedNoticeId] = useState(0)

  const documentState: WorkspaceDocument | null = snapshot.phase === 'loading' ? null : snapshot.document
  const activePlan = useMemo(
    () => snapshot.document.plans.find((plan) => plan.id === snapshot.document.activePlanId) ?? null,
    [snapshot.document],
  )
  const selectedItem = activePlan?.items.find((item) => item.id === selectedItemId) ?? null
  const inspection = useMemo(() => activePlan ? inspectPlan(activePlan) : emptyInspection, [activePlan])
  const { analysis, issueIds, issueCount } = inspection

  const isStale = snapshot.phase === 'stale'
  const status: WorkspaceStatus = snapshot.phase === 'loading'
    ? 'loading'
    : isStale
      ? 'readonly'
      : snapshot.saveError
        ? 'error'
        : snapshot.pending
          ? 'saving'
          : 'ready'

  const feedback = useSyncedFeedback(snapshot, dismissedNoticeId)

  const commitDocument = useCallback((updater: (current: WorkspaceDocument) => WorkspaceDocument) => {
    syncSession.edit(updater(syncSession.getSnapshot().document))
  }, [syncSession])

  const updateActivePlan = useCallback((updater: (plan: WorkspacePlan) => WorkspacePlan) => {
    commitDocument((current) => {
      const target = current.plans.find((plan) => plan.id === current.activePlanId)
      if (!target) return current
      const nextPlan: WorkspacePlan = { ...updater(target), updatedAt: new Date().toISOString() }
      return { ...current, plans: current.plans.map((plan) => plan.id === nextPlan.id ? nextPlan : plan) }
    })
  }, [commitDocument])

  const selectItem = useCallback((id: string | null) => setSelectedItemId(id), [])

  const addItem = useCallback((type: DeviceType) => {
    if (isStale) return
    const current = snapshot.document
    const active = current.plans.find((plan) => plan.id === current.activePlanId)
    if (!active) return
    const draft = createMaterialDraft(type, active.items.length)
    updateActivePlan((plan) => ({ ...plan, items: [...plan.items, draft.item] }))
    setSelectedItemId(draft.item.id)
  }, [isStale, snapshot.document, updateActivePlan])

  const removeItem = useCallback((id: string) => {
    if (isStale) return
    updateActivePlan((plan) => ({ ...plan, items: plan.items.filter((item) => item.id !== id) }))
    setSelectedItemId((current) => current === id ? null : current)
  }, [isStale, updateActivePlan])

  const moveItem = useCallback((id: string, x: number, y: number) => {
    updateActivePlan((plan) => ({ ...plan, items: moveCanvasItem(plan.items, id, x, y) }))
  }, [updateActivePlan])

  const rotateItem = useCallback((id: string, delta: number) => {
    if (isStale) return
    updateActivePlan((plan) => ({ ...plan, items: rotateCanvasItem(plan.items, id, delta) }))
  }, [isStale, updateActivePlan])

  const updateItem = useCallback((id: string, patch: Partial<Pick<DeskItem, 'widthMm' | 'heightMm' | 'x' | 'y'>>) => {
    if (isStale) return
    updateActivePlan((plan) => ({
      ...plan,
      items: plan.items.map((item) => item.id === id ? {
        ...item,
        ...patch,
        widthMm: patch.widthMm === undefined ? item.widthMm : clampItemDimension(patch.widthMm, item.widthMm),
        heightMm: patch.heightMm === undefined ? item.heightMm : clampItemDimension(patch.heightMm, item.heightMm),
      } : item),
    }))
  }, [isStale, updateActivePlan])

  const updateDesk = useCallback((field: 'deskWidthMm' | 'deskHeightMm', value: number) => {
    if (isStale) return
    updateActivePlan((plan) => ({ ...plan, [field]: clampDeskSize(value, plan[field]) }))
  }, [isStale, updateActivePlan])

  const createNewPlan = useCallback(() => {
    if (isStale) return
    commitDocument((current) => {
      const plan = createPlan(`工作台 ${current.plans.length + 1}`, false)
      setSelectedItemId(null)
      return { ...current, plans: [...current.plans, plan], activePlanId: plan.id }
    })
  }, [commitDocument, isStale])

  const duplicatePlan = useCallback(() => {
    if (isStale) return
    commitDocument((current) => {
      const target = current.plans.find((plan) => plan.id === current.activePlanId)
      if (!target) return current
      const copy: WorkspacePlan = {
        ...target,
        id: createId('plan'),
        name: `${target.name} · 副本`,
        items: target.items.map((item) => ({ ...item, id: createId('item') })),
        updatedAt: new Date().toISOString(),
      }
      setSelectedItemId(null)
      return { ...current, plans: [...current.plans, copy], activePlanId: copy.id }
    })
  }, [commitDocument, isStale])

  const selectPlan = useCallback((id: string) => {
    if (isStale) return
    commitDocument((current) => {
      if (!current.plans.some((plan) => plan.id === id)) return current
      setSelectedItemId(null)
      return { ...current, activePlanId: id }
    })
  }, [commitDocument, isStale])

  const deleteCurrentPlan = useCallback(() => {
    if (isStale) return
    commitDocument((current) => {
      const target = current.plans.find((plan) => plan.id === current.activePlanId)
      if (!target || current.plans.length <= 1) return current
      const remaining = current.plans.filter((plan) => plan.id !== target.id)
      setSelectedItemId(null)
      return { ...current, plans: remaining, activePlanId: remaining[0].id }
    })
  }, [commitDocument, isStale])

  const resolveConflict = useCallback((preference: MergePreference) => {
    setDismissedNoticeId(syncSession.getSnapshot().notice?.id ?? 0)
    void syncSession.resolveConflict(preference)
  }, [syncSession])

  const openPreview = useCallback(() => setIsPreviewOpen(true), [])
  const closePreview = useCallback(() => setIsPreviewOpen(false), [])

  return {
    status,
    document: documentState,
    activePlan,
    selectedItem,
    analysis,
    issueIds,
    issueCount,
    feedback,
    isPreviewOpen,
    channelHealthy: snapshot.channelHealthy,
    conflicts: snapshot.conflicts,
    resolveConflict,
    selectItem,
    addItem,
    removeItem,
    moveItem,
    rotateItem,
    updateItem,
    updateDesk,
    createNewPlan,
    duplicatePlan,
    selectPlan,
    deleteCurrentPlan,
    openPreview,
    closePreview,
  }
}

/**
 * 顶栏反馈文案：
 * 只读冲突时解释原因；其余情况下优先展示同步会话最近的一次性通知，
 * 通知被冲突裁决消费后回到常规保存状态文案。
 */
function useSyncedFeedback(snapshot: SyncSnapshot, dismissedNoticeId: number): string {
  const lastNoticeRef = useRef<SyncSnapshot['notice']>(null)
  useEffect(() => {
    if (snapshot.notice && snapshot.notice.id !== lastNoticeRef.current?.id) {
      lastNoticeRef.current = snapshot.notice
    }
  }, [snapshot.notice])

  if (snapshot.phase === 'loading') return '正在准备你的工作台…'
  if (snapshot.phase === 'stale') return describeStale(snapshot.conflicts)
  if (snapshot.saveError) return '自动保存失败，请检查浏览器本地存储权限'
  if (snapshot.notice && snapshot.notice.id > dismissedNoticeId) return snapshot.notice.message
  if (snapshot.pending) return '正在保存…'
  return lastNoticeRef.current?.kind === 'error' ? '已保存到本地' : '已保存到本地，多窗口实时同步中'
}

function describeStale(conflicts: ConflictDetail[]): string {
  if (conflicts.length === 0) return '本窗口数据已过期，正在等待其他窗口同步…'
  const names = conflicts.map((conflict) => `「${conflict.planName}」`).join('、')
  return `其他窗口也修改了 ${names}，本窗口已进入只读，请决定以哪边为准`
}
