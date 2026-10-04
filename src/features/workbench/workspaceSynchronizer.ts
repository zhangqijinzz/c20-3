import { createInitialDocument, type WorkspaceDocument } from '../../shared/models'
import { SEED_REVISION } from './storageService'
import type { SaveResult, WorkspaceRepository } from './workspaceRepository'
import { LocalWorkspaceRepository } from './workspaceRepository'
import { getChangedPlanIds, mergePlanDocuments } from './documentMerge'
import { BroadcastSyncChannel, createClientId, type CommitMessage, type ConflictMessage, type DraftMessage, type SyncChannel, type SyncMessage } from './syncChannel'

export type SyncPhase = 'ready' | 'conflict'
export type ConflictChoice = 'local' | 'remote'

export interface ConflictState {
  key: string
  localClientId: string
  remoteClientId: string
  parentRevision: string
  storageRevision: string
  localDocument: WorkspaceDocument
  remoteDocument: WorkspaceDocument
  localChangedPlanIds: string[]
  remoteChangedPlanIds: string[]
}

interface RemoteDraft {
  clientId: string
  parentRevision: string
  document: WorkspaceDocument
  changedPlanIds: string[]
  sentAt: number
  expiresAt: number
}

export interface WorkspaceSnapshot {
  document: WorkspaceDocument
  revision: string
  phase: SyncPhase
  status: 'ready' | 'saving' | 'readonly' | 'conflict'
  conflict: ConflictState | null
  isReadOnly: boolean
  isSaving: boolean
  saveError: boolean
  notice: string
}

interface SynchronizerOptions {
  commitDelay?: number
  draftTtl?: number
  now?: () => number
}

type Listener = () => void
type CommitSuccess = Extract<SaveResult, { committed: true }>

const DEFAULT_COMMIT_DELAY = 300
const DEFAULT_DRAFT_TTL = 3000

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export class WorkspaceSynchronizer {
  readonly clientId = createClientId()
  private committedDocument: WorkspaceDocument | null = null
  private baseRevision = SEED_REVISION
  private localDocument: WorkspaceDocument | null = null
  private localChangedPlanIds: string[] = []
  private readonly remoteDrafts = new Map<string, RemoteDraft>()
  private phase: SyncPhase = 'ready'
  private conflict: ConflictState | null = null
  private isSaving = false
  private saveError = false
  private notice = '正在准备你的工作台…'
  private readonly listeners = new Set<Listener>()
  private draftTimer: ReturnType<typeof setTimeout> | null = null
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private sweepTimer: ReturnType<typeof setInterval> | null = null
  private draftLastSentAt = 0
  private readonly knownCommits = new Map<string, { clientId: string; parentRevision: string; changedPlanIds: string[] }>()
  private cachedSnapshot: WorkspaceSnapshot | null = null
  private snapshotVersion = 0
  private lastSnapshotVersion = -1
  private readonly commitDelay: number
  private readonly draftTtl: number
  private readonly getNow: () => number

  constructor(
    private readonly repository: WorkspaceRepository = new LocalWorkspaceRepository(),
    private readonly channel: SyncChannel = new BroadcastSyncChannel(),
    options: SynchronizerOptions = {},
  ) {
    this.commitDelay = options.commitDelay ?? DEFAULT_COMMIT_DELAY
    this.draftTtl = options.draftTtl ?? DEFAULT_DRAFT_TTL
    this.getNow = options.now ?? (() => Date.now())
    this.channel.subscribe((message) => this.handleMessage(message))
    this.sweepTimer = setInterval(() => this.sweepDrafts(), 500)
    void this.load()
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot(): WorkspaceSnapshot | null {
    if (!this.committedDocument) return null
    if (this.cachedSnapshot && this.lastSnapshotVersion === this.snapshotVersion) return this.cachedSnapshot
    if (this.phase === 'conflict' && this.conflict) {
      const document = this.clientId === this.conflict.localClientId ? this.conflict.localDocument : this.conflict.remoteDocument
      this.cachedSnapshot = this.toSnapshot(document, 'conflict', true)
    } else if (this.localDocument) {
      const remote = this.composeRemoteDrafts(this.committedDocument)
      const merged = mergePlanDocuments(this.committedDocument, this.localDocument, remote.document, this.localChangedPlanIds, remote.changedIds, true)
      this.cachedSnapshot = this.toSnapshot(merged.document ?? this.localDocument, this.isSaving ? 'saving' : 'ready', false)
    } else if (this.remoteDrafts.size > 0) {
      const remote = this.composeRemoteDrafts(this.committedDocument)
      this.cachedSnapshot = this.toSnapshot(remote.document, 'readonly', true)
    } else {
      this.cachedSnapshot = this.toSnapshot(this.committedDocument, this.isSaving ? 'saving' : 'ready', false)
    }
    this.lastSnapshotVersion = this.snapshotVersion
    return this.cachedSnapshot
  }

  private getCurrentDisplayDocument(): WorkspaceDocument {
    if (!this.committedDocument) throw new Error('Workspace is not loaded')
    if (this.localDocument) {
      const remote = this.composeRemoteDrafts(this.committedDocument)
      return mergePlanDocuments(this.committedDocument, this.localDocument, remote.document, this.localChangedPlanIds, remote.changedIds, true).document ?? this.localDocument
    }
    if (this.remoteDrafts.size > 0) return this.composeRemoteDrafts(this.committedDocument).document
    return this.committedDocument
  }

  mutate(nextDocument: WorkspaceDocument, message: string): void {
    if (!this.committedDocument || this.phase === 'conflict') return
    const currentDisplay = this.getCurrentDisplayDocument()
    const changedIds = getChangedPlanIds(currentDisplay, nextDocument)
    if (changedIds.length === 0) return

    const remoteIds = this.getRemoteChangedIds()
    const overlappingRemote = changedIds.filter((id) => remoteIds.includes(id))
    if (overlappingRemote.length > 0) {
      if (!this.localDocument) return
      const remote = this.composeRemoteDrafts(this.committedDocument)
      this.openConflict(this.applyDraftChanges(this.committedDocument, nextDocument, changedIds), remote.document, changedIds, remote.changedIds, this.remoteDraftClient(overlappingRemote[0]) ?? 'remote-window', true)
      return
    }

    this.localDocument = this.applyDraftChanges(this.localDocument ?? this.committedDocument, nextDocument, changedIds)
    this.localChangedPlanIds = [...new Set([...this.localChangedPlanIds, ...changedIds])]
    this.saveError = false
    this.notice = message
    this.scheduleDraft()
    this.scheduleFlush()
    this.emit()
  }

  async resolveConflict(choice: ConflictChoice): Promise<void> {
    if (!this.conflict || this.isSaving) return
    const conflict = this.conflict
    const isLocalSide = conflict.localClientId === this.clientId
    const ownDocument = isLocalSide ? conflict.localDocument : conflict.remoteDocument
    const otherDocument = isLocalSide ? conflict.remoteDocument : conflict.localDocument
    const chosen = choice === 'local' ? ownDocument : otherDocument
    this.isSaving = true
    this.saveError = false
    this.notice = '正在应用你的选择…'
    this.emit()

    const result = await this.repository.save(clone(chosen), conflict.storageRevision, this.clientId)
    this.isSaving = false
    if (result.committed) {
      this.applyOwnCommit(result, conflict.storageRevision, choice === 'local' ? '已保留本窗口的版本' : '已采用另一个窗口的版本', conflict.key, [...new Set([...conflict.localChangedPlanIds, ...conflict.remoteChangedPlanIds])], false, true)
      this.phase = 'ready'
      this.conflict = null
      this.emit()
    } else if (result.document) {
      this.committedDocument = clone(result.document)
      this.baseRevision = result.revision
      this.saveError = true
      this.notice = '冲突处理期间又有新的保存，请重新选择'
      this.emit()
    } else {
      this.saveError = true
      this.notice = '自动保存失败，请稍后重试'
      this.emit()
    }
  }

  flushNow(): void {
    void this.save()
  }

  dispose(): void {
    this.clearTimers()
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    this.channel.close()
    this.listeners.clear()
  }

  private async load(): Promise<void> {
    const loaded = await this.repository.load()
    if (loaded.document) {
      this.committedDocument = clone(loaded.document)
      this.baseRevision = loaded.revision ?? SEED_REVISION
      this.notice = '已恢复上次编辑状态'
    } else {
      this.committedDocument = createInitialDocument()
      this.baseRevision = SEED_REVISION
      this.notice = '已创建示例工作台，可以直接拖动设备'
    }
    this.emit()
  }

  private toSnapshot(document: WorkspaceDocument, status: WorkspaceSnapshot['status'], isReadOnly: boolean): WorkspaceSnapshot {
    return {
      document: clone(document),
      revision: this.baseRevision,
      phase: this.phase,
      status,
      conflict: this.conflict ? clone(this.conflict) : null,
      isReadOnly: isReadOnly || status === 'conflict',
      isSaving: this.isSaving,
      saveError: this.saveError,
      notice: this.notice,
    }
  }

  private emit(): void {
    this.snapshotVersion += 1
    this.listeners.forEach((listener) => listener())
  }

  private composeRemoteDrafts(base: WorkspaceDocument): { document: WorkspaceDocument; changedIds: string[] } {
    let document = clone(base)
    let changedIds: string[] = []
    for (const draft of [...this.remoteDrafts.values()].sort((a, b) => a.sentAt - b.sentAt)) {
      document = this.applyDraftChanges(document, draft.document, draft.changedPlanIds)
      changedIds = [...new Set([...changedIds, ...draft.changedPlanIds])]
    }
    return { document, changedIds }
  }

  private applyDraftChanges(base: WorkspaceDocument, draft: WorkspaceDocument, changedIds: string[]): WorkspaceDocument {
    const draftMap = new Map(draft.plans.map((plan) => [plan.id, plan]))
    const plans = base.plans
      .filter((plan) => !changedIds.includes(plan.id) || draftMap.has(plan.id))
      .map((plan) => draftMap.get(plan.id) ?? plan)
    for (const id of changedIds) {
      const incoming = draftMap.get(id)
      if (incoming && !plans.some((plan) => plan.id === id)) plans.push(incoming)
    }
    return { ...base, activePlanId: base.activePlanId, plans }
  }

  private getRemoteChangedIds(): string[] {
    return [...new Set([...this.remoteDrafts.values()].flatMap((draft) => draft.changedPlanIds))]
  }

  private remoteDraftClient(planId: string): string | null {
    for (const draft of this.remoteDrafts.values()) {
      if (draft.changedPlanIds.includes(planId)) return draft.clientId
    }
    return null
  }

  private scheduleDraft(): void {
    const now = this.getNow()
    if (now - this.draftLastSentAt >= 50) {
      this.sendDraft()
      return
    }
    if (!this.draftTimer) this.draftTimer = setTimeout(() => {
      this.draftTimer = null
      this.sendDraft()
    }, 50)
  }

  private sendDraft(): void {
    if (!this.localDocument) return
    this.draftLastSentAt = this.getNow()
    this.channel.post({
      type: 'draft',
      clientId: this.clientId,
      parentRevision: this.baseRevision,
      document: clone(this.localDocument),
      changedPlanIds: [...this.localChangedPlanIds],
      sentAt: this.getNow(),
    } satisfies DraftMessage)
  }

  private scheduleFlush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.save()
    }, this.commitDelay)
  }

  private async save(): Promise<void> {
    if (!this.committedDocument || !this.localDocument || this.phase === 'conflict' || this.isSaving) return
    const baseDocument = clone(this.committedDocument)
    const parentRevision = this.baseRevision
    const candidate = clone(this.localDocument)
    const localChangedIds = [...this.localChangedPlanIds]
    const localAtRequest = clone(this.localDocument)
    this.isSaving = true
    this.saveError = false
    this.notice = '保存中…'
    this.emit()

    let result = await this.repository.save(candidate, parentRevision, this.clientId)
    this.isSaving = false
    if (!result.committed) {
      if (!result.document) {
        this.saveError = true
        this.notice = '自动保存失败，请检查浏览器本地存储权限'
        this.emit()
        return
      }
      const remoteChangedIds = getChangedPlanIds(baseDocument, result.document)
      const overlapping = localChangedIds.filter((id) => remoteChangedIds.includes(id))
      if (overlapping.length > 0) {
        this.committedDocument = clone(result.document)
        this.baseRevision = result.revision
        this.localDocument = clone(candidate)
        this.localChangedPlanIds = localChangedIds
        const winner = this.knownCommits.get(result.revision)
        this.openConflict(candidate, result.document, localChangedIds, remoteChangedIds, result.winnerClientId ?? winner?.clientId ?? 'remote-window', false, winner?.changedPlanIds ?? remoteChangedIds, parentRevision, result.revision, true)
        return
      }
      const merged = mergePlanDocuments(baseDocument, candidate, result.document, localChangedIds, remoteChangedIds, true)
      if (!merged.document) {
        this.openConflict(candidate, result.document, localChangedIds, remoteChangedIds, 'remote-window', false)
        return
      }
      this.isSaving = true
      const retry = await this.repository.save(merged.document, result.revision, this.clientId)
      this.isSaving = false
      if (!retry.committed) {
        if (retry.document) this.openConflict(candidate, retry.document, localChangedIds, getChangedPlanIds(baseDocument, retry.document), 'remote-window', false)
        else {
          this.saveError = true
          this.notice = '自动保存失败，请检查浏览器本地存储权限'
          this.emit()
        }
        return
      }
      result = retry
    }

    const newerPatch = this.localDocument && JSON.stringify(this.localDocument) !== JSON.stringify(localAtRequest)
      ? this.rebaseNewerLocalPatch(localAtRequest, this.localDocument, result.document)
      : null
    this.applyOwnCommit(result, parentRevision, '已保存并同步到其他窗口', undefined, localChangedIds, false)
    if (newerPatch) {
      this.localDocument = newerPatch.document
      this.localChangedPlanIds = newerPatch.changedIds
      this.scheduleFlush()
    }
    this.emit()
  }

  private rebaseNewerLocalPatch(localAtRequest: WorkspaceDocument, currentLocalPatch: WorkspaceDocument, committed: WorkspaceDocument): { document: WorkspaceDocument; changedIds: string[] } {
    const changedIds = getChangedPlanIds(localAtRequest, currentLocalPatch)
    return { document: this.applyDraftChanges(committed, currentLocalPatch, changedIds), changedIds }
  }

  private rebaseRemoteDrafts(parentRevision: string, committed: WorkspaceDocument, revision: string, committedChangedIds: string[]): void {
    const currentDrafts = [...this.remoteDrafts.values()]
    this.remoteDrafts.clear()
    for (const draft of currentDrafts) {
      if (draft.parentRevision !== parentRevision) continue
      const overlaps = draft.changedPlanIds.some((id) => committedChangedIds.includes(id))
      if (overlaps) continue
      const rebasedDocument = this.applyDraftChanges(committed, draft.document, draft.changedPlanIds)
      this.remoteDrafts.set(draft.clientId, { ...draft, parentRevision: revision, document: rebasedDocument, expiresAt: this.getNow() + this.draftTtl })
    }
  }

  private rebaseIncomingDrafts(parentRevision: string, committed: WorkspaceDocument, revision: string, committedChangedIds: string[], senderId: string): void {
    const currentDrafts = [...this.remoteDrafts.values()]
    this.remoteDrafts.clear()
    for (const draft of currentDrafts) {
      if (draft.clientId === senderId || draft.parentRevision !== parentRevision) continue
      if (draft.changedPlanIds.some((id) => committedChangedIds.includes(id))) continue
      const rebasedDocument = this.applyDraftChanges(committed, draft.document, draft.changedPlanIds)
      this.remoteDrafts.set(draft.clientId, { ...draft, parentRevision: revision, document: rebasedDocument, expiresAt: this.getNow() + this.draftTtl })
    }
  }

  private applyOwnCommit(result: CommitSuccess, parentRevision: string, notice: string, conflictKey?: string, changedIds: string[] = [], shouldEmit = true, clearDrafts = false): void {
    this.committedDocument = clone(result.document)
    this.baseRevision = result.revision
    this.localDocument = null
    this.localChangedPlanIds = []
    if (clearDrafts) this.remoteDrafts.clear()
    else this.rebaseRemoteDrafts(parentRevision, result.document, result.revision, changedIds)
    this.saveError = false
    this.notice = notice
    this.knownCommits.set(parentRevision, { clientId: this.clientId, parentRevision, changedPlanIds: changedIds })
    this.clearTimers()
    this.channel.post({
      type: 'commit',
      clientId: this.clientId,
      parentRevision,
      baseRevision: result.revision,
      revision: result.revision,
      document: clone(result.document),
      changedPlanIds: changedIds,
      conflictKey,
      winnerClientId: this.clientId,
    } satisfies CommitMessage)
    if (shouldEmit) this.emit()
  }

  private handleMessage(message: SyncMessage): void {
    if (message.clientId === this.clientId) return
    if (message.type === 'draft') this.handleDraft(message)
    if (message.type === 'commit') this.handleCommit(message)
    if (message.type === 'conflict') this.handleConflictMessage(message)
  }

  private handleDraft(message: DraftMessage): void {
    if (!this.committedDocument || this.phase === 'conflict' || message.parentRevision !== this.baseRevision) return
    const existing = this.remoteDrafts.get(message.clientId)
    if (existing && existing.sentAt >= message.sentAt) return
    this.remoteDrafts.set(message.clientId, { ...clone(message), expiresAt: this.getNow() + this.draftTtl })

    if (this.localDocument) {
      const overlap = this.localChangedPlanIds.filter((id) => message.changedPlanIds.includes(id))
      if (overlap.length > 0) {
        const remote = this.composeRemoteDrafts(this.committedDocument)
        this.openConflict(this.localDocument, remote.document, this.localChangedPlanIds, this.getRemoteChangedIds(), message.clientId, true)
        return
      }
      this.notice = '已合并另一个窗口的实时修改'
    } else {
      this.notice = '另一个窗口正在编辑，此窗口暂时只读'
    }
    this.emit()
  }

  private handleCommit(message: CommitMessage): void {
    if (!this.committedDocument) return
    this.knownCommits.set(message.parentRevision, { clientId: message.clientId, parentRevision: message.parentRevision, changedPlanIds: message.changedPlanIds })
    this.knownCommits.set(message.revision, { clientId: message.winnerClientId ?? message.clientId, parentRevision: message.parentRevision, changedPlanIds: message.changedPlanIds })
    if (this.phase === 'conflict' && this.conflict?.key === message.conflictKey) {
      this.committedDocument = clone(message.document)
      this.baseRevision = message.revision
      this.localDocument = null
      this.localChangedPlanIds = []
      this.remoteDrafts.clear()
      this.phase = 'ready'
      this.conflict = null
      this.notice = '冲突已解决，已恢复同步'
      this.clearTimers()
      this.emit()
      return
    }
    if (this.phase === 'conflict' && this.conflict) {
      const currentConflict = this.conflict
      if (currentConflict.remoteClientId === message.clientId && message.parentRevision === currentConflict.parentRevision) {
        const currentKey = `commit:${[...new Set([...currentConflict.localChangedPlanIds, ...message.changedPlanIds])].sort().join(',')}`
        if (currentConflict.key === currentKey) {
          this.committedDocument = clone(message.document)
          this.baseRevision = message.revision
          this.conflict = { ...currentConflict, storageRevision: message.revision, remoteDocument: clone(message.document) }
          this.localDocument = clone(currentConflict.localDocument)
          this.localChangedPlanIds = currentConflict.localChangedPlanIds
          this.notice = '检测到同一方案被同时修改，请选择以哪边为准'
          this.emit()
          return
        }
      }
      return
    }

    if (message.revision === this.baseRevision) return

    if (message.parentRevision === this.baseRevision) {
      if (this.localDocument) {
        const merged = mergePlanDocuments(this.committedDocument, this.localDocument, message.document, this.localChangedPlanIds, message.changedPlanIds, true)
        if (!merged.document) {
          this.openConflict(this.localDocument, message.document, this.localChangedPlanIds, message.changedPlanIds, message.clientId, false)
          return
        }
        this.committedDocument = clone(message.document)
        this.baseRevision = message.revision
        this.localDocument = merged.document
        this.localChangedPlanIds = this.localChangedPlanIds.filter((id) => !message.changedPlanIds.includes(id))
        this.rebaseIncomingDrafts(message.parentRevision, message.document, message.revision, message.changedPlanIds, message.clientId)
        if (this.localChangedPlanIds.length === 0) this.localDocument = null
        this.notice = '已同步其他窗口的保存，本窗口未保存的修改仍保留'
      } else {
        this.committedDocument = clone(message.document)
        this.baseRevision = message.revision
        this.rebaseIncomingDrafts(message.parentRevision, message.document, message.revision, message.changedPlanIds, message.clientId)
        this.notice = '已同步其他窗口的修改'
      }
      this.emit()
      return
    }
    this.notice = '同步版本落后，正在等待最新数据'
    this.emit()
  }

  private handleConflictMessage(message: ConflictMessage): void {
    if (this.phase === 'conflict' || !this.committedDocument) return
    const isLocalSide = message.localClientId === this.clientId
    const isRemoteSide = message.remoteClientId === this.clientId
    if (!isLocalSide && !isRemoteSide) return
    const ownDocument = isLocalSide ? message.localDocument : message.remoteDocument
    this.baseRevision = message.storageRevision
    this.localDocument = clone(ownDocument)
    this.localChangedPlanIds = isLocalSide ? message.localChangedPlanIds : message.remoteChangedPlanIds
    this.phase = 'conflict'
    this.conflict = {
      key: message.key,
      localClientId: this.clientId,
      remoteClientId: isLocalSide ? message.remoteClientId : message.localClientId,
      storageRevision: message.storageRevision,
      parentRevision: message.parentRevision,
      localDocument: clone(ownDocument),
      remoteDocument: clone(isLocalSide ? message.remoteDocument : message.localDocument),
      localChangedPlanIds: isLocalSide ? message.localChangedPlanIds : message.remoteChangedPlanIds,
      remoteChangedPlanIds: isLocalSide ? message.remoteChangedPlanIds : message.localChangedPlanIds,
    }
    this.notice = '检测到同一方案被同时修改，请选择以哪边为准'
    this.emit()
  }

  private openConflict(localDocument: WorkspaceDocument, remoteDocument: WorkspaceDocument, localIds: string[], remoteIds: string[], remoteClientId: string, isDraft: boolean, remoteActualIds = remoteIds, parentRevision = this.baseRevision, storageRevision = this.baseRevision, localIsLoser = false): void {
    const changed = [...new Set([...localIds, ...remoteActualIds])].sort()
    const key = `${isDraft ? 'draft' : 'commit'}:${changed.join(',')}`
    this.phase = 'conflict'
    this.conflict = {
      key,
      localClientId: this.clientId,
      remoteClientId,
      storageRevision,
      parentRevision,
      localDocument: clone(localDocument),
      remoteDocument: clone(remoteDocument),
      localChangedPlanIds: localIds,
      remoteChangedPlanIds: remoteIds,
    }
    const winnerDocument = localIsLoser ? remoteDocument : localDocument
    const loserDocument = localIsLoser ? localDocument : remoteDocument
    const winnerClientId = localIsLoser ? remoteClientId : this.clientId
    const loserClientId = localIsLoser ? this.clientId : remoteClientId
    this.notice = '同一方案在两个窗口中被同时修改'
    this.channel.post({
      type: 'conflict',
      key,
      clientId: this.clientId,
      parentRevision,
      storageRevision,
      localClientId: winnerClientId,
      remoteClientId: loserClientId,
      localDocument: clone(winnerDocument),
      remoteDocument: clone(loserDocument),
      localChangedPlanIds: localIsLoser ? remoteActualIds : localIds,
      remoteChangedPlanIds: localIsLoser ? localIds : remoteIds,
      localIsWinner: !localIsLoser,
    } satisfies ConflictMessage)
    this.emit()
  }

  private sweepDrafts(): void {
    const now = this.getNow()
    let changed = false
    for (const [clientId, draft] of this.remoteDrafts) {
      if (draft.expiresAt <= now) {
        this.remoteDrafts.delete(clientId)
        changed = true
      }
    }
    if (changed) {
      this.notice = this.localDocument ? '过期的临时修改已移除' : '同步已恢复，可以继续编辑'
      this.emit()
    }
  }

  private clearTimers(): void {
    if (this.draftTimer) clearTimeout(this.draftTimer)
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.draftTimer = null
    this.flushTimer = null
  }
}
