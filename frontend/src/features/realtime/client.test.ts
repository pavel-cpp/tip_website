import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  backoffDelay,
  CURSOR_THROTTLE_MS,
  PING_MS,
  projectSocketUrl,
  RealtimeClient,
  type RealtimeEvent,
  type RealtimeOptions,
} from './client'
import { FakeSocket } from './fakeSocket'
import { LockLease } from './lease'

const hello = (extra: Record<string, unknown> = {}) => ({
  t: 'hello',
  you: 'me',
  peers: [{ id: 'me', displayName: 'Me', color: '#111', avatarUrl: null }],
  cursors: {},
  locks: {},
  serverTime: '2026-11-07T10:00:00Z',
  ...extra,
})

interface Rig {
  client: RealtimeClient
  events: RealtimeEvent[]
  token: { value: string | null }
  refresh: ReturnType<typeof vi.fn>
  onAuthLost: ReturnType<typeof vi.fn>
  rotated: Array<() => void>
}

function rig(over: Partial<RealtimeOptions> = {}): Rig {
  const token = { value: 'tok1' as string | null }
  const rotated: Array<() => void> = []
  const refresh = vi.fn(async () => {
    token.value = 'tok2'
    return 'tok2'
  })
  const onAuthLost = vi.fn()
  const client = new RealtimeClient({
    url: 'ws://x/api/v1/projects/p1/ws',
    getToken: () => token.value,
    refresh,
    onTokenRefreshed: (cb) => {
      rotated.push(cb)
      return () => undefined
    },
    onAuthLost,
    createSocket: (u) => new FakeSocket(u),
    random: () => 0,
    ...over,
  })
  made.push(client)
  const events: RealtimeEvent[] = []
  client.onEvent((e) => events.push(e))
  return { client, events, token, refresh, onAuthLost, rotated }
}

/** Starts the client and walks it to the online state. */
function connect(r: Rig): FakeSocket {
  r.client.start()
  const s = FakeSocket.last
  s.open()
  s.receive(hello())
  return s
}

const flush = () => vi.advanceTimersByTimeAsync(0)

beforeEach(() => {
  vi.useFakeTimers()
  FakeSocket.reset()
})
const made: RealtimeClient[] = []
afterEach(() => {
  for (const c of made.splice(0)) c.stop()
  vi.useRealTimers()
})

describe('handshake', () => {
  it('sends auth as the first frame and keeps the token out of the URL', () => {
    const r = rig()
    r.client.start()
    const s = FakeSocket.last
    expect(s.url).not.toContain('tok1')
    expect(s.sent).toEqual([])
    s.open()
    expect(s.sent).toEqual([{ t: 'auth', token: 'tok1' }])
    expect(r.client.getSnapshot().state).toBe('connecting')
  })

  it('refreshes first when there is no access token yet', async () => {
    const r = rig()
    r.token.value = null
    r.client.start()
    FakeSocket.last.open()
    await flush()
    expect(r.refresh).toHaveBeenCalledOnce()
    expect(FakeSocket.last.sent).toEqual([{ t: 'auth', token: 'tok2' }])
  })

  it('becomes online on hello and stores the room state', () => {
    const r = rig()
    const s = connect(r)
    s.receive({
      ...hello(),
      cursors: { u2: { rowId: 'r1', field: 'name' } },
      locks: { r2: { by: 'u2', expiresAt: 'x' } },
    })
    const snap = r.client.getSnapshot()
    expect(snap.state).toBe('online')
    expect(snap.you).toBe('me')
    expect(snap.cursors.u2).toEqual({ rowId: 'r1', field: 'name' })
    expect(snap.locks.r2?.by).toBe('u2')
    expect(r.events.filter((e) => e.type === 'hello')).toHaveLength(2)
  })

  it('tracks presence, cursor, lock and unlock frames', () => {
    const r = rig()
    const s = connect(r)
    const peer = { id: 'u2', displayName: 'Azam', color: '#f00', avatarUrl: null }
    s.receive({ t: 'presence', peers: [peer] })
    s.receive({ t: 'cursor', userId: 'u2', rowId: 'r1', field: 'phone' })
    s.receive({ t: 'lock', rowId: 'r1', by: 'u2', expiresAt: 'e' })
    expect(r.client.getSnapshot().peers).toEqual([peer])
    expect(r.client.getSnapshot().cursors.u2?.rowId).toBe('r1')
    expect(r.client.getSnapshot().locks.r1?.by).toBe('u2')
    s.receive({ t: 'unlock', rowId: 'r1', by: 'u2', expiresAt: 'e' })
    s.receive({ t: 'cursor', userId: 'u2', rowId: null })
    expect(r.client.getSnapshot().locks).toEqual({})
    expect(r.client.getSnapshot().cursors).toEqual({})
  })

  it('drops the cursor of a peer that left', () => {
    const r = rig()
    const s = connect(r)
    s.receive({ t: 'cursor', userId: 'u2', rowId: 'r1' })
    s.receive({ t: 'presence', peers: [] })
    expect(r.client.getSnapshot().cursors).toEqual({})
  })

  it('forwards data frames and ignores garbage', () => {
    const r = rig()
    const s = connect(r)
    s.onmessage?.({ data: 'not json' })
    s.onmessage?.({ data: new ArrayBuffer(2) })
    s.receive({ t: 'mystery' })
    s.receive({ t: 'rows.upsert', items: [{ id: 'a' }] })
    s.receive({ t: 'rows.delete', ids: ['a'] })
    s.receive({ t: 'project.updated', project: { id: 'p1', status: 'finished' } })
    s.receive({ t: 'error', code: 'RATE_LIMITED', message: 'slow down' })
    expect(r.events.map((e) => e.type)).toEqual([
      'hello',
      'rows.upsert',
      'rows.delete',
      'project.updated',
      'error',
    ])
  })
})

describe('heartbeat, cursor and locks', () => {
  it('pings every 15 s while authenticated', async () => {
    const r = rig()
    const s = connect(r)
    await vi.advanceTimersByTimeAsync(PING_MS * 2)
    expect(s.frames('ping')).toHaveLength(2)
    r.client.stop()
    await vi.advanceTimersByTimeAsync(PING_MS * 2)
    expect(s.frames('ping')).toHaveLength(2)
  })

  it('throttles cursor frames to about 10 per second, latest wins', async () => {
    const r = rig()
    const s = connect(r)
    r.client.setCursor('r1', 'name')
    r.client.setCursor('r2', 'name')
    r.client.setCursor('r3', 'phone')
    expect(s.frames('cursor')).toEqual([{ t: 'cursor', rowId: 'r1', field: 'name' }])
    await vi.advanceTimersByTimeAsync(CURSOR_THROTTLE_MS)
    expect(s.frames('cursor')).toHaveLength(2)
    expect(s.frames('cursor')[1]).toEqual({ t: 'cursor', rowId: 'r3', field: 'phone' })
  })

  it('runs the lock lease: acquire, renew by heartbeat, release', async () => {
    const r = rig()
    const s = connect(r)
    const denied = vi.fn()
    const lease = new LockLease(r.client, denied)
    lease.acquire('r1')
    expect(s.frames('lock.acquire')).toEqual([{ t: 'lock.acquire', rowId: 'r1' }])
    await vi.advanceTimersByTimeAsync(PING_MS)
    expect(s.frames('ping')).toHaveLength(1)
    lease.release('r1')
    expect(s.frames('lock.release')).toEqual([{ t: 'lock.release', rowId: 'r1' }])
    lease.release('r1')
    expect(s.frames('lock.release')).toHaveLength(1)
  })

  it('reports lock.denied once and forgets the row', () => {
    const r = rig()
    const s = connect(r)
    const denied = vi.fn()
    const lease = new LockLease(r.client, denied)
    lease.acquire('r1')
    s.receive({ t: 'lock.denied', rowId: 'r1', by: 'u2' })
    expect(denied).toHaveBeenCalledWith('r1', 'u2')
    expect(lease.held.size).toBe(0)
  })

  it('releases on page hide and takes the row back after the resync', () => {
    const r = rig()
    const s = connect(r)
    const lease = new LockLease(r.client, vi.fn())
    lease.acquire('r1')
    vi.advanceTimersByTime(1000)
    window.dispatchEvent(new Event('pagehide'))
    expect(s.frames('lock.release')).toHaveLength(1)
    document.dispatchEvent(new Event('visibilitychange'))
    const s2 = FakeSocket.last
    expect(s2).not.toBe(s)
    s2.open()
    s2.receive(hello())
    expect(s2.frames('lock.acquire')).toEqual([{ t: 'lock.acquire', rowId: 'r1' }])
  })

  it('re-acquires held rows after a reconnect', async () => {
    const r = rig()
    const s = connect(r)
    const lease = new LockLease(r.client, vi.fn())
    lease.acquire('r1')
    s.serverClose(1006)
    await vi.advanceTimersByTimeAsync(1000)
    const s2 = FakeSocket.last
    s2.open()
    s2.receive(hello())
    expect(s2.frames('lock.acquire')).toHaveLength(1)
  })
})

describe('reauth', () => {
  it('refreshes and sends a fresh auth frame', async () => {
    const r = rig()
    const s = connect(r)
    s.receive({ t: 'reauth' })
    await flush()
    expect(r.refresh).toHaveBeenCalledOnce()
    expect(s.frames('auth')).toEqual([
      { t: 'auth', token: 'tok1' },
      { t: 'auth', token: 'tok2' },
    ])
  })

  it('does not send the same token twice when a rotation already did', async () => {
    const r = rig()
    const s = connect(r)
    r.refresh.mockImplementation(async () => {
      r.token.value = 'tok2'
      for (const cb of r.rotated) cb()
      return 'tok2'
    })
    s.receive({ t: 'reauth' })
    await flush()
    expect(s.frames('auth')).toHaveLength(2)
  })

  it('re-authenticates after a background token rotation', () => {
    const r = rig()
    const s = connect(r)
    r.token.value = 'tok9'
    for (const cb of r.rotated) cb()
    expect(s.frames('auth').at(-1)).toEqual({ t: 'auth', token: 'tok9' })
  })
})

describe('close codes', () => {
  it('1008: refreshes once and reconnects with the new token', async () => {
    const r = rig()
    const s = connect(r)
    s.serverClose(1008)
    await flush()
    expect(r.refresh).toHaveBeenCalledOnce()
    const s2 = FakeSocket.last
    expect(s2).not.toBe(s)
    s2.open()
    expect(s2.sent).toEqual([{ t: 'auth', token: 'tok2' }])
    expect(r.onAuthLost).not.toHaveBeenCalled()
  })

  it('1008 with a failed refresh logs out and does not reconnect', async () => {
    const r = rig()
    r.refresh.mockRejectedValue(new Error('401'))
    const s = connect(r)
    s.serverClose(1008)
    await flush()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(r.onAuthLost).toHaveBeenCalledOnce()
    expect(FakeSocket.instances).toHaveLength(1)
    expect(r.events.some((e) => e.type === 'authLost')).toBe(true)
  })

  it('1008 with a transient refresh failure backs off instead of logging out', async () => {
    const r = rig({ isFatalAuthError: () => false })
    r.refresh.mockRejectedValue(new Error('network'))
    const s = connect(r)
    s.serverClose(1008)
    await flush()
    expect(r.onAuthLost).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    expect(FakeSocket.instances).toHaveLength(2)
  })

  it('a second 1008 without a hello stops without logging out', async () => {
    const r = rig()
    const s = connect(r)
    s.serverClose(1008)
    await flush()
    FakeSocket.last.open()
    FakeSocket.last.serverClose(1008)
    await flush()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(FakeSocket.instances).toHaveLength(2)
    expect(r.onAuthLost).not.toHaveBeenCalled()
    expect(r.client.getSnapshot().state).toBe('offline')
  })

  it.each([1013, 1001, 1006])('%i: reconnects with backoff', async (code) => {
    const r = rig()
    const s = connect(r)
    s.serverClose(code)
    expect(r.client.getSnapshot().state).toBe('reconnecting')
    await vi.advanceTimersByTimeAsync(999)
    expect(FakeSocket.instances).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(FakeSocket.instances).toHaveLength(2)
  })

  it('backs off 1 s -> 15 s, resets after hello, and reports offline after repeated failures', async () => {
    const r = rig()
    r.client.start()
    const delays: number[] = []
    for (let i = 0; i < 6; i++) {
      const before = FakeSocket.instances.length
      FakeSocket.last.serverClose(1006)
      let waited = 0
      while (FakeSocket.instances.length === before) {
        await vi.advanceTimersByTimeAsync(500)
        waited += 500
      }
      delays.push(waited)
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 15_000, 15_000])
    expect(r.client.getSnapshot().state).toBe('offline')
    FakeSocket.last.open()
    FakeSocket.last.receive(hello())
    expect(r.client.getSnapshot().state).toBe('online')
    FakeSocket.last.serverClose(1006)
    await vi.advanceTimersByTimeAsync(1000)
    expect(FakeSocket.instances).toHaveLength(8)
  })
})

describe('backoffDelay', () => {
  it('stays within [0.75 * base, base] and caps at 15 s', () => {
    for (let attempt = 0; attempt < 12; attempt++) {
      const base = Math.min(15_000, 1000 * 2 ** attempt)
      expect(backoffDelay(attempt, () => 0)).toBe(base)
      expect(backoffDelay(attempt, () => 1)).toBe(Math.round(base * 0.75))
      const mid = backoffDelay(attempt, Math.random)
      expect(mid).toBeGreaterThanOrEqual(Math.round(base * 0.75))
      expect(mid).toBeLessThanOrEqual(base)
    }
  })
})

describe('background tabs', () => {
  it('forces a reconnect and resync when the tab becomes visible', () => {
    const r = rig()
    const s = connect(r)
    vi.advanceTimersByTime(2000)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(s.closedWith).toBe(1000)
    const s2 = FakeSocket.last
    expect(s2).not.toBe(s)
    s2.open()
    s2.receive(hello())
    expect(r.events.filter((e) => e.type === 'hello')).toHaveLength(2)
  })

  it('reconnects on pageshow, once when both events arrive together', () => {
    const r = rig()
    connect(r)
    vi.advanceTimersByTime(2000)
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('pageshow'))
    expect(FakeSocket.instances).toHaveLength(2)
    vi.advanceTimersByTime(2000)
    window.dispatchEvent(new Event('pageshow'))
    expect(FakeSocket.instances).toHaveLength(3)
  })
})

describe('shutdown', () => {
  it('does not reconnect after stop and ignores late events', async () => {
    const r = rig()
    const s = connect(r)
    r.client.stop()
    expect(s.closedWith).toBe(1000)
    s.serverClose(1006)
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(FakeSocket.instances).toHaveLength(1)
    expect(r.client.getSnapshot().state).toBe('offline')
  })

  it('can be started again (React strict mode)', () => {
    const r = rig()
    r.client.start()
    r.client.stop()
    r.client.start()
    expect(FakeSocket.instances).toHaveLength(2)
    FakeSocket.last.open()
    expect(FakeSocket.last.sent).toEqual([{ t: 'auth', token: 'tok1' }])
  })
})

describe('projectSocketUrl', () => {
  it('uses wss on https and carries no query string', () => {
    expect(projectSocketUrl('a b', { protocol: 'https:', host: 'h' })).toBe(
      'wss://h/api/v1/projects/a%20b/ws',
    )
    expect(projectSocketUrl('p', { protocol: 'http:', host: 'h:1' })).toBe('ws://h:1/api/v1/projects/p/ws')
  })
})
