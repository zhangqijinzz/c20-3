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
import { WorkspaceSynchronizer, type ConflictChoice, type ConflictState } from './workspaceSynchronizer'

export interface WorkspaceViewModel {
  status: WorkspaceStatus
  document: WorkspaceDocument | null
  activePlan: WorkspacePlan | null
  selectedItem: DeskItem | null
  analysis: LayoutAnalysis
  issueIds: string[]
  issueCount: number
  feedback: string
  isReadOnly: boolean
  isPreviewOpen: boolean
  conflictReason: string | null
  conflict: ConflictState | null
  currentClientId: string
  resolveConflict: (choice: ConflictChoice) => void
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

export function useWorkspaceViewModel(synchronizer?: WorkspaceSynchronizer): WorkspaceViewModel {
  const synchronizerRef = useRef<WorkspaceSynchronizer | null>(synchronizer ?? null)
  if (!synchronizerRef.current) synchronizerRef.current = new WorkspaceSynchronizer()
  const sync = synchronizerRef.current
  const snapshot = useSyncExternalStore(sync.subscribe, sync.getSnapshot)
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null)
  const [activePlanId, setActivePlanId] = useState<string | null>(null)
  const [isPreviewOpen, setIsPreviewOpen] = useState(false)

  useEffect(() => {
    const current = synchronizerRef.current
    const flush = () => current?.flushNow()
    window.addEventListener('pagehide', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
    }
  }, [])

  useEffect(() => () => synchronizerRef.current?.dispose(), [])

  useEffect(() => {
    if (snapshot && (!activePlanId || !snapshot.document.plans.some((plan) => plan.id === activePlanId))) {
      setActivePlanId(snapshot.document.activePlanId)
    }
  }, [activePlanId, snapshot])

  const document = snapshot?.document ?? null
  const activePlan = useMemo(
    () => document?.plans.find((plan) => plan.id === (activePlanId ?? document.activePlanId)) ?? document?.plans[0] ?? null,
    [activePlanId, document],
  )

  useEffect(() => {
    if (activePlan && selectedItemId && !activePlan.items.some((item) => item.id === selectedItemId)) setSelectedItemId(null)
  }, [activePlan, selectedItemId])

  const selectedItem = activePlan?.items.find((item) => item.id === selectedItemId) ?? null
  const inspection = useMemo(() => activePlan ? inspectPlan(activePlan) : emptyInspection, [activePlan])
  const { analysis, issueIds, issueCount } = inspection
  const isReadOnly = snapshot?.isReadOnly ?? true
  const feedback = snapshot?.notice ?? '正在准备你的工作台…'
  const conflictReason = snapshot?.conflict ? '两个窗口同时修改了同一方案。请选择保留本窗口版本，或采用另一个窗口的版本。' : snapshot?.status === 'readonly' ? '另一个窗口正在编辑。已自动同步为只读，提交后此窗口会自动恢复编辑。' : null

  const mutateActivePlan = useCallback((updater: (plan: WorkspacePlan) => WorkspacePlan, message: string) => {
    if (!document || !activePlan || isReadOnly) return
    const nextPlan = { ...updater(activePlan), updatedAt: new Date().toISOString() }
    const nextDocument = { ...document, plans: document.plans.map((plan) => plan.id === nextPlan.id ? nextPlan : plan) }
    sync.mutate(nextDocument, message)
  }, [activePlan, document, isReadOnly, sync])

  const mutateDocument = useCallback((updater: (current: WorkspaceDocument) => WorkspaceDocument, nextActivePlanId: string | null, message: string) => {
    if (!document || isReadOnly) return
    sync.mutate(updater(document), message)
    if (nextActivePlanId) setActivePlanId(nextActivePlanId)
    setSelectedItemId(null)
  }, [document, isReadOnly, sync])

  const selectItem = useCallback((id: string | null) => setSelectedItemId(id), [])

  const addItem = useCallback((type: DeviceType) => {
    if (!activePlan || isReadOnly) return
    const draft = createMaterialDraft(type, activePlan.items.length)
    mutateActivePlan((plan) => ({ ...plan, items: [...plan.items, draft.item] }), draft.feedback)
    setSelectedItemId(draft.item.id)
  }, [activePlan, isReadOnly, mutateActivePlan])

  const removeItem = useCallback((id: string) => {
    mutateActivePlan((plan) => ({ ...plan, items: plan.items.filter((item) => item.id !== id) }), '设备已移除')
    setSelectedItemId((current) => current === id ? null : current)
  }, [mutateActivePlan])

  const moveItem = useCallback((id: string, x: number, y: number) => {
    mutateActivePlan((plan) => ({ ...plan, items: moveCanvasItem(plan.items, id, x, y) }), '位置已更新')
  }, [mutateActivePlan])

  const rotateItem = useCallback((id: string, delta: number) => {
    mutateActivePlan((plan) => ({ ...plan, items: rotateCanvasItem(plan.items, id, delta) }), '角度已更新')
  }, [mutateActivePlan])

  const updateItem = useCallback((id: string, patch: Partial<Pick<DeskItem, 'widthMm' | 'heightMm' | 'x' | 'y'>>) => {
    mutateActivePlan((plan) => ({
      ...plan,
      items: plan.items.map((item) => item.id === id ? {
        ...item,
        ...patch,
        widthMm: patch.widthMm === undefined ? item.widthMm : clampItemDimension(patch.widthMm, item.widthMm),
        heightMm: patch.heightMm === undefined ? item.heightMm : clampItemDimension(patch.heightMm, item.heightMm),
      } : item),
    }), '尺寸参数已更新')
  }, [mutateActivePlan])

  const updateDesk = useCallback((field: 'deskWidthMm' | 'deskHeightMm', value: number) => {
    if (!activePlan || isReadOnly) return
    mutateActivePlan((plan) => ({ ...plan, [field]: clampDeskSize(value, plan[field]) }), '桌面尺寸已更新')
  }, [activePlan, isReadOnly, mutateActivePlan])

  const createNewPlan = useCallback(() => {
    if (!document || isReadOnly) return
    const plan = createPlan(`工作台 ${document.plans.length + 1}`, false)
    mutateDocument((current) => ({ ...current, plans: [...current.plans, plan] }), plan.id, '已创建空白方案')
  }, [document, isReadOnly, mutateDocument])

  const duplicatePlan = useCallback(() => {
    if (!document || !activePlan || isReadOnly) return
    const copy: WorkspacePlan = {
      ...activePlan,
      id: createId('plan'),
      name: `${activePlan.name} · 副本`,
      items: activePlan.items.map((item) => ({ ...item, id: createId('item') })),
      updatedAt: new Date().toISOString(),
    }
    mutateDocument((current) => ({ ...current, plans: [...current.plans, copy] }), copy.id, '方案已复制')
  }, [activePlan, document, isReadOnly, mutateDocument])

  const selectPlan = useCallback((id: string) => {
    if (!document?.plans.some((plan) => plan.id === id)) return
    setActivePlanId(id)
    setSelectedItemId(null)
  }, [document])

  const deleteCurrentPlan = useCallback(() => {
    if (!document || !activePlan || document.plans.length <= 1 || isReadOnly) return
    const remaining = document.plans.filter((plan) => plan.id !== activePlan.id)
    mutateDocument((current) => ({ ...current, plans: current.plans.filter((plan) => plan.id !== activePlan.id) }), remaining[0].id, '方案已删除')
  }, [activePlan, document, isReadOnly, mutateDocument])

  const resolveConflict = useCallback((choice: ConflictChoice) => {
    void sync.resolveConflict(choice)
  }, [sync])

  const openPreview = useCallback(() => setIsPreviewOpen(true), [])
  const closePreview = useCallback(() => setIsPreviewOpen(false), [])

  const status: WorkspaceStatus = snapshot?.status === 'saving'
    ? 'saving'
    : snapshot?.status === 'readonly'
      ? 'readonly'
      : snapshot?.status === 'conflict'
        ? 'conflict'
        : snapshot?.saveError
          ? 'error'
          : document
            ? 'ready'
            : 'loading'

  return {
    status,
    document,
    activePlan,
    selectedItem,
    analysis,
    issueIds,
    issueCount,
    feedback,
    isReadOnly,
    isPreviewOpen,
    conflictReason,
    conflict: snapshot?.conflict ?? null,
    currentClientId: sync.clientId,
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
