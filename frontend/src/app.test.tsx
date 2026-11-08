import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'
import { clearAccessToken } from './auth/tokenStore'
import { initI18n, setLocale } from './i18n'
import { apiError, jsonRes, makeUser, stubFetch } from './test/mockApi'

beforeAll(() => initI18n())

beforeEach(() => {
  // A signed-in administrator: the refresh cookie is valid and /me answers.
  stubFetch(({ method, path }) => {
    if (method === 'POST' && path === '/auth/refresh')
      return jsonRes(200, { accessToken: 't', expiresIn: 900 })
    if (method === 'GET' && path === '/me') return jsonRes(200, { user: makeUser() })
    if (path.startsWith('/admin/')) return jsonRes(200, [])
    return undefined
  })
})

afterEach(async () => {
  clearAccessToken()
  vi.unstubAllGlobals()
  await setLocale('ru')
})

function open(path: string) {
  window.history.pushState({}, '', path)
  return render(<App />)
}

describe('app shell and routing', () => {
  it('renders lazy pages inside the shell for a signed-in user', async () => {
    open('/profile')
    expect(await screen.findByRole('heading', { name: 'Личный кабинет' })).toBeInTheDocument()
    expect(screen.getByRole('banner')).toBeInTheDocument()
  })

  for (const path of ['/projects/42']) {
    it(`serves ${path}`, async () => {
      open(path)
      expect(await screen.findByText('Раздел в разработке')).toBeInTheDocument()
    })
  }

  for (const [path, heading] of [
    ['/admin/users', 'Пользователи'],
    ['/admin/roles', 'Роли'],
    ['/admin/system', 'Система'],
  ] as const) {
    it(`serves ${path}`, async () => {
      open(path)
      expect(await screen.findByRole('heading', { level: 1, name: heading })).toBeInTheDocument()
    })
  }

  it('serves /login to a visitor without a session', async () => {
    stubFetch(({ path }) => (path === '/auth/refresh' ? apiError(401, 'REFRESH_INVALID') : undefined))
    open('/login')
    expect(await screen.findByRole('button', { name: 'Войти' })).toBeInTheDocument()
  })

  it('shows the 404 page for unknown paths', async () => {
    open('/nope/nothing')
    expect(await screen.findByRole('heading', { name: 'Страница не найдена' })).toBeInTheDocument()
  })

  it('switches language without reloading', async () => {
    open('/profile')
    await screen.findByRole('heading', { name: 'Личный кабинет' })
    await userEvent.click(screen.getByRole('button', { name: 'Язык' }))
    await userEvent.click(await screen.findByRole('menuitemradio', { name: 'Oʻzbekcha' }))
    expect(await screen.findByRole('heading', { name: 'Shaxsiy kabinet' })).toBeInTheDocument()
  })

  it('/design lists components and renders in both languages', async () => {
    open('/design')
    expect(await screen.findByRole('heading', { name: 'Дизайн-система' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Основная' })).toBeInTheDocument()
    await setLocale('uz')
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Dizayn tizimi' })).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Asosiy' })).toBeInTheDocument()
  })

  it('/design can show both themes side by side', async () => {
    const { container } = open('/design')
    await screen.findByRole('heading', { name: 'Дизайн-система' })
    await userEvent.click(screen.getByRole('button', { name: 'Тёмная / Светлая' }))
    const scopes = container.querySelectorAll('[data-theme]')
    expect([...scopes].map((s) => s.getAttribute('data-theme'))).toEqual(['dark', 'light'])
    expect(within(scopes[1] as HTMLElement).getByRole('button', { name: 'Основная' })).toBeInTheDocument()
  })
})
