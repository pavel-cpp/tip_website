import { emitLogout } from '../auth/events'
import { refreshAccessToken } from '../auth/refresh'
import { clearAccessToken, getAccessToken } from '../auth/tokenStore'
import { type ApiError, networkError, readApiError } from './errors'

export const API_BASE = '/api/v1'

export interface RequestOptions {
  method?: string
  /** Plain objects are sent as JSON; FormData and Blob are passed through untouched. */
  body?: unknown
  query?: Record<string, string | number | boolean | undefined>
  signal?: AbortSignal
  /** Extra request headers (e.g. If-None-Match); they override the defaults such as Accept. */
  headers?: Record<string, string>
  /** For /auth/login and /auth/refresh: no token refresh and no logout on 401. */
  skipAuthRetry?: boolean
}

function buildUrl(path: string, query: RequestOptions['query']): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) params.set(k, String(v))
  const qs = params.toString()
  return `${API_BASE}${path}${qs ? `?${qs}` : ''}`
}

async function send(path: string, opts: RequestOptions): Promise<Response> {
  const headers = new Headers({ Accept: 'application/json' })
  const token = getAccessToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  for (const [k, v] of Object.entries(opts.headers ?? {})) headers.set(k, v)

  let body: BodyInit | undefined
  if (opts.body instanceof FormData || opts.body instanceof Blob) {
    body = opts.body
  } else if (opts.body !== undefined) {
    headers.set('Content-Type', 'application/json')
    body = JSON.stringify(opts.body)
  }

  try {
    return await fetch(buildUrl(path, opts.query), {
      method: opts.method ?? 'GET',
      headers,
      body,
      credentials: 'include',
      signal: opts.signal,
    })
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e
    throw networkError(e)
  }
}

async function parse<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

const needsRefresh = (e: ApiError) => e.code === 'TOKEN_EXPIRED' || e.code === 'TOKEN_STALE'

/**
 * Like apiFetch but hands back the raw Response (2xx or 304), for callers that need headers
 * (ETag) or non-JSON bodies (file downloads). Same shared refresh and logout handling.
 */
export async function apiRequest(path: string, opts: RequestOptions = {}): Promise<Response> {
  const accepted = (r: Response) => r.ok || r.status === 304
  let res = await send(path, opts)
  if (accepted(res)) return res

  let err = await readApiError(res)
  if (!opts.skipAuthRetry) {
    if (needsRefresh(err)) {
      await refreshAccessToken()
      res = await send(path, opts)
      if (accepted(res)) return res
      err = await readApiError(res)
    }
    if (err.code === 'UNAUTHENTICATED') {
      clearAccessToken()
      emitLogout()
    }
  }
  throw err
}

/**
 * Typed fetch wrapper. On 401 TOKEN_EXPIRED / TOKEN_STALE it performs one shared refresh and
 * retries the request exactly once; a closed refresh chain clears the token and emits logout.
 */
export async function apiFetch<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  return parse<T>(await apiRequest(path, opts))
}

type BodyOpts = Omit<RequestOptions, 'method' | 'body'>

export const api = {
  get: <T>(path: string, opts?: BodyOpts) => apiFetch<T>(path, { ...opts, method: 'GET' }),
  post: <T>(path: string, body?: unknown, opts?: BodyOpts) =>
    apiFetch<T>(path, { ...opts, method: 'POST', body }),
  put: <T>(path: string, body?: unknown, opts?: BodyOpts) =>
    apiFetch<T>(path, { ...opts, method: 'PUT', body }),
  patch: <T>(path: string, body?: unknown, opts?: BodyOpts) =>
    apiFetch<T>(path, { ...opts, method: 'PATCH', body }),
  delete: <T>(path: string, opts?: BodyOpts) => apiFetch<T>(path, { ...opts, method: 'DELETE' }),
}
