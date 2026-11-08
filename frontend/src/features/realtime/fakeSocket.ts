import type { SocketLike } from './client'

/** Test double for the browser WebSocket: records sent frames and lets tests drive server events. */
export class FakeSocket implements SocketLike {
  static instances: FakeSocket[] = []
  static reset(): void {
    FakeSocket.instances = []
  }
  static get last(): FakeSocket {
    const s = FakeSocket.instances[FakeSocket.instances.length - 1]
    if (!s) throw new Error('no socket created yet')
    return s
  }

  readyState = 0
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: { code: number }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  sent: Array<Record<string, unknown>> = []
  closedWith: number | undefined

  constructor(readonly url: string) {
    FakeSocket.instances.push(this)
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>)
  }

  close(code?: number): void {
    this.closedWith = code
    this.readyState = 3
  }

  // ---- server side

  open(): void {
    this.readyState = 1
    this.onopen?.({})
  }

  receive(frame: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }

  serverClose(code: number): void {
    this.readyState = 3
    this.onclose?.({ code })
  }

  frames(t: string): Array<Record<string, unknown>> {
    return this.sent.filter((f) => f.t === t)
  }
}
