import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { onLogout } from '../auth/events'
import { getAccessToken, setAccessToken } from '../auth/tokenStore'
import { ApiError } from './errors'
import { api, apiFetch } from './http'
import type { ApiErrorCode } from './types'

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const err = (status: number, code: ApiErrorCode, message = 'm', details?: Record<string, unknown>) =>
  json(status, { error: { code, message, details } })
const ok = (accessToken = 'new-token') => json(200, { accessToken, expiresIn: 900 })

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>
let fetchMock: ReturnType<typeof vi.fn>
let logouts: number
let offLogout: () => void

function route(handler: Handler) {
  fetchMock = vi.fn((url: string, init: RequestInit) => Promise.resolve(handler(url, init)))
  vi.stubGlobal('fetch', fetchMock)
}
const calls = (suffix: string) => fetchMock.mock.calls.filter(([u]) => String(u).endsWith(suffix))
const authHeader = (call: unknown[]) => new Headers((call[1] as RequestInit).headers).get('Authorization')

beforeEach(() => {
  setAccessToken('old-token')
  logouts = 0
  offLogout = onLogout(() => logouts++)
})
afterEach(() => {
  offLogout()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(navigator, 'locks')
})

describe('token storage', () => {
  it('keeps the access token in memory only', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem')
    setAccessToken('secret-token')
    expect(getAccessToken()).toBe('secret-token')
    expect(spy).not.toHaveBeenCalled()
    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain('secret-token')
  })
})

describe('apiFetch basics', () => {
  it('adds the Bearer header, JSON body and credentials', async () => {
    route(() => json(200, { id: 1 }))
    const res = await api.post<{ id: number }>(
      '/projects',
      { name: 'x' },
      { query: { q: 'a b', skip: undefined } },
    )
    expect(res).toEqual({ id: 1 })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/v1/projects?q=a+b')
    expect(init.method).toBe('POST')
    expect(init.credentials).toBe('include')
    expect(init.body).toBe('{"name":"x"}')
    const h = new Headers(init.headers)
    expect(h.get('Authorization')).toBe('Bearer old-token')
    expect(h.get('Content-Type')).toBe('application/json')
  })

  it('returns undefined for 204', async () => {
    route(() => new Response(null, { status: 204 }))
    await expect(api.delete('/x')).resolves.toBeUndefined()
  })

  it('maps the error envelope to a typed ApiError', async () => {
    route(() => err(409, 'ROW_LOCKED', 'locked', { by: 'u1' }))
    const e = await apiFetch('/x').catch((x: unknown) => x)
    expect(e).toBeInstanceOf(ApiError)
    expect(e).toMatchObject({ status: 409, code: 'ROW_LOCKED', message: 'locked', details: { by: 'u1' } })
    expect(logouts).toBe(0)
  })

  it('falls back to UNKNOWN for non-envelope responses and NETWORK for fetch failures', async () => {
    route(() => new Response('<html>bad gateway</html>', { status: 502 }))
    await expect(apiFetch('/x')).rejects.toMatchObject({ status: 502, code: 'UNKNOWN' })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    await expect(apiFetch('/x')).rejects.toMatchObject({ status: 0, code: 'NETWORK' })
  })
})

describe('refresh and retry', () => {
  for (const code of ['TOKEN_EXPIRED', 'TOKEN_STALE'] as const) {
    it(`on 401 ${code} refreshes once and retries the request once with the new token`, async () => {
      route((url, init) => {
        if (url.endsWith('/auth/refresh')) return ok('fresh')
        return new Headers(init.headers).get('Authorization') === 'Bearer fresh'
          ? json(200, { done: true })
          : err(401, code)
      })
      await expect(api.get('/me')).resolves.toEqual({ done: true })
      expect(calls('/auth/refresh')).toHaveLength(1)
      expect(calls('/me')).toHaveLength(2)
      expect(authHeader(calls('/me')[1] as unknown[])).toBe('Bearer fresh')
      expect(getAccessToken()).toBe('fresh')
      const refresh = calls('/auth/refresh')[0] as [string, RequestInit]
      expect(refresh[1].method).toBe('POST')
      expect(refresh[1].credentials).toBe('include')
    })
  }

  it('retries at most once: a second TOKEN_EXPIRED is surfaced', async () => {
    route((url) => (url.endsWith('/auth/refresh') ? ok('fresh') : err(401, 'TOKEN_EXPIRED')))
    await expect(api.get('/me')).rejects.toMatchObject({ code: 'TOKEN_EXPIRED' })
    expect(calls('/me')).toHaveLength(2)
    expect(calls('/auth/refresh')).toHaveLength(1)
  })

  it('shares one refresh between concurrent requests', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    route(async (url, init) => {
      if (url.endsWith('/auth/refresh')) {
        await gate
        return ok('fresh')
      }
      return new Headers(init.headers).get('Authorization') === 'Bearer fresh'
        ? json(200, { url })
        : err(401, 'TOKEN_EXPIRED')
    })
    const all = Promise.all([api.get('/a'), api.get('/b'), api.get('/c')])
    await vi.waitFor(() => expect(calls('/c')).toHaveLength(1))
    await vi.waitFor(() => expect(calls('/auth/refresh')).toHaveLength(1))
    release()
    await expect(all).resolves.toHaveLength(3)
    expect(calls('/auth/refresh')).toHaveLength(1)
  })

  it('serialises refreshes through navigator.locks when available', async () => {
    const request = vi.fn((_name: string, cb: () => Promise<unknown>) => cb())
    Object.defineProperty(navigator, 'locks', { value: { request }, configurable: true })
    route((url, init) =>
      url.endsWith('/auth/refresh')
        ? ok('fresh')
        : new Headers(init.headers).get('Authorization') === 'Bearer fresh'
          ? json(200, {})
          : err(401, 'TOKEN_EXPIRED'),
    )
    await Promise.all([api.get('/a'), api.get('/b')])
    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0]?.[0]).toBe('tip-auth-refresh')
  })

  it('starts a new refresh for a later expiry', async () => {
    let n = 0
    route((url, init) => {
      if (url.endsWith('/auth/refresh')) return ok(`t${++n}`)
      return new Headers(init.headers).get('Authorization') === `Bearer t${n}` && n > 0
        ? json(200, {})
        : err(401, 'TOKEN_EXPIRED')
    })
    await api.get('/a')
    setAccessToken('stale-again')
    await api.get('/b')
    expect(calls('/auth/refresh')).toHaveLength(2)
  })
})

describe('failure paths', () => {
  it('REFRESH_INVALID clears the token, emits logout and rejects the original request', async () => {
    route((url) => (url.endsWith('/auth/refresh') ? err(401, 'REFRESH_INVALID') : err(401, 'TOKEN_EXPIRED')))
    await expect(api.get('/me')).rejects.toMatchObject({ code: 'REFRESH_INVALID' })
    expect(getAccessToken()).toBeNull()
    expect(logouts).toBe(1)
    expect(calls('/me')).toHaveLength(1)
  })

  it('a transient refresh failure keeps the session (no logout)', async () => {
    route((url) => (url.endsWith('/auth/refresh') ? err(503, 'AUTH_UNAVAILABLE') : err(401, 'TOKEN_EXPIRED')))
    await expect(api.get('/me')).rejects.toMatchObject({ code: 'AUTH_UNAVAILABLE' })
    expect(getAccessToken()).toBe('old-token')
    expect(logouts).toBe(0)
  })

  it('a network failure during refresh is not a logout', async () => {
    fetchMock = vi.fn((url: string) =>
      url.endsWith('/auth/refresh')
        ? Promise.reject(new TypeError('offline'))
        : Promise.resolve(err(401, 'TOKEN_EXPIRED')),
    )
    vi.stubGlobal('fetch', fetchMock)
    await expect(api.get('/me')).rejects.toMatchObject({ code: 'NETWORK' })
    expect(logouts).toBe(0)
  })

  it('UNAUTHENTICATED clears the token and emits logout without refreshing', async () => {
    route(() => err(401, 'UNAUTHENTICATED'))
    await expect(api.get('/me')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })
    expect(getAccessToken()).toBeNull()
    expect(logouts).toBe(1)
    expect(calls('/auth/refresh')).toHaveLength(0)
  })

  it('skipAuthRetry leaves login failures alone', async () => {
    route(() => err(401, 'BAD_CREDENTIALS'))
    await expect(api.post('/auth/login', {}, { skipAuthRetry: true })).rejects.toMatchObject({
      code: 'BAD_CREDENTIALS',
    })
    expect(logouts).toBe(0)
    expect(getAccessToken()).toBe('old-token')
  })
})
