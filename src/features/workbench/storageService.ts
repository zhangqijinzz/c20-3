import type { WorkspaceDocument } from '../../shared/models'

export const STORAGE_KEY = 'focusdesk.document.v1'
const DATABASE_NAME = 'focusdesk-db'
const STORE_NAME = 'workspace'
const LEGACY_PLAIN_KEY = 'focusdesk.document.v1'

/** 首次安装、存储里一条记录都没有时的版本号。 */
export const NULL_REVISION = 0

/**
 * 磁盘上的一条记录：文档本体 + 单调递增的修订号 + 最近一次提交它的窗口。
 * 旧版本存的是“裸文档 JSON”，读取时按 revision 0 迁移。
 */
export interface StoredRecord {
  revision: number
  document: WorkspaceDocument
  committer: string
}

export interface CommitSuccess {
  ok: true
  record: StoredRecord
}

export interface CommitConflict {
  ok: false
  current: StoredRecord
}

export type CommitOutcome = CommitSuccess | CommitConflict

/**
 * 版本化文档存储：写入必须带上“我基于哪个 revision”。
 * 当前 revision 不匹配就拒绝写入并返回最新记录 —— 多窗口下不会发生无声覆盖。
 */
export interface DocumentStore {
  read(): Promise<StoredRecord | null>
  commit(expectedRevision: number, document: WorkspaceDocument, committer: string): Promise<CommitOutcome>
}

export function isWorkspaceDocument(value: unknown): value is WorkspaceDocument {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<WorkspaceDocument>
  return candidate.version === 1 && Array.isArray(candidate.plans) && typeof candidate.activePlanId === 'string'
}

export function toStoredRecord(value: unknown): StoredRecord | null {
  if (!value) return null
  if (typeof value === 'string') {
    try {
      return toStoredRecord(JSON.parse(value))
    } catch {
      return null
    }
  }
  const candidate = value as Partial<StoredRecord>
  if (isWorkspaceDocument(candidate.document) && typeof candidate.revision === 'number') {
    return { revision: candidate.revision, document: candidate.document, committer: String(candidate.committer ?? 'unknown') }
  }
  // 旧格式：裸文档
  if (isWorkspaceDocument(candidate)) {
    return { revision: NULL_REVISION, document: candidate, committer: 'legacy' }
  }
  return null
}

export class BrowserDocumentStore implements DocumentStore {
  async read(): Promise<StoredRecord | null> {
    try {
      const database = await openDatabase()
      const raw = await new Promise<unknown>((resolve, reject) => {
        const request = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(STORAGE_KEY)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error ?? new Error('IndexedDB read failed'))
      })
      database.close()
      const record = toStoredRecord(raw)
      if (record) return record
    } catch {
      // IndexedDB 不可用时落到 localStorage
    }
    try {
      const legacy = window.localStorage.getItem(LEGACY_PLAIN_KEY)
      return toStoredRecord(legacy)
    } catch {
      return null
    }
  }

  async commit(expectedRevision: number, document: WorkspaceDocument, committer: string): Promise<CommitOutcome> {
    try {
      return await this.commitViaIndexedDb(expectedRevision, document, committer)
    } catch {
      return this.commitViaLocalStorage(expectedRevision, document, committer)
    }
  }

  private commitViaIndexedDb(expectedRevision: number, document: WorkspaceDocument, committer: string): Promise<CommitOutcome> {
    return new Promise((resolve, reject) => {
      const request = window.indexedDB.open(DATABASE_NAME, 1)
      request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME)
      request.onsuccess = () => {
        const database = request.result
        const transaction = database.transaction(STORE_NAME, 'readwrite')
        const store = transaction.objectStore(STORE_NAME)
        const getRequest = store.get(STORAGE_KEY)
        getRequest.onsuccess = () => {
          const current = toStoredRecord(getRequest.result)
          const currentRevision = current?.revision ?? NULL_REVISION
          if (currentRevision !== expectedRevision) {
            transaction.abort()
            database.close()
            resolve({ ok: false, current: current ?? { revision: NULL_REVISION, document: { version: 1, plans: [], activePlanId: '' }, committer: 'empty' } })
            return
          }
          const next: StoredRecord = { revision: expectedRevision + 1, document, committer }
          const putRequest = store.put(next, STORAGE_KEY)
          putRequest.onsuccess = () => {
            transaction.oncomplete = () => {
              database.close()
              resolve({ ok: true, record: next })
            }
          }
          putRequest.onerror = () => {
            database.close()
            reject(putRequest.error ?? new Error('IndexedDB write failed'))
          }
        }
        getRequest.onerror = () => {
          database.close()
          reject(getRequest.error ?? new Error('IndexedDB read failed'))
        }
      }
      request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'))
    })
  }

  private commitViaLocalStorage(expectedRevision: number, document: WorkspaceDocument, committer: string): CommitOutcome {
    const current = toStoredRecord(window.localStorage.getItem(LEGACY_PLAIN_KEY))
    const currentRevision = current?.revision ?? NULL_REVISION
    if (currentRevision !== expectedRevision) {
      return { ok: false, current: current ?? { revision: NULL_REVISION, document: { version: 1, plans: [], activePlanId: '' }, committer: 'empty' } }
    }
    const next: StoredRecord = { revision: expectedRevision + 1, document, committer }
    window.localStorage.setItem(LEGACY_PLAIN_KEY, JSON.stringify(next))
    return { ok: true, record: next }
  }
}
