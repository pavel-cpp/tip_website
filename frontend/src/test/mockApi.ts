import { vi } from 'vitest'
import type { AuthUser } from '../auth/types'

export function jsonRes(status: number, body?: unknown): Response {
  if (status === 204) return new Response(null, { status })
  return new Response(JSON.stringify(body ?? {}), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export const apiError = (status: number, code: string, details?: Record<string, unknown>) =>
  jsonRes(status, { error: { code, message: code, details } })

export const ALL_PERMISSIONS = [
  'project.view',
  'project.view_finished',
  'project.create',
  'project.update',
  'project.finish',
  'project.delete',
  'participant.view',
  'participant.edit',
  'participant.print',
  'participant.export',
  'participant.import',
  'participant.delete',
  'participant.clear',
  'participant.follow',
  'user.view',
  'user.manage',
  'role.manage',
  'audit.view',
  'system.view',
] as const satisfies AuthUser['permissions']

export function makeUser(patch: Partial<AuthUser> = {}): AuthUser {
  return {
    id: 'u1',
    login: 'a.azimov',
    displayName: 'Azim Azimov',
    roles: [{ id: 'r-admin', name: 'admin' }],
    permissions: [...ALL_PERMISSIONS],
    color: '#6cb4ff',
    avatarUrl: null,
    locale: 'ru',
    theme: 'dark',
    passwordTemporary: false,
    ...patch,
  }
}

export interface MockRequest {
  method: string
  /** Path below /api/v1, with the query string. */
  path: string
  body: unknown
  headers: Headers
}

export type MockHandler = (req: MockRequest) => Response | undefined | Promise<Response | undefined>

/** Replaces fetch; unhandled requests answer 404 so a missing route fails loudly in the test. */
export function stubFetch(handler: MockHandler) {
  const mock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input)
    const raw = init.body
    let body: unknown = raw
    if (typeof raw === 'string') {
      try {
        body = JSON.parse(raw)
      } catch {
        body = raw
      }
    }
    const res = await handler({
      method: (init.method ?? 'GET').toUpperCase(),
      path: url.replace(/^\/api\/v1/, ''),
      body,
      headers: new Headers(init.headers),
    })
    return res ?? apiError(404, 'NOT_FOUND')
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

/** Calls made so far as "METHOD /path" strings. */
export const callLog = (mock: ReturnType<typeof stubFetch>): string[] =>
  mock.mock.calls.map(
    ([url, init]) =>
      `${((init as RequestInit | undefined)?.method ?? 'GET').toUpperCase()} ${String(url).replace(/^\/api\/v1/, '')}`,
  )
