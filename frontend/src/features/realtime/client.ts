import type { Participant } from '../workspace/api'
import {
  CLOSE_POLICY,
  type ClientFrame,
  type CursorPos,
  type LockEntry,
  type Peer,
  type ProjectUpdate,
  type ServerFrame,
} from './protocol'

export type ConnectionState = 'connecting' | 'online' | 'reconnecting' | 'offline'

export interface RealtimeSnapshot {
  state: ConnectionState
  /** Own user id, known after hello. */
  you: string | null
  peers: readonly Peer[]
  cursors: Readonly<Record<string, CursorPos>>
  locks: Readonly<Record<string, LockEntry>>
}

export type RealtimeEvent =
  /** Authenticated and in sync with the room: the owner refetches the rows (resync). */
  | { type: 'hello' }
  | { type: 'rows.upsert'; items: Participant[] }
  | { type: 'rows.delete'; ids: string[] }
  | { type: 'project.updated'; project: ProjectUpdate }
  | { type: 'lock.denied'; rowId: string; by: string }
  | { type: 'error'; code: string; message: string }
  /** The page or tab went to the background: held locks should be released. */
  | { type: 'hidden' }
  /** The session cannot continue (refresh failed or access was revoked); the client has stopped. */
  | { type: 'authLost' }

/** The slice of the browser WebSocket the client relies on; tests supply a fake. */
export interface SocketLike {
  readonly readyState: number
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: ((ev: { code: number }) => void) | null
  onerror: ((ev: unknown) => void) | null
  send(data: string): void
  close(code?: number, reason?: string): void
}

export interface RealtimeOptions {
  url: string
  /** Current in-memory access token. */
  getToken: () => string | null
  /** The shared refresh (one request across callers and tabs). */
  refresh: () => Promise<string>
  /** Subscribes to token rotations so the open socket can be re-authenticated; returns an unsubscribe. */
  onTokenRefreshed?: (cb: () => void) => () => void
  /** True when a failed refresh means the session is really over (not just a network blip). */
  isFatalAuthError?: (e: unknown) => boolean
  /** Called once when the session is lost; the client stops afterwards. */
  onAuthLost?: () => void
  createSocket?: (url: string) => SocketLike
  random?: () => number
}

export const PING_MS = 15_000
/** How long after a ping any frame may take before the connection is declared half-open. */
export const PONG_TIMEOUT_MS = 10_000
export const BACKOFF_MIN_MS = 1000
export const BACKOFF_MAX_MS = 15_000
export const CURSOR_THROTTLE_MS = 100
/** Consecutive failed attempts after which the indicator says "offline" instead of "reconnecting". */
export const OFFLINE_AFTER = 3
/** Ignore a forced reconnect when a connection was started this recently (visibilitychange + pageshow come together). */
const FORCE_DEBOUNCE_MS = 500
const OPEN = 1

/** Exponential backoff 1 s -> 15 s; jitter lowers the delay by up to 25 % so reconnecting tabs spread out. */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.max(0, attempt))
  return Math.round(base * (1 - 0.25 * random()))
}

export function projectSocketUrl(
  projectId: string,
  loc: Pick<Location, 'protocol' | 'host'> = location,
): string {
  const scheme = loc.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${scheme}//${loc.host}/api/v1/projects/${encodeURIComponent(projectId)}/ws`
}

const INITIAL: RealtimeSnapshot = { state: 'offline', you: null, peers: [], cursors: {}, locks: {} }

export class RealtimeClient {
  private snapshot: RealtimeSnapshot = INITIAL
  private readonly subscribers = new Set<() => void>()
  private readonly listeners = new Set<(e: RealtimeEvent) => void>()

  private socket: SocketLike | null = null
  private stopped = true
  private authed = false
  private everOnline = false
  private attempts = 0
  private authRetried = false
  private lastSentToken: string | null = null
  private lastOpenAt = 0

  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private pingTimer: ReturnType<typeof setInterval> | undefined
  private pongTimer: ReturnType<typeof setTimeout> | undefined
  /** Set once the server has answered a ping, so older servers without a pong never trigger the watchdog. */
  private pongSupported = false
  private cursorTimer: ReturnType<typeof setTimeout> | undefined
  private cursorWanted: CursorPos = { rowId: null }
  private cursorSent: CursorPos | null = null
  private cursorSentAt = 0
  private detach: Array<() => void> = []

  constructor(private readonly opts: RealtimeOptions) {}

  // ---- store API (useSyncExternalStore)

  getSnapshot = (): RealtimeSnapshot => this.snapshot

  subscribe = (cb: () => void): (() => void) => {
    this.subscribers.add(cb)
    return () => this.subscribers.delete(cb)
  }

  onEvent(cb: (e: RealtimeEvent) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  // ---- lifecycle

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.attempts = 0
    this.authRetried = false
    this.everOnline = false
    this.attachBrowserEvents()
    this.open()
  }

  /** Permanent shutdown for this start(): no reconnect, timers cleared, socket closed. */
  stop(): void {
    this.stopped = true
    clearTimeout(this.retryTimer)
    clearTimeout(this.cursorTimer)
    this.stopPing()
    for (const off of this.detach) off()
    this.detach = []
    const sock = this.socket
    this.socket = null
    this.authed = false
    if (sock) {
      detachHandlers(sock)
      sock.close(1000)
    }
    this.cursorSent = null
    this.set({ ...INITIAL })
  }

  /** Drops the current socket (if any) and connects right away, e.g. after the tab returns from background. */
  forceReconnect(): void {
    if (this.stopped) return
    if (this.socket && Date.now() - this.lastOpenAt < FORCE_DEBOUNCE_MS) return
    clearTimeout(this.retryTimer)
    this.stopPing()
    const sock = this.socket
    this.socket = null
    this.authed = false
    if (sock) {
      detachHandlers(sock)
      sock.close(1000)
    }
    this.attempts = 0
    this.open()
  }

  // ---- outgoing

  get isOnline(): boolean {
    return this.authed && this.socket?.readyState === OPEN
  }

  acquire(rowId: string): boolean {
    return this.send({ t: 'lock.acquire', rowId })
  }

  release(rowId: string): boolean {
    return this.send({ t: 'lock.release', rowId })
  }

  /** Publishes where the user is looking; sends are throttled to about 10 per second, the latest wins. */
  setCursor(rowId: string | null, field?: string): void {
    this.cursorWanted = { rowId, ...(field ? { field } : {}) }
    if (!this.isOnline || this.cursorTimer) return
    const wait = this.cursorSentAt + CURSOR_THROTTLE_MS - Date.now()
    if (wait <= 0) this.flushCursor()
    else this.cursorTimer = setTimeout(() => this.flushCursor(), wait)
  }

  private flushCursor(): void {
    this.cursorTimer = undefined
    const want = this.cursorWanted
    const sent = this.cursorSent
    if (!this.isOnline || (sent && sent.rowId === want.rowId && sent.field === want.field)) return
    if (!sent && want.rowId === null) return
    if (this.send({ t: 'cursor', rowId: want.rowId, ...(want.field ? { field: want.field } : {}) })) {
      this.cursorSent = want
      this.cursorSentAt = Date.now()
    }
  }

  private send(frame: ClientFrame): boolean {
    const sock = this.socket
    if (!sock || sock.readyState !== OPEN) return false
    if (frame.t !== 'auth' && !this.authed) return false
    sock.send(JSON.stringify(frame))
    return true
  }

  // ---- connection

  private open(): void {
    clearTimeout(this.retryTimer)
    this.set({ state: this.everOnline || this.attempts > 0 ? this.failedState() : 'connecting' })
    const sock = (this.opts.createSocket ?? ((u) => new WebSocket(u) as SocketLike))(this.opts.url)
    this.socket = sock
    this.lastOpenAt = Date.now()
    sock.onopen = () => {
      if (this.socket === sock) this.authenticate(sock)
    }
    sock.onmessage = (ev) => {
      if (this.socket === sock && typeof ev.data === 'string') this.onMessage(sock, ev.data)
    }
    sock.onerror = () => undefined
    sock.onclose = (ev) => {
      if (this.socket === sock) this.onClose(ev.code)
    }
  }

  private failedState(): ConnectionState {
    const offline =
      this.attempts >= OFFLINE_AFTER || (typeof navigator !== 'undefined' && navigator.onLine === false)
    return offline ? 'offline' : 'reconnecting'
  }

  /** The token goes into the first frame, never into the URL. */
  private authenticate(sock: SocketLike): void {
    const token = this.opts.getToken()
    if (token) {
      this.sendAuth(sock, token)
      return
    }
    // After a reload the token may not exist yet: get one before talking to the server.
    this.opts.refresh().then(
      (fresh) => {
        if (this.socket === sock) this.sendAuth(sock, fresh)
      },
      (e) => this.refreshFailed(sock, e),
    )
  }

  private sendAuth(sock: SocketLike, token: string): void {
    if (sock.readyState !== OPEN) return
    this.lastSentToken = token
    sock.send(JSON.stringify({ t: 'auth', token } satisfies ClientFrame))
  }

  private refreshFailed(sock: SocketLike, e: unknown): void {
    if (this.socket !== sock) return
    if (this.opts.isFatalAuthError?.(e) ?? true) this.authLost()
    else sock.close(1000)
  }

  private onMessage(sock: SocketLike, raw: string): void {
    let frame: ServerFrame
    try {
      frame = JSON.parse(raw) as ServerFrame
    } catch {
      return
    }
    if (!frame || typeof frame !== 'object') return
    // Any traffic proves the path works, whether or not it is an answer to our ping.
    if (this.pongTimer !== undefined) {
      clearTimeout(this.pongTimer)
      this.pongTimer = undefined
    }
    switch (frame.t) {
      case 'pong':
        this.pongSupported = true
        break
      case 'hello':
        this.attempts = 0
        this.authRetried = false
        this.everOnline = true
        this.authed = true
        this.cursorSent = null
        this.startPing()
        this.set({
          state: 'online',
          you: frame.you,
          peers: frame.peers ?? [],
          cursors: frame.cursors ?? {},
          locks: frame.locks ?? {},
        })
        this.emit({ type: 'hello' })
        if (this.cursorWanted.rowId !== null) this.flushCursor()
        break
      case 'presence': {
        const ids = new Set(frame.peers.map((p) => p.id))
        const cursors = Object.fromEntries(
          Object.entries(this.snapshot.cursors).filter(([id]) => ids.has(id)),
        )
        this.set({ peers: frame.peers, cursors })
        break
      }
      case 'cursor': {
        const { [frame.userId]: _gone, ...rest } = this.snapshot.cursors
        this.set({
          cursors: frame.rowId
            ? {
                ...rest,
                [frame.userId]: { rowId: frame.rowId, ...(frame.field ? { field: frame.field } : {}) },
              }
            : rest,
        })
        break
      }
      case 'lock':
        this.set({
          locks: { ...this.snapshot.locks, [frame.rowId]: { by: frame.by, expiresAt: frame.expiresAt } },
        })
        break
      case 'unlock': {
        const { [frame.rowId]: _freed, ...rest } = this.snapshot.locks
        this.set({ locks: rest })
        break
      }
      case 'lock.denied':
        this.emit({ type: 'lock.denied', rowId: frame.rowId, by: frame.by })
        break
      case 'rows.upsert':
        this.emit({ type: 'rows.upsert', items: frame.items })
        break
      case 'rows.delete':
        this.emit({ type: 'rows.delete', ids: frame.ids })
        break
      case 'project.updated':
        this.emit({ type: 'project.updated', project: frame.project })
        break
      case 'reauth':
        this.reauth(sock)
        break
      case 'error':
        this.emit({ type: 'error', code: frame.code, message: frame.message })
        break
    }
  }

  /** The server wants a fresh token within 5 s (permissions changed): refresh, then authenticate again. */
  private reauth(sock: SocketLike): void {
    this.opts.refresh().then(
      (token) => {
        // A rotation listener may already have sent this very token.
        if (this.socket === sock && token !== this.lastSentToken) this.sendAuth(sock, token)
      },
      // The server closes with 1008 when the deadline passes; the close handler decides what happens next.
      () => undefined,
    )
  }

  private onClose(code: number): void {
    this.socket = null
    this.authed = false
    this.stopPing()
    clearTimeout(this.cursorTimer)
    this.cursorTimer = undefined
    if (this.stopped) return
    if (code === CLOSE_POLICY) {
      this.policyClose()
      return
    }
    // 1013 (overloaded or slow client), 1001 (restart) and network drops: reconnect with backoff.
    this.scheduleReconnect()
  }

  /** 1008: refresh once and authenticate again; a second 1008 without a hello in between means access is gone. */
  private policyClose(): void {
    if (this.authRetried) {
      // The session itself may be fine (e.g. the project permission was revoked): stop without signing out.
      this.emit({ type: 'authLost' })
      this.stop()
      return
    }
    this.authRetried = true
    this.set({ state: 'reconnecting' })
    this.opts.refresh().then(
      () => {
        if (!this.stopped && !this.socket) this.open()
      },
      (e) => {
        if (this.stopped || this.socket) return
        if (this.opts.isFatalAuthError?.(e) ?? true) this.authLost()
        else this.scheduleReconnect()
      },
    )
  }

  private scheduleReconnect(): void {
    this.attempts += 1
    this.set({ state: this.failedState() })
    const delay = backoffDelay(this.attempts - 1, this.opts.random)
    this.retryTimer = setTimeout(() => {
      if (!this.stopped && !this.socket) this.open()
    }, delay)
  }

  private authLost(): void {
    this.emit({ type: 'authLost' })
    this.stop()
    this.opts.onAuthLost?.()
  }

  // ---- heartbeat

  private startPing(): void {
    this.stopPing()
    this.pingTimer = setInterval(() => this.ping(), PING_MS)
  }

  private ping(): void {
    const sock = this.socket
    if (!this.send({ t: 'ping' }) || !this.pongSupported || this.pongTimer !== undefined) return
    // A socket that swallows writes (cable pulled, phone moved out of range) never closes by itself.
    this.pongTimer = setTimeout(() => {
      this.pongTimer = undefined
      if (this.socket === sock) this.dropSocket()
    }, PONG_TIMEOUT_MS)
  }

  private stopPing(): void {
    clearInterval(this.pingTimer)
    this.pingTimer = undefined
    clearTimeout(this.pongTimer)
    this.pongTimer = undefined
  }

  /** Abandons the current socket as dead and starts the usual reconnect cycle. */
  private dropSocket(): void {
    const sock = this.socket
    this.socket = null
    this.authed = false
    this.stopPing()
    clearTimeout(this.cursorTimer)
    this.cursorTimer = undefined
    if (sock) {
      detachHandlers(sock)
      try {
        sock.close(1000)
      } catch {
        // The socket is already unusable; nothing to clean up.
      }
    }
    if (!this.stopped) this.scheduleReconnect()
  }

  // ---- browser events

  private attachBrowserEvents(): void {
    if (typeof document === 'undefined') return
    const onVisibility = () => {
      if (document.visibilityState === 'visible') this.forceReconnect()
      else this.emit({ type: 'hidden' })
    }
    // iOS Safari kills background sockets without a close event; pageshow also covers the back/forward cache.
    const onPageShow = () => this.forceReconnect()
    const onPageHide = () => this.emit({ type: 'hidden' })
    // The browser knows the network is gone long before a dead socket times out: show it at once.
    const onOffline = () => {
      if (this.stopped) return
      this.attempts = Math.max(this.attempts, OFFLINE_AFTER - 1)
      this.dropSocket()
    }
    const onOnline = () => {
      if (!this.isOnline) this.forceReconnect()
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pageshow', onPageShow)
    window.addEventListener('pagehide', onPageHide)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    this.detach.push(
      () => window.removeEventListener('offline', onOffline),
      () => document.removeEventListener('visibilitychange', onVisibility),
      () => window.removeEventListener('pageshow', onPageShow),
      () => window.removeEventListener('pagehide', onPageHide),
      () => window.removeEventListener('online', onOnline),
    )
    const off = this.opts.onTokenRefreshed?.(() => {
      const sock = this.socket
      const token = this.opts.getToken()
      if (sock && this.authed && token && token !== this.lastSentToken) this.sendAuth(sock, token)
    })
    if (off) this.detach.push(off)
  }

  // ---- internals

  private set(patch: Partial<RealtimeSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const cb of this.subscribers) cb()
  }

  private emit(e: RealtimeEvent): void {
    for (const cb of this.listeners) cb(e)
  }
}

function detachHandlers(sock: SocketLike): void {
  sock.onopen = null
  sock.onmessage = null
  sock.onclose = null
  sock.onerror = null
}
