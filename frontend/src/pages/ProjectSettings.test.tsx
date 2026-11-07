import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearAccessToken, setAccessToken } from '../auth/tokenStore'
import { ToastProvider } from '../components/Toast'
import type { Project } from '../features/projects/api'
import { initI18n } from '../i18n'
import ProjectSettings from './ProjectSettings'

const jwt = (perms: string[]) => `h.${btoa(JSON.stringify({ perms }))}.s`
const ph = (y: number) => ({
  font: 'Montserrat',
  size: 34,
  stroke: 2,
  color: '#FFFFFF',
  strokeColor: '#141619',
  bold: true,
  italic: false,
  underline: false,
  x: 512,
  y,
})
const project = (over: Partial<Project> = {}): Project => ({
  id: 'p1',
  title: 'Tashkent City',
  status: 'active',
  version: 4,
  image: { url: '/api/v1/projects/p1/image?v=1', name: 'bmw.jpg', w: 1024, h: 768, bytes: 2_202_009 },
  placeholders: { number: ph(120), name: ph(340), phone: ph(600) },
  contributors: [],
  participantCount: 0,
  createdAt: '2026-11-01T09:00:00Z',
  ...over,
})

let patches: unknown[]
function mockApi(opts: { project?: Project; patchStatus?: number } = {}) {
  patches = []
  const base = opts.project ?? project()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        patches.push(JSON.parse(String(init.body)))
        if (opts.patchStatus === 409) {
          return new Response(JSON.stringify({ error: { code: 'VERSION_CONFLICT', message: 'x' } }), {
            status: 409,
          })
        }
        return new Response(JSON.stringify({ project: { ...base, version: base.version + 1 } }), {
          status: 200,
        })
      }
      if (url.includes('/image')) return new Response('', { status: 404 })
      return new Response(JSON.stringify({ project: base }), { status: 200 })
    }),
  )
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/projects/p1/settings']}>
          <Routes>
            <Route path="/projects/:id/settings" element={<ProjectSettings />} />
            <Route path="/" element={<p>list</p>} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  )
}

beforeAll(() => initI18n())
beforeEach(() => setAccessToken(jwt(['project.view', 'project.update'])))
afterEach(() => {
  clearAccessToken()
  vi.unstubAllGlobals()
})

describe('ProjectSettings', () => {
  it('is refused without project.update', async () => {
    setAccessToken(jwt(['project.view']))
    mockApi()
    renderPage()
    expect(await screen.findByText('Нет прав на это действие')).toBeInTheDocument()
  })

  it('shows the title, the image info and the ratio hint for a non-7:4 image', async () => {
    mockApi()
    renderPage()
    expect(await screen.findByDisplayValue('Tashkent City')).toBeInTheDocument()
    expect(screen.getByText(/bmw\.jpg/)).toBeInTheDocument()
    expect(screen.getByText(/соотношение сторон — 7:4/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Заменить изображение' })).toBeInTheDocument()
  })

  it('shows no ratio hint for a 7:4 image', async () => {
    mockApi({ project: project({ image: { url: '/x', name: 'a.png', w: 1400, h: 800, bytes: 1000 } }) })
    renderPage()
    await screen.findByDisplayValue('Tashkent City')
    expect(screen.queryByText(/соотношение сторон/)).not.toBeInTheDocument()
  })

  it('switches placeholder tabs and edits fields; Save sends only the changed placeholder with the version', async () => {
    mockApi()
    renderPage()
    await screen.findByDisplayValue('Tashkent City')
    const save = screen.getByRole('button', { name: 'Сохранить' })
    expect(save).toHaveAttribute('aria-disabled', 'true')

    await userEvent.click(screen.getByRole('tab', { name: 'Телефон' }))
    const size = screen.getByLabelText('Размер')
    await userEvent.clear(size)
    await userEvent.type(size, '40')
    await userEvent.click(screen.getByRole('button', { name: 'Курсив' }))
    expect(save).not.toHaveAttribute('aria-disabled')

    await userEvent.click(save)
    await waitFor(() => expect(patches).toHaveLength(1))
    expect(patches[0]).toEqual({
      version: 4,
      placeholders: { phone: { ...ph(600), size: 40, italic: true } },
    })
  })

  it('moves a placeholder with the keyboard through the X/Y fields', async () => {
    mockApi()
    renderPage()
    await screen.findByDisplayValue('Tashkent City')
    const x = screen.getByLabelText('X')
    await userEvent.clear(x)
    await userEvent.type(x, '600')
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
    await waitFor(() => expect(patches).toHaveLength(1))
    expect(patches[0]).toMatchObject({ placeholders: { name: { x: 600, y: 340 } } })
  })

  it('offers to reload or overwrite on 409 VERSION_CONFLICT', async () => {
    mockApi({ patchStatus: 409 })
    renderPage()
    const title = await screen.findByDisplayValue('Tashkent City')
    await userEvent.type(title, '!')
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
    expect(await screen.findByRole('dialog', { name: 'Проект изменили в другом месте' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Загрузить актуальную' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Сохранить мои' })).toBeInTheDocument()
  })

  it('asks before leaving with unsaved changes', async () => {
    mockApi()
    renderPage()
    const title = await screen.findByDisplayValue('Tashkent City')
    await userEvent.type(title, '!')
    await userEvent.click(screen.getByRole('button', { name: 'Закрыть' }))
    expect(await screen.findByRole('dialog', { name: 'Выйти без сохранения?' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Выйти' }))
    expect(await screen.findByText('list')).toBeInTheDocument()
  })

  it('leaves at once when nothing changed', async () => {
    mockApi()
    renderPage()
    await screen.findByDisplayValue('Tashkent City')
    await userEvent.click(screen.getByRole('button', { name: 'Закрыть' }))
    expect(await screen.findByText('list')).toBeInTheDocument()
  })

  it('disables editing for a finished project', async () => {
    mockApi({ project: project({ status: 'finished' }) })
    renderPage()
    expect(await screen.findByText(/настройки доступны только для просмотра/)).toBeInTheDocument()
    expect(screen.getByLabelText('Название проекта')).toBeDisabled()
  })
})
