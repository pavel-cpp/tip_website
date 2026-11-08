import type { RealtimeEvent } from './client'

/** The part of RealtimeClient the lease needs. */
export interface LeaseClient {
  acquire(rowId: string): boolean
  release(rowId: string): boolean
  onEvent(cb: (e: RealtimeEvent) => void): () => void
}

/**
 * Row lock lease. A row is acquired before editing and released on blur, finish or cancel. The server
 * extends every lock of a connection on each heartbeat ping (the client sends one every 15 s) and drops
 * a lock that was not renewed for 45 s. Locks die with the socket, so rows still being edited are
 * acquired again after every reconnect; when the page goes to the background they are released and
 * taken back once the tab returns.
 */
export class LockLease {
  private readonly wanted = new Set<string>()
  private suspended = false
  private readonly off: () => void

  constructor(
    private readonly client: LeaseClient,
    private readonly onDenied: (rowId: string, by: string) => void,
  ) {
    this.off = client.onEvent((e) => {
      if (e.type === 'hello') {
        this.suspended = false
        for (const id of this.wanted) this.client.acquire(id)
      } else if (e.type === 'hidden') {
        this.suspended = true
        for (const id of this.wanted) this.client.release(id)
      } else if (e.type === 'lock.denied' && this.wanted.delete(e.rowId)) {
        this.onDenied(e.rowId, e.by)
      }
    })
  }

  get held(): ReadonlySet<string> {
    return this.wanted
  }

  acquire(rowId: string): void {
    this.wanted.add(rowId)
    if (!this.suspended) this.client.acquire(rowId)
  }

  release(rowId: string): void {
    if (this.wanted.delete(rowId)) this.client.release(rowId)
  }

  releaseAll(): void {
    for (const id of this.wanted) this.client.release(id)
    this.wanted.clear()
  }

  dispose(): void {
    this.releaseAll()
    this.off()
  }
}
