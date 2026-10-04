import { createInitialDocument, type WorkspaceDocument } from '../../shared/models'
import { BrowserStorageService, isWorkspaceDocument, SEED_REVISION, type CommitSuccess, type EmptyStorageConflict, type StorageService } from './storageService'

export interface SaveConflict {
  committed: false
  document: WorkspaceDocument
  revision: string
  winnerClientId?: string
}

export type SaveResult = CommitSuccess | SaveConflict | EmptyStorageConflict

export interface WorkspaceRepository {
  load(): Promise<{ document: WorkspaceDocument | null; revision: string | null }>
  save(document: WorkspaceDocument, expectedRevision: string | null, winnerClientId?: string): Promise<SaveResult>
}

export class LocalWorkspaceRepository implements WorkspaceRepository {
  constructor(private readonly storage: StorageService = new BrowserStorageService()) {}

  async load(): Promise<{ document: WorkspaceDocument | null; revision: string | null }> {
    try {
      const stored = await this.storage.read()
      if (!stored) return { document: null, revision: null }
      return isWorkspaceDocument(stored.document) ? stored : { document: null, revision: stored.revision }
    } catch {
      return { document: null, revision: null }
    }
  }

  async save(document: WorkspaceDocument, expectedRevision: string | null, winnerClientId?: string): Promise<SaveResult> {
    return this.storage.commit(JSON.stringify(document), expectedRevision ?? SEED_REVISION, winnerClientId)
  }
}

export function getInitialDocument(document: WorkspaceDocument | null): WorkspaceDocument {
  return document ?? createInitialDocument()
}
