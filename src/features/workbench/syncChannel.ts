import type { WorkspaceDocument } from '../../shared/models'

export const SYNC_CHANNEL_NAME = 'focusdesk.workspace.sync.v1'

export interface DraftMessage {
  type: 'draft'
  clientId: string
  parentRevision: string
  document: WorkspaceDocument
  changedPlanIds: string[]
  sentAt: number
}

export interface CommitMessage {
  type: 'commit'
  clientId: string
  parentRevision: string
  baseRevision: string
  revision: string
  document: WorkspaceDocument
  changedPlanIds: string[]
  conflictKey?: string
  winnerClientId?: string
}

export interface ConflictMessage {
  type: 'conflict'
  key: string
  clientId: string
  parentRevision: string
  storageRevision: string
  localClientId: string
  remoteClientId: string
  localDocument: WorkspaceDocument
  remoteDocument: WorkspaceDocument
  localChangedPlanIds: string[]
  remoteChangedPlanIds: string[]
  localIsWinner: boolean
}

export type SyncMessage = DraftMessage | CommitMessage | ConflictMessage

export interface SyncChannel {
  post(message: SyncMessage): void
  subscribe(listener: (message: SyncMessage) => void): () => void
  close(): void
}

export class BroadcastSyncChannel implements SyncChannel {
  private readonly channel: BroadcastChannel | null
  private readonly listeners = new Set<(message: SyncMessage) => void>()

  constructor(name = SYNC_CHANNEL_NAME) {
    this.channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(name)
    this.channel?.addEventListener('message', (event: MessageEvent<SyncMessage>) => {
      const message = JSON.parse(JSON.stringify(event.data)) as SyncMessage
      this.listeners.forEach((listener) => listener(message))
    })
  }

  post(message: SyncMessage): void {
    this.channel?.postMessage(message)
  }

  subscribe(listener: (message: SyncMessage) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  close(): void {
    this.listeners.clear()
    this.channel?.close()
  }
}

export function createClientId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return `client:${crypto.randomUUID()}`
  return `client:${Date.now()}-${Math.random().toString(16).slice(2)}`
}
