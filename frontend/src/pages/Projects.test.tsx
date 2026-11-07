import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearAccessToken, setAccessToken } from '../auth/tokenStore'
import { ToastProvider } from '../components/Toast'
import type { ProjectCardData } from '../features/projects/api'
import { initI18n } from '../i18n'
import Projects from './Projects'

const jwt = (perms: string[]) => `h.${btoa(JSON.stringify({ perms }))}.s`
const card = (id: string, title: string, status: 'active' | 'finished' = 'active'): ProjectCardData => ({
  id,
  title,
  status,
  image: null,
  contributors: [{ id: 'u1', displayName: 'Azam T', color: '#ffb84d', avatarUrl: null }],
  participantCount: 3,
})

const ADMIN = [
  'project.view',
  'project.view_finished',
  'project.create',
  'project.update',
  'project.finish',
  'project.delete',
]

let calls: Array<{ method: string; url: string }>
function mockApi(list: ProjectCardData[]) {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      calls.push({ method, url })
      if (method === 'DELETE') return new Response(null, { status: 204 })
      return new Response(JSON.stringify(list), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }),
  )
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>
          <Projects />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  )
}

beforeAll(() => initI18n())
beforeEach(() => setAccessToken(jwt(ADMIN)))
afterEach(() => {
  clearAccessToken()
  vi.unstubAllGlobals()
})

const LIST = [card('1', 'Tashkent City'), card('2', 'Autumn iPhone'), card('3', 'Spring 2025', 'finished')]

describe('Projects screen', () => {
  it('shows active and finished sections, the create card and card links', async () => {
    mockApi(LIST)
    renderPage()
    expect(await screen.findByRole('heading', { name: 'Активные проекты' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Завершённые проекты' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Tashkent City/ })).toHaveAttribute('href', '/projects/1')
    expect(screen.getByRole('button', { name: 'Создать' })).toBeInTheDocument()
  })

  it('hides finished projects, the create card and menus for a worker', async () => {
    setAccessToken(jwt(['project.view']))
    mockApi(LIST)
    renderPage()
    expect(await screen.findByRole('link', { name: /Tashkent City/ })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Завершённые проекты' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Создать' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Действия/ })).not.toBeInTheDocument()
  })

  it('filters the list by the search text and shows an empty state', async () => {
    mockApi(LIST)
    renderPage()
    await screen.findByRole('link', { name: /Tashkent City/ })
    const search = screen.getByPlaceholderText('Поиск проекта')
    await userEvent.type(search, 'iphone')
    expect(screen.queryByRole('link', { name: /Tashkent City/ })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Autumn iPhone/ })).toBeInTheDocument()
    await userEvent.clear(search)
    await userEvent.type(search, 'zzz')
    expect(screen.getByText('Ничего не найдено')).toBeInTheDocument()
  })

  it('filters the card menu by permissions', async () => {
    setAccessToken(jwt(['project.view', 'project.finish']))
    mockApi(LIST)
    renderPage()
    await userEvent.click(await screen.findByRole('button', { name: 'Действия: Tashkent City' }))
    const menu = await screen.findByRole('menu')
    expect(within(menu).getByRole('menuitem', { name: 'Завершить проект' })).toBeInTheDocument()
    expect(within(menu).queryByRole('menuitem', { name: 'Удалить' })).not.toBeInTheDocument()
    expect(within(menu).queryByRole('menuitem', { name: 'Настройки проекта' })).not.toBeInTheDocument()
  })

  it('asks to type the project title before deleting', async () => {
    mockApi(LIST)
    renderPage()
    await userEvent.click(await screen.findByRole('button', { name: 'Действия: Tashkent City' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Удалить' }))
    const dialog = await screen.findByRole('dialog')
    const confirm = within(dialog).getByRole('button', { name: 'Удалить навсегда' })
    expect(confirm).toHaveAttribute('aria-disabled', 'true')
    await userEvent.click(confirm)
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)

    await userEvent.type(within(dialog).getByLabelText('Название проекта'), 'Tashkent City')
    expect(confirm).not.toHaveAttribute('aria-disabled')
    await userEvent.click(confirm)
    await waitFor(() => expect(calls).toContainEqual({ method: 'DELETE', url: '/api/v1/projects/1' }))
  })

  it('shows the admin empty state with a create action and the worker hint otherwise', async () => {
    mockApi([])
    const { unmount } = renderPage()
    expect(await screen.findByText('Создайте первый проект')).toBeInTheDocument()
    unmount()
    setAccessToken(jwt(['project.view']))
    mockApi([])
    renderPage()
    expect(await screen.findByText(/Обратитесь к администратору/)).toBeInTheDocument()
  })

  it('shows an error state with retry', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: 'INTERNAL', message: 'x' } }), { status: 500 }),
      ),
    )
    renderPage()
    expect(await screen.findByText('Не удалось загрузить проекты', {}, { timeout: 4000 })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Повторить' })).toBeInTheDocument()
  }, 10000)
})
