import type { WorkspaceDocument } from '../../../shared/models'
import { SEED_REVISION, type StorageService } from '../storageService'
import type { WorkspaceRepository, SaveResult } from '../workspaceRepository'
import type { SyncChannel, SyncMessage } from '../syncChannel'

export class SharedMemoryStorage implements StorageService {
  constructor(private value: { document: string; revision: string | null; winnerClientId?: string } | null = null) {}

  async read(): Promise<{ document: WorkspaceDocument; revision: string | null } | null> {
    if (!this.value) return null
    return { document: JSON.parse(this.value.document) as WorkspaceDocument, revision: this.value.revision }
  }

  async write(next: string): Promise<void> {
    this.value = { document: next, revision: this.value?.revision ?? SEED_REVISION }
  }

  async commit(next: string, expectedRevision: string | null, winnerClientId?: string): Promise<SaveResult> {
    const currentRevision = this.value?.revision ?? null
    const expected = expectedRevision === SEED_REVISION && (currentRevision === null || currentRevision === SEED_REVISION) ? null : expectedRevision
    if (currentRevision !== expected) {
      return this.value ? { committed: false as const, document: JSON.parse(this.value.document) as WorkspaceDocument, revision: currentRevision ?? SEED_REVISION, winnerClientId: this.value.winnerClientId } : { committed: false as const, document: null, revision: null }
    }
    const revision = `rev-test-${Math.random()}`
    this.value = { document: next, revision, winnerClientId }
    return { committed: true as const, document: JSON.parse(next) as WorkspaceDocument, revision, winnerClientId }
  }
}

export class MemoryWorkspaceRepository implements WorkspaceRepository {
  constructor(private readonly storage: SharedMemoryStorage) {}
  async load() {
    return (await this.storage.read()) ?? { document: null, revision: null }
  }
  save(document: Parameters<WorkspaceRepository['save']>[0], expectedRevision: string | null, winnerClientId?: string) {
    return this.storage.commit(JSON.stringify(document), expectedRevision, winnerClientId)
  }
}

class MemoryBroadcastBus {
  private static channels = new Map<string, Set<MemorySyncChannel>>()

  constructor(private readonly name: string) {}

  register(channel: MemorySyncChannel): () => void {
    const channels = MemoryBroadcastBus.channels.get(this.name) ?? new Set<MemorySyncChannel>()
    channels.add(channel)
    MemoryBroadcastBus.channels.set(this.name, channels)
    return () => channels.delete(channel)
  }

  post(sender: MemorySyncChannel, message: SyncMessage): void {
    MemoryBroadcastBus.channels.get(this.name)?.forEach((channel) => {
      if (channel !== sender) channel.deliver(JSON.parse(JSON.stringify(message)) as SyncMessage)
    })
  }
}

export class MemorySyncChannel implements SyncChannel {
  private readonly listeners = new Set<(message: SyncMessage) => void>()
  private readonly bus = new MemoryBroadcastBus('test-sync')
  private readonly unregister: () => void
  private paused = false
  private readonly queued: SyncMessage[] = []

  constructor() {
    this.unregister = this.bus.register(this)
  }

  setPaused(paused: boolean): void {
    this.paused = paused
    if (!paused) this.flushQueued()
  }

  flushQueued(): void {
    const priority = { conflict: 0, commit: 1, draft: 2 }
    const messages = [...this.queued].sort((a, b) => priority[a.type] - priority[b.type])
    this.queued.length = 0
    messages.forEach((message) => this.deliver(message))
  }

  post(message: SyncMessage): void {
    this.bus.post(this, JSON.parse(JSON.stringify(message)) as SyncMessage)
  }

  subscribe(listener: (message: SyncMessage) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  deliver(message: SyncMessage): void {
    if (this.paused) {
      const serialized = JSON.stringify(message)
      if (!this.queued.some((queued) => JSON.stringify(queued) === serialized)) this.queued.push(JSON.parse(serialized) as SyncMessage)
      return
    }
    this.listeners.forEach((listener) => listener(message))
  }

  close(): void {
    this.listeners.clear()
    this.unregister()
  }
}
