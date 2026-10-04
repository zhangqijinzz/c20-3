import type { WorkspaceDocument } from '../../shared/models'
import { createInitialDocument } from '../../shared/models'
import { NULL_REVISION, type CommitOutcome, type DocumentStore, type StoredRecord } from '../workbench/storageService'
import type { CommitNotice, SyncBus, SyncMessage } from './syncBus'
import { EMPTY_DOCUMENT, mergeDocuments, sameDocument, type ConflictDetail, type MergePreference } from './threeWayMerge'

export type SyncPhase = 'loading' | 'live' | 'stale'

export interface SyncNotice {
  id: number
  message: string
  kind: 'info' | 'success' | 'error'
}

export interface SyncSnapshot {
  phase: SyncPhase
  document: WorkspaceDocument
  revision: number
  conflicts: ConflictDetail[]
  /** 是否有本地改动正在排队或正在落盘（驱动“保存中…”提示）。 */
  pending: boolean
  /** 最近一次提交是否失败。 */
  saveError: boolean
  channelHealthy: boolean
  notice: SyncNotice | null
}

export interface SyncSessionOptions {
  clientId?: string
  /** 本地编辑后多久合并落盘一次，拖动过程中只在内存改尺寸，不频繁写库。 */
  debounceMs?: number
  /** 单个提交在连续 CAS 竞争下的最多合并重试次数。 */
  maxCommitAttempts?: number
}

type Subscriber = (snapshot: SyncSnapshot) => void

function defaultClientId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `window-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export class SyncSession {
  readonly clientId: string
  private readonly debounceMs: number
  private readonly maxCommitAttempts: number

  private phase: SyncPhase = 'loading'
  private document: WorkspaceDocument = EMPTY_DOCUMENT
  private baseDocument: WorkspaceDocument = EMPTY_DOCUMENT
  private revision = NULL_REVISION
  private conflicts: ConflictDetail[] = []
  private pending = false
  private saveError = false
  private notice: SyncNotice | null = null
  private noticeCounter = 0

  private staleBase: WorkspaceDocument | null = null
  private staleLocal: WorkspaceDocument | null = null
  private staleRemote: StoredRecord | null = null

  private initialized = false
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private noticeTimer: ReturnType<typeof setTimeout> | null = null
  private subscribers = new Set<Subscriber>()
  private snapshotCache: SyncSnapshot | null = null
  private tail: Promise<unknown> = Promise.resolve()
  private unsubscribeBus: (() => void) | null = null
  private visibilityHandler: (() => void) | null = null

  constructor(
    private readonly store: DocumentStore,
    private readonly bus: SyncBus,
    options: SyncSessionOptions = {},
  ) {
    this.clientId = options.clientId ?? defaultClientId()
    this.debounceMs = options.debounceMs ?? 220
    this.maxCommitAttempts = options.maxCommitAttempts ?? 10
  }

  // ---- 对外的只读状态 ----

  getSnapshot(): SyncSnapshot {
    if (!this.snapshotCache) {
      this.snapshotCache = {
        phase: this.phase,
        document: this.document,
        revision: this.revision,
        conflicts: this.conflicts,
        pending: this.pending,
        saveError: this.saveError,
        channelHealthy: this.bus.healthy,
        notice: this.notice,
      }
    }
    return this.snapshotCache
  }

  subscribe(handler: Subscriber): () => void {
    this.subscribers.add(handler)
    return () => this.subscribers.delete(handler)
  }

  // ---- 生命周期 ----

  start(): void {
    if (this.unsubscribeBus === null) {
      this.unsubscribeBus = this.bus.subscribe((message) => this.enqueue(() => this.handleIncoming(message)))
      if (typeof window !== 'undefined') {
        this.visibilityHandler = () => this.refresh()
        window.addEventListener('visibilitychange', this.visibilityHandler)
        window.addEventListener('focus', this.visibilityHandler)
      }
    }
    this.enqueue(() => this.initialize())
  }

  dispose(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (this.noticeTimer !== null) {
      clearTimeout(this.noticeTimer)
      this.noticeTimer = null
    }
    this.unsubscribeBus?.()
    this.unsubscribeBus = null
    if (this.visibilityHandler && typeof window !== 'undefined') {
      window.removeEventListener('visibilitychange', this.visibilityHandler)
      window.removeEventListener('focus', this.visibilityHandler)
    }
    this.visibilityHandler = null
  }

  // ---- 本地编辑入口 ----

  /**
   * 登记一次本地编辑。只更新内存并安排一次合并落盘；过期（只读）窗口的编辑直接忽略。
   * 空闲窗口不会调用这里，因此绝不会把无人操作的数据写回去。
   */
  edit(nextDocument: WorkspaceDocument): void {
    if (this.phase !== 'live') return
    if (sameDocument(nextDocument, this.document)) return
    this.document = nextDocument
    this.pending = true
    this.saveError = false
    this.scheduleFlush()
    this.emit()
  }

  /** 立即落盘（切换标签页 / 关闭窗口前调用）。 */
  flushNow(): void {
    if (this.phase !== 'live' || this.flushTimer === null) return
    clearTimeout(this.flushTimer)
    this.flushTimer = null
    this.enqueue(() => this.runCommit(undefined))
  }

  /** 从存储主动拉取最新修订（窗口重新获得焦点时用，兜底丢失的广播）。 */
  refresh(): Promise<void> {
    return this.enqueue(async () => {
      const record = await this.store.read()
      if (record && record.revision > this.revision) {
        await this.applyIncomingRecord(record)
      }
    })
  }

  // ---- 冲突裁决 ----

  /**
   * 用户在冲突横幅里做出选择：
   * - 'local'：以本窗口内容为准（其他窗口不冲突的改动仍会保留）；
   * - 'remote'：以其他窗口为准（本窗口不冲突的改动仍会保留）。
   * 裁决后窗口回到 live，可继续编辑。
   */
  resolveConflict(preference: MergePreference): Promise<void> {
    return this.enqueue(() => {
      if (this.phase !== 'stale' || !this.staleRemote || !this.staleBase || !this.staleLocal) return Promise.resolve()
      const remote = this.staleRemote
      const merged = mergeDocuments(this.staleBase, this.staleLocal, remote.document, preference)
      this.baseDocument = remote.document
      this.revision = remote.revision
      this.document = merged.document
      this.conflicts = []
      this.staleBase = null
      this.staleLocal = null
      this.staleRemote = null
      this.phase = 'live'
      this.emit()

      if (sameDocument(merged.document, remote.document)) {
        this.pending = false
        this.notify(preference === 'remote' ? '已采用其他窗口的方案，窗口恢复可编辑' : '冲突已解决，窗口恢复可编辑', 'success')
        return Promise.resolve()
      }
      this.notify(preference === 'local' ? '已按本窗口内容保存，窗口恢复可编辑' : '已按其他窗口内容合并，窗口恢复可编辑', 'success')
      this.pending = true
      return this.runCommit(preference)
    })
  }

  // ---- 内部：串行任务队列 ----

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task, task)
    this.tail = run.catch(() => undefined)
    return run
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null) clearTimeout(this.flushTimer)
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      if (this.phase !== 'live') {
        this.pending = false
        this.emit()
        return
      }
      void this.enqueue(() => this.runCommit(undefined))
    }, this.debounceMs)
  }

  // ---- 内部：初始化 / 远端消息 ----

  private async initialize(): Promise<void> {
    if (this.initialized) return
    this.initialized = true
    try {
      const record = await this.store.read()
      if (record) {
        this.document = record.document
        this.baseDocument = record.document
        this.revision = record.revision
      } else {
        const initial = createInitialDocument()
        this.document = initial
        this.baseDocument = initial
        this.revision = NULL_REVISION
      }
      this.phase = 'live'
      this.emit()
    } catch {
      const initial = createInitialDocument()
      this.document = initial
      this.baseDocument = initial
      this.phase = 'live'
      this.saveError = true
      this.notify('本地数据读取失败，当前使用临时工作台', 'error')
    }
  }

  private async handleIncoming(message: SyncMessage): Promise<void> {
    if (message.type !== 'commit') return
    if (message.committer === this.clientId) return
    if (message.revision <= this.revision) return
    await this.applyIncomingRecord({ revision: message.revision, document: message.document, committer: message.committer })
  }

  /** 应用一份比本地更新的存储记录：空闲窗口热更新不落盘；有未保存改动则三方合并。 */
  private async applyIncomingRecord(record: StoredRecord): Promise<void> {
    if (this.phase === 'stale') {
      await this.applyIncomingWhileStale(record)
      return
    }

    const localDirty = !sameDocument(this.baseDocument, this.document)
    if (!localDirty) {
      // 没人在这个窗口操作：只热更新内存，绝不回写。
      const changedName = guessChangedPlanName(this.baseDocument, record.document)
      this.document = record.document
      this.baseDocument = record.document
      this.revision = record.revision
      this.notify(`已同步其他窗口在「${changedName}」的改动`, 'info')
      return
    }

    const merged = mergeDocuments(this.baseDocument, this.document, record.document)
    if (merged.conflicts.length > 0) {
      this.enterStale(merged.conflicts, record)
      return
    }
    this.document = merged.document
    this.baseDocument = record.document
    this.revision = record.revision
    this.notify('已合并其他窗口的改动', 'success')
    // pending 保持 true：本窗口自己的改动仍会由定时任务提交
  }

  private async applyIncomingWhileStale(record: StoredRecord): Promise<void> {
    if (!this.staleBase || !this.staleLocal) return
    const merged = mergeDocuments(this.staleBase, this.staleLocal, record.document)
    if (merged.conflicts.length > 0) {
      this.conflicts = merged.conflicts
      this.staleRemote = record
      this.emit()
      return
    }
    // 对端后续提交把冲突消掉了（例如撤销了改动），自动恢复为可编辑
    this.phase = 'live'
    this.conflicts = []
    this.staleBase = null
    this.staleLocal = null
    this.staleRemote = null
    this.document = merged.document
    this.baseDocument = record.document
    this.revision = record.revision
    this.pending = false
    this.notify('其他窗口的改动已同步，窗口恢复可编辑', 'success')
  }

  private enterStale(conflicts: ConflictDetail[], remote: StoredRecord): void {
    this.phase = 'stale'
    this.conflicts = conflicts
    this.staleBase = this.baseDocument
    this.staleLocal = this.document
    this.staleRemote = remote
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    this.pending = false
    this.notify('检测到其他窗口同时修改了同一方案，本窗口已转为只读', 'error')
  }

  // ---- 内部：提交（CAS + 自动合并不冲突的改动）----

  private async runCommit(preference: MergePreference | undefined): Promise<void> {
    for (let attempt = 0; attempt < this.maxCommitAttempts; attempt += 1) {
      if (this.phase !== 'live') return
      const candidate = this.document
      if (sameDocument(candidate, this.baseDocument)) {
        this.pending = false
        this.emit()
        return
      }

      const outcome: CommitOutcome = await this.store.commit(this.revision, candidate, this.clientId)
      if (outcome.ok) {
        this.document = outcome.record.document
        this.baseDocument = outcome.record.document
        this.revision = outcome.record.revision
        this.pending = false
        this.saveError = false
        this.bus.post(buildNotice(outcome.record))
        this.emit()
        return
      }

      // CAS 失败：存储里已经有更新的修订。以共同基址做三方合并后重试。
      const current = outcome.current
      if (current.revision <= this.revision) {
        this.failCommit('保存失败：本地存储状态异常，请稍后重试')
        return
      }
      const merged = mergeDocuments(this.baseDocument, candidate, current.document, preference)
      if (!preference && merged.conflicts.length > 0) {
        this.enterStale(merged.conflicts, current)
        return
      }
      this.document = merged.document
      this.baseDocument = current.document
      this.revision = current.revision
      if (sameDocument(merged.document, current.document)) {
        // 本地改动与对端最终内容一致，无需再写
        this.pending = false
        this.emit()
        return
      }
      // 带着合并结果继续下一轮 CAS
    }
    this.failCommit('保存失败：多个窗口同时修改过于频繁，请稍后重试')
  }

  private failCommit(message: string): void {
    this.pending = false
    this.saveError = true
    this.notify(message, 'error')
  }

  // ---- 通知 / 状态分发 ----

  private notify(message: string, kind: SyncNotice['kind']): void {
    this.noticeCounter += 1
    this.notice = { id: this.noticeCounter, message, kind }
    this.emit()
    if (this.noticeTimer !== null) clearTimeout(this.noticeTimer)
    this.noticeTimer = setTimeout(() => {
      this.noticeTimer = null
      this.notice = null
      this.emit()
    }, kind === 'error' ? 6000 : 3500)
  }

  private emit(): void {
    this.snapshotCache = null
    const snapshot = this.getSnapshot()
    this.subscribers.forEach((handler) => handler(snapshot))
  }
}

function buildNotice(record: StoredRecord): CommitNotice {
  return { type: 'commit', revision: record.revision, committer: record.committer, document: record.document }
}

function guessChangedPlanName(before: WorkspaceDocument, after: WorkspaceDocument): string {
  const beforeMap = new Map(before.plans.map((plan) => [plan.id, plan]))
  const changed = after.plans.find((plan) => JSON.stringify(beforeMap.get(plan.id)) !== JSON.stringify(plan))
  return changed?.name ?? '方案'
}
