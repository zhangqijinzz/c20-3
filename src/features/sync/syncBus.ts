import type { StoredRecord } from '../workbench/storageService'

/** 一次成功提交后广播给同机其他窗口的消息。 */
export interface CommitNotice {
  type: 'commit'
  revision: number
  committer: string
  document: StoredRecord['document']
}

export type SyncMessage = CommitNotice

export interface SyncBus {
  /** 是否可用（BroadcastChannel 创建失败时仍可降级，但跨窗口实时性会变差）。 */
  readonly healthy: boolean
  post(message: SyncMessage): void
  subscribe(handler: (message: SyncMessage) => void): () => void
  close?(): void
}

const CHANNEL_NAME = 'focusdesk.sync.v1'
const FALLBACK_STORAGE_KEY = 'focusdesk.sync.bus.v1'

export class BrowserSyncBus implements SyncBus {
  private channel: BroadcastChannel | null = null
  private listeners = new Set<(message: SyncMessage) => void>()
  private storageHandler: ((event: StorageEvent) => void) | null = null

  constructor() {
    try {
      this.channel = new BroadcastChannel(CHANNEL_NAME)
      this.channel.onmessage = (event: MessageEvent<SyncMessage>) => this.dispatch(event.data)
    } catch {
      this.channel = null
    }
    if (!this.channel && typeof window !== 'undefined') {
      this.storageHandler = (event: StorageEvent) => {
        if (event.key !== FALLBACK_STORAGE_KEY || !event.newValue) return
        try {
          this.dispatch(JSON.parse(event.newValue) as SyncMessage)
        } catch {
          // 忽略无法解析的兜底消息
        }
      }
      window.addEventListener('storage', this.storageHandler)
    }
  }

  get healthy(): boolean {
    return this.channel !== null
  }

  post(message: SyncMessage): void {
    if (this.channel) {
      this.channel.postMessage(message)
      return
    }
    try {
      // storage 事件只在其他窗口触发，天然不会回环给自己
      window.localStorage.setItem(FALLBACK_STORAGE_KEY, JSON.stringify({ ...message, at: Date.now() }))
    } catch {
      // 连 localStorage 都不可用时，窗口间退化为聚焦时轮询
    }
  }

  subscribe(handler: (message: SyncMessage) => void): () => void {
    this.listeners.add(handler)
    return () => this.listeners.delete(handler)
  }

  close(): void {
    this.dispose()
  }

  private dispose(): void {
    this.channel?.close()
    this.channel = null
    if (this.storageHandler && typeof window !== 'undefined') {
      window.removeEventListener('storage', this.storageHandler)
    }
    this.listeners.clear()
  }
}
