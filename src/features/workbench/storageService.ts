import type { WorkspaceDocument } from '../../shared/models'

export const STORAGE_KEY = 'focusdesk.document.v1'
const DATABASE_NAME = 'focusdesk-db'
const STORE_NAME = 'workspace'
export const SEED_REVISION = 'seed:00000000-0000-0000-0000-000000000001'
const LEGACY_REVISION = 'legacy:00000000-0000-0000-0000-000000000001'

export interface StoredValue {
  document: WorkspaceDocument
  revision: string | null
  winnerClientId?: string
}

export interface CommitSuccess {
  committed: true
  document: WorkspaceDocument
  revision: string
  winnerClientId?: string
}

export interface CommitConflict {
  committed: false
  document: WorkspaceDocument
  revision: string
  winnerClientId?: string
}

export interface EmptyStorageConflict {
  committed: false
  document: null
  revision: null
}

export interface StorageService {
  read(): Promise<StoredValue | null>
  write(value: string): Promise<void>
  commit(value: string, expectedRevision: string | null, winnerClientId?: string): Promise<CommitSuccess | CommitConflict | EmptyStorageConflict>
}

function createRevision(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return `rev:${crypto.randomUUID()}`
  return `rev:${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export class BrowserStorageService implements StorageService {
  async read(): Promise<StoredValue | null> {
    try {
      const database = await openDatabase()
      const value = await readFromDatabase(database)
      database.close()
      const parsed = parseStoredValue(typeof value === 'string' ? value : window.localStorage.getItem(STORAGE_KEY))
      return parsed
    } catch {
      return parseStoredValue(window.localStorage.getItem(STORAGE_KEY))
    }
  }

  async write(value: string): Promise<void> {
    try {
      const database = await openDatabase()
      await writeToDatabase(database, value)
      database.close()
    } catch {
      window.localStorage.setItem(STORAGE_KEY, value)
    }
  }

  async commit(value: string, expectedRevision: string | null, winnerClientId?: string): Promise<CommitSuccess | CommitConflict | EmptyStorageConflict> {
    const current = await this.read()
    const currentRevision = current?.revision ?? null
    const isLegacySeed = expectedRevision === SEED_REVISION && (currentRevision === null || currentRevision === LEGACY_REVISION)
    if (currentRevision !== expectedRevision && !isLegacySeed) {
      return current ? { committed: false, document: current.document, revision: currentRevision ?? LEGACY_REVISION, winnerClientId: current.winnerClientId } : { committed: false, document: null, revision: null }
    }
    const revision = createRevision()
    const envelope = JSON.stringify({ document: JSON.parse(value) as WorkspaceDocument, revision, winnerClientId })
    await this.write(envelope)
    return { committed: true, document: JSON.parse(value) as WorkspaceDocument, revision, winnerClientId }
  }
}

function parseStoredValue(raw: string | null): StoredValue | null {
  if (!raw) return null
  const parsed: unknown = JSON.parse(raw)
  if (parsed && typeof parsed === 'object' && 'document' in parsed && 'revision' in parsed) {
    const candidate = parsed as { document: WorkspaceDocument; revision: string | null; winnerClientId?: string }
    return isWorkspaceDocument(candidate.document) ? { document: candidate.document, revision: typeof candidate.revision === 'string' ? candidate.revision : null, winnerClientId: candidate.winnerClientId } : null
  }
  return isWorkspaceDocument(parsed) ? { document: parsed, revision: LEGACY_REVISION } : null
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DATABASE_NAME, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'))
  })
}

function readFromDatabase(database: IDBDatabase): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(STORAGE_KEY)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB read failed'))
  })
}

function writeToDatabase(database: IDBDatabase, value: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = database.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(value, STORAGE_KEY)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error ?? new Error('IndexedDB write failed'))
  })
}

export function isWorkspaceDocument(value: unknown): value is WorkspaceDocument {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<WorkspaceDocument>
  return candidate.version === 1 && Array.isArray(candidate.plans) && typeof candidate.activePlanId === 'string'
}
