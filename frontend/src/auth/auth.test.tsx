import { useQuery } from '@tanstack/react-query'
import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api/http'
import { getLocale, initI18n, setLocale } from '../i18n'
import { apiError, callLog, jsonRes, makeUser, stubFetch } from '../test/mockApi'
import { renderWithProviders } from '../test/render'
import { useAuth } from './AuthProvider'
import { emitLogout } from './events'
import { Can, RequireAuth, RequirePerm, useCan } from './guards'
import { cancelRefresh, REFRESH_LEAD_MS, scheduleRefresh, watchRefresh } from './proactiveRefresh'
import { clearAccessToken, getAccessToken, setAccessToken } from './tokenStore'

beforeAll(() => initI18n())

afterEach(async () => {
  cancelRefresh()
  clearAccessToken()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  await setLocale('ru')
})

describe('proactive refresh', () => {
  let n: number
  let stop: () => void
  beforeEach(() => {
    vi.useFakeTimers()
    n = 0
    stop = watchRefresh()
  })
  afterEach(() => stop())

  const refreshCalls = (mock: ReturnType<typeof stubFetch>) =>
    callLog(mock).filter((c) => c === 'POST /auth/refresh').length

  it('renews the token one minute before it expires and keeps the cycle going', async () => {
    const mock = stubFetch(({ path }) =>
      path === '/auth/refresh' ? jsonRes(200, { accessToken: `t${++n}`, expiresIn: 900 }) : undefined,
    )
    scheduleRefresh(900)

    await vi.advanceTimersByTimeAsync(900_000 - REFRESH_LEAD_MS - 1_000)
    expect(refreshCalls(mock)).toBe(0)

    await vi.advanceTimersByTimeAsync(2_000)
    expect(refreshCalls(mock)).toBe(1)
    expect(getAccessToken()).toBe('t1')

    // The new lifetime was reported through the token event, which planned the next renewal.
    await vi.advanceTimersByTimeAsync(838_000)
    expect(refreshCalls(mock)).toBe(1)
    await vi.advanceTimersByTimeAsync(4_000)
    expect(refreshCalls(mock)).toBe(2)
  })

  it('stops when cancelled (logout)', async () => {
    const mock = stubFetch(() => jsonRes(200, { accessToken: 'x', expiresIn: 900 }))
    scheduleRefresh(900)
    cancelRefresh()
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(refreshCalls(mock)).toBe(0)
  })

  it('retries a transient failure instead of dropping the session', async () => {
    let calls = 0
    const mock = stubFetch(({ path }) => {
      if (path !== '/auth/refresh') return undefined
      calls++
      return calls === 1
        ? apiError(503, 'AUTH_UNAVAILABLE')
        : jsonRes(200, { accessToken: 'again', expiresIn: 900 })
    })
    setAccessToken('old')
    scheduleRefresh(900)
    await vi.advanceTimersByTimeAsync(900_000 - REFRESH_LEAD_MS + 100)
    expect(refreshCalls(mock)).toBe(1)
    expect(getAccessToken()).toBe('old')
    await vi.advanceTimersByTimeAsync(16_000)
    expect(refreshCalls(mock)).toBe(2)
    expect(getAccessToken()).toBe('again')
  })

  it('catches up when the tab wakes after the timer was suspended', async () => {
    const mock = stubFetch(() => jsonRes(200, { accessToken: 'woke', expiresIn: 900 }))
    scheduleRefresh(900)
    // Laptop sleep: the clock jumps, no timer fires.
    vi.setSystemTime(Date.now() + 880_000)
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await vi.advanceTimersByTimeAsync(10)
    expect(refreshCalls(mock)).toBe(1)
    expect(getAccessToken()).toBe('woke')
  })
})

function Probe() {
  const a = useAuth()
  return (
    <div>
      <span data-testid="status">{a.status}</span>
      <span data-testid="user">{a.user?.login ?? ''}</span>
      <button type="button" onClick={() => void a.login('a.azimov', 'secret').catch(() => undefined)}>
        do-login
      </button>
      <button type="button" onClick={() => void a.logout()}>
        do-logout
      </button>
    </div>
  )
}

const status = () => screen.getByTestId('status').textContent

describe('session', () => {
  it('restores the session from the refresh cookie and /me on startup', async () => {
    const mock = stubFetch(({ path }) => {
      if (path === '/auth/refresh') return jsonRes(200, { accessToken: 'restored', expiresIn: 900 })
      if (path === '/me') return jsonRes(200, { user: makeUser() })
      return undefined
    })
    renderWithProviders(<Probe />)
    await waitFor(() => expect(status()).toBe('authenticated'))
    expect(screen.getByTestId('user')).toHaveTextContent('a.azimov')
    expect(getAccessToken()).toBe('restored')
    expect(callLog(mock)).toEqual(['POST /auth/refresh', 'GET /me'])
  })

  it('is anonymous when there is no valid refresh cookie', async () => {
    stubFetch(() => apiError(401, 'REFRESH_INVALID'))
    renderWithProviders(<Probe />)
    await waitFor(() => expect(status()).toBe('anonymous'))
    expect(getAccessToken()).toBeNull()
  })

  it('reports "unavailable" (not signed out) when the network is down', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')))
    renderWithProviders(<Probe />)
    await waitFor(() => expect(status()).toBe('unavailable'))
  })

  it('logs in, keeps the token in memory and applies the stored language', async () => {
    const mock = stubFetch(({ method, path, body }) => {
      if (path === '/auth/refresh') return apiError(401, 'REFRESH_INVALID')
      if (method === 'POST' && path === '/auth/login') {
        expect(body).toEqual({ login: 'a.azimov', password: 'secret' })
        return jsonRes(200, { accessToken: 'tok', expiresIn: 900, user: makeUser({ locale: 'uz' }) })
      }
      return undefined
    })
    renderWithProviders(<Probe />)
    await waitFor(() => expect(status()).toBe('anonymous'))
    await userEvent.click(screen.getByText('do-login'))
    await waitFor(() => expect(status()).toBe('authenticated'))
    expect(getAccessToken()).toBe('tok')
    expect(callLog(mock)).toContain('POST /auth/login')
    await waitFor(() => expect(getLocale()).toBe('uz'))
    expect(JSON.stringify({ ...localStorage })).not.toContain('tok"')
  })

  it('logout always calls POST /auth/logout, even when it fails, then forgets the token', async () => {
    const mock = stubFetch(({ method, path }) => {
      if (path === '/auth/refresh') return jsonRes(200, { accessToken: 'tok', expiresIn: 900 })
      if (path === '/me') return jsonRes(200, { user: makeUser() })
      if (method === 'POST' && path === '/auth/logout') return apiError(500, 'INTERNAL')
      return undefined
    })
    renderWithProviders(<Probe />)
    await waitFor(() => expect(status()).toBe('authenticated'))
    await userEvent.click(screen.getByText('do-logout'))
    await waitFor(() => expect(status()).toBe('anonymous'))
    const logout = mock.mock.calls.find(([u]) => String(u).endsWith('/auth/logout'))
    expect(logout).toBeDefined()
    const init = (logout?.[1] ?? {}) as RequestInit
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer tok')
    expect(getAccessToken()).toBeNull()
  })

  it('reacts to the API layer losing the session', async () => {
    stubFetch(({ path }) => {
      if (path === '/auth/refresh') return jsonRes(200, { accessToken: 'tok', expiresIn: 900 })
      if (path === '/me') return jsonRes(200, { user: makeUser() })
      return undefined
    })
    renderWithProviders(<Probe />)
    await waitFor(() => expect(status()).toBe('authenticated'))
    act(() => emitLogout())
    await waitFor(() => expect(status()).toBe('anonymous'))
  })
})

function Secret() {
  const can = useCan('role.manage')
  return (
    <div>
      secret-page <span>{can ? 'can-roles' : 'cannot-roles'}</span>
      <Can perm="system.view" fallback={<span>no-system</span>}>
        <span>has-system</span>
      </Can>
    </div>
  )
}

function guarded(path: string) {
  return renderWithProviders(
    <Routes>
      <Route path="/login" element={<div>login-page</div>} />
      <Route element={<RequireAuth />}>
        <Route path="/secret" element={<Secret />} />
        <Route element={<RequirePerm perm="role.manage" />}>
          <Route path="/roles" element={<div>roles-page</div>} />
        </Route>
      </Route>
    </Routes>,
    { route: path },
  )
}

describe('guards', () => {
  it('sends visitors without a session to /login', async () => {
    stubFetch(() => apiError(401, 'REFRESH_INVALID'))
    guarded('/secret')
    expect(await screen.findByText('login-page')).toBeInTheDocument()
  })

  it('lets a signed-in user in and evaluates permissions', async () => {
    stubFetch(({ path }) => {
      if (path === '/auth/refresh') return jsonRes(200, { accessToken: 't', expiresIn: 900 })
      if (path === '/me')
        return jsonRes(200, { user: makeUser({ permissions: ['project.view', 'role.manage'] }) })
      return undefined
    })
    guarded('/secret')
    expect(await screen.findByText(/secret-page/)).toBeInTheDocument()
    expect(screen.getByText('can-roles')).toBeInTheDocument()
    expect(screen.getByText('no-system')).toBeInTheDocument()
  })

  it('shows "no access" instead of a screen the user has no permission for', async () => {
    stubFetch(({ path }) => {
      if (path === '/auth/refresh') return jsonRes(200, { accessToken: 't', expiresIn: 900 })
      if (path === '/me') return jsonRes(200, { user: makeUser({ permissions: ['project.view'] }) })
      return undefined
    })
    guarded('/roles')
    expect(await screen.findByRole('alert')).toHaveTextContent('Нет доступа')
    expect(screen.queryByText('roles-page')).not.toBeInTheDocument()
  })
})

function ForcedProbe() {
  const q = useQuery({ queryKey: ['x'], queryFn: () => api.get('/projects') })
  return <span>{q.status}</span>
}

describe('password change prompt', () => {
  const session = (user = makeUser({ passwordTemporary: true })) =>
    stubFetch(({ method, path }) => {
      if (path === '/auth/refresh') return jsonRes(200, { accessToken: 't', expiresIn: 900 })
      if (path === '/me') return jsonRes(200, { user })
      if (method === 'POST' && path === '/me/password')
        return jsonRes(200, { accessToken: 'new', expiresIn: 900 })
      return undefined
    })

  it('recommends changing a temporary password and can be postponed', async () => {
    session()
    renderWithProviders(<Probe />)
    const dialog = await screen.findByRole('dialog', { name: 'Смените временный пароль' })
    expect(dialog).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Напомнить позже' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(status()).toBe('authenticated')
  })

  it('"Change now" opens the form and a successful change closes the prompt', async () => {
    const user = makeUser({ passwordTemporary: true })
    let current = user
    stubFetch(({ method, path }) => {
      if (path === '/auth/refresh') return jsonRes(200, { accessToken: 't', expiresIn: 900 })
      if (path === '/me') return jsonRes(200, { user: current })
      if (method === 'POST' && path === '/me/password') {
        current = makeUser({ passwordTemporary: false })
        return jsonRes(200, { accessToken: 'new', expiresIn: 900 })
      }
      return undefined
    })
    renderWithProviders(<Probe />)
    await screen.findByRole('dialog')
    await userEvent.click(screen.getByRole('button', { name: 'Сменить сейчас' }))
    await userEvent.type(screen.getByLabelText('Текущий пароль'), 'temporary-pass')
    await userEvent.type(screen.getByLabelText('Новый пароль'), 'a-brand-new-pass')
    await userEvent.type(screen.getByLabelText('Повторите пароль'), 'a-brand-new-pass')
    await userEvent.click(screen.getByRole('button', { name: 'Сменить пароль' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(getAccessToken()).toBe('new')
  })

  it('validates the new password before calling the server', async () => {
    const mock = session()
    renderWithProviders(<Probe />)
    await screen.findByRole('dialog')
    await userEvent.click(screen.getByRole('button', { name: 'Сменить сейчас' }))
    await userEvent.type(screen.getByLabelText('Текущий пароль'), 'temporary-pass')
    await userEvent.type(screen.getByLabelText('Новый пароль'), 'short')
    await userEvent.type(screen.getByLabelText('Повторите пароль'), 'different')
    await userEvent.click(screen.getByRole('button', { name: 'Сменить пароль' }))
    expect(await screen.findByText('Минимум 8 символов')).toBeInTheDocument()
    expect(screen.getByText('Пароли не совпадают')).toBeInTheDocument()
    expect(callLog(mock)).not.toContain('POST /me/password')
  })

  it('shows the form, without a postpone option, on 403 PASSWORD_CHANGE_REQUIRED', async () => {
    stubFetch(({ path }) => {
      if (path === '/auth/refresh') return jsonRes(200, { accessToken: 't', expiresIn: 900 })
      if (path === '/me') return jsonRes(200, { user: makeUser() })
      if (path === '/projects') return apiError(403, 'PASSWORD_CHANGE_REQUIRED')
      return undefined
    })
    renderWithProviders(<ForcedProbe />)
    expect(await screen.findByRole('dialog', { name: 'Нужно сменить пароль' })).toBeInTheDocument()
    expect(screen.getByLabelText('Текущий пароль')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Напомнить позже' })).not.toBeInTheDocument()
  })
})
