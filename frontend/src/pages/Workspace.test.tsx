import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearAccessToken } from '../auth/tokenStore'
import { clearParticipantEtags, type Participant } from '../features/workspace/api'
import { initI18n, setLocale } from '../i18n'
import { ALL_PERMISSIONS, apiError, callLog, jsonRes, makeUser, stubFetch } from '../test/mockApi'
import { renderWithProviders } from '../test/render'
import Workspace from './Workspace'

const bodyOf = (call: readonly unknown[] | undefined): string =>
  String((call?.[1] as RequestInit | undefined)?.body)

const person = (n: number, name: string, phone: string): Participant => ({
  id: `id${n}`,
  projectId: 'p1',
  number: n,
  name,
  phone,
  version: 1,
  updatedAt: '2026-11-07T10:00:00Z',
})
const ROWS = [
  person(1, 'Timur Rahimov', '+7 912 305-14-22'),
  person(2, 'Nadezhda Sokolova', '+7 903 771-08-56'),
  person(3, 'Otabek Karimov', '+998 90 123-45-67'),
]

const ph = {
  font: 'Inter',
  size: 30,
  stroke: 0,
  color: '#fff',
  strokeColor: '#000',
  bold: false,
  italic: false,
  underline: false,
  x: 10,
  y: 10,
}
const project = (status: 'active' | 'finished' = 'active') => ({
  id: 'p1',
  title: 'Tashkent City',
  status,
  version: 1,
  image: null,
  placeholders: { number: ph, name: ph, phone: ph },
  contributors: [{ id: 'u2', displayName: 'Azam Tursunov', color: '#ffb84d', avatarUrl: null }],
  participantCount: ROWS.length,
  createdAt: '2026-11-01T09:00:00Z',
})

interface Server {
  rows: Participant[]
  status: 'active' | 'finished'
  perms: readonly string[]
  patch?: (id: string, body: Record<string, unknown>) => Response
  etag: string
}

let server: Server
let mock: ReturnType<typeof stubFetch>
let listHeaders: Array<string | null>

function start(over: Partial<Server> = {}) {
  server = { rows: ROWS, status: 'active', perms: ALL_PERMISSIONS, etag: '"rev1"', ...over }
  listHeaders = []
  mock = stubFetch((req) => {
    const { method, path, body } = req
    if (path === '/auth/refresh') return jsonRes(200, { accessToken: 't', expiresIn: 900 })
    if (path === '/me') return jsonRes(200, { user: makeUser({ permissions: [...server.perms] as never }) })
    if (path === '/projects/p1') return jsonRes(200, { project: project(server.status) })
    if (path === '/projects/p1/participants' && method === 'GET') {
      const inm = req.headers.get('If-None-Match')
      listHeaders.push(inm)
      if (inm === server.etag) return new Response(null, { status: 304 })
      return new Response(JSON.stringify({ items: server.rows, rev: 1 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ETag: server.etag },
      })
    }
    if (path === '/projects/p1/participants' && method === 'POST') {
      const b = body as { count?: number; items?: Array<{ name: string; phone: string }> }
      const n = b.count ?? b.items?.length ?? 0
      const items = Array.from({ length: n }, (_, i) => ({
        ...person(100 + i, b.items?.[i]?.name ?? '', b.items?.[i]?.phone ?? ''),
        id: `new${i}`,
      }))
      return jsonRes(201, { items })
    }
    if (path.startsWith('/participants/') && method === 'PATCH') {
      const id = path.split('/')[2] as string
      const res = server.patch?.(id, body as Record<string, unknown>)
      if (res) return res
      const base = server.rows.find((r) => r.id === id) as Participant
      return jsonRes(200, { item: { ...base, ...(body as object), version: base.version + 1 } })
    }
    if (path === '/projects/p1/participants/delete') return jsonRes(200, { deleted: 1 })
    return undefined
  })
}

function renderPage() {
  return renderWithProviders(
    <Routes>
      <Route path="/projects/:id" element={<Workspace />} />
    </Routes>,
    { route: '/projects/p1' },
  )
}

const rowOf = (name: string) => screen.getByText(name).closest('[role="row"]') as HTMLElement
const cell = (name: string) => screen.getByText(name).closest('[role="gridcell"]') as HTMLElement

beforeAll(async () => {
  await initI18n()
  // jsdom has no layout: give every element a viewport so the virtualizer renders rows.
  for (const prop of ['offsetHeight', 'clientHeight']) {
    Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: () => 600 })
  }
  for (const prop of ['offsetWidth', 'clientWidth']) {
    Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: () => 800 })
  }
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
})

beforeEach(() => clearParticipantEtags())
afterEach(async () => {
  clearAccessToken()
  vi.useRealTimers()
  await setLocale('ru')
})

describe('workspace table', () => {
  it('shows exactly the columns Number, Name, Phone and the crumbs', async () => {
    start()
    renderPage()
    expect(await screen.findByText('Timur Rahimov')).toBeInTheDocument()
    const heads = screen.getAllByRole('columnheader').map((h) => h.textContent)
    expect(heads).toEqual(['№', 'Имя', 'Номер телефона'])
    expect(screen.queryByText(/Статус/i)).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Tashkent City' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Проекты' })).toBeInTheDocument()
  })

  it('filters instantly by name or phone without calling the server again', async () => {
    start()
    renderPage()
    await screen.findByText('Timur Rahimov')
    const calls = mock.mock.calls.length
    await userEvent.type(screen.getByRole('searchbox', { name: 'Поиск по участникам' }), 'nadezhda')
    expect(screen.queryByText('Timur Rahimov')).not.toBeInTheDocument()
    expect(screen.getByText('Nadezhda Sokolova')).toBeInTheDocument()
    expect(mock.mock.calls.length).toBe(calls)
  })

  it('revalidates with If-None-Match and keeps the rows on 304', async () => {
    start()
    const { queryClient } = renderPage()
    await screen.findByText('Timur Rahimov')
    expect(listHeaders).toEqual([null])
    await act(() => queryClient.invalidateQueries({ queryKey: ['projects', 'p1', 'participants'] }))
    await waitFor(() => expect(listHeaders).toEqual([null, '"rev1"']))
    expect(screen.getByText('Timur Rahimov')).toBeInTheDocument()
  })

  it('edits a cell with F2/Enter, applies it optimistically and sends the row version', async () => {
    start()
    renderPage()
    await screen.findByText('Timur Rahimov')
    const user = userEvent.setup()
    await user.click(cell('Timur Rahimov'))
    await user.keyboard('{F2}')
    const input = screen.getByRole('textbox', { name: 'Имя' })
    await user.clear(input)
    await user.type(input, 'Timur R.{Enter}')
    expect(screen.getByText('Timur R.')).toBeInTheDocument()
    await waitFor(() => expect(callLog(mock)).toContain('PATCH /participants/id1'))
    const call = mock.mock.calls.find(([, init]) => (init as RequestInit)?.method === 'PATCH')
    expect(JSON.parse(bodyOf(call))).toEqual({ name: 'Timur R.', version: 1 })
    // Enter moves the cursor down like a spreadsheet.
    expect(screen.getByRole('grid')).toHaveAttribute('aria-activedescendant', 'cell-id2-1')
  })

  it('cancels an edit with Escape and does not call the server', async () => {
    start()
    renderPage()
    await screen.findByText('Timur Rahimov')
    const user = userEvent.setup()
    await user.click(cell('Timur Rahimov'))
    await user.keyboard('{Enter}')
    await user.type(screen.getByRole('textbox', { name: 'Имя' }), 'zzz{Escape}')
    expect(screen.queryByRole('textbox', { name: 'Имя' })).not.toBeInTheDocument()
    expect(screen.getByText('Timur Rahimov')).toBeInTheDocument()
    expect(callLog(mock).some((c) => c.startsWith('PATCH'))).toBe(false)
  })

  it('navigates with arrows and Tab and starts typing-to-edit', async () => {
    start()
    renderPage()
    await screen.findByText('Timur Rahimov')
    const user = userEvent.setup()
    const grid = screen.getByRole('grid')
    await user.click(cell('Timur Rahimov'))
    expect(grid).toHaveAttribute('aria-activedescendant', 'cell-id1-1')
    await user.keyboard('{ArrowDown}{Tab}')
    expect(grid).toHaveAttribute('aria-activedescendant', 'cell-id2-2')
    await user.keyboard('{ArrowLeft}x')
    expect(screen.getByRole('textbox', { name: 'Имя' })).toHaveValue('x')
  })

  it('selects with click, Ctrl+click, Shift+click and select-visible', async () => {
    start()
    renderPage()
    await screen.findByText('Timur Rahimov')
    const user = userEvent.setup()
    await user.click(cell('Timur Rahimov'))
    expect(rowOf('Timur Rahimov')).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{Control>}')
    await user.click(cell('Otabek Karimov'))
    await user.keyboard('{/Control}')
    expect(rowOf('Otabek Karimov')).toHaveAttribute('aria-selected', 'true')
    expect(rowOf('Nadezhda Sokolova')).toHaveAttribute('aria-selected', 'false')
    await user.click(cell('Timur Rahimov'))
    await user.keyboard('{Shift>}')
    await user.click(cell('Otabek Karimov'))
    await user.keyboard('{/Shift}')
    expect(rowOf('Nadezhda Sokolova')).toHaveAttribute('aria-selected', 'true')
    const all = screen.getByRole('checkbox', { name: 'Выбрать все видимые' })
    expect(all).toBeChecked()
    await user.click(all)
    expect(screen.queryAllByRole('row', { selected: true })).toHaveLength(0)
    await user.click(all)
    expect(screen.getAllByRole('row', { selected: true })).toHaveLength(3)
  })

  it('creates rows from a spreadsheet paste (name and phone, dropping the No. column)', async () => {
    start()
    renderPage()
    await screen.findByText('Timur Rahimov')
    const user = userEvent.setup()
    await user.click(cell('Timur Rahimov'))
    await user.paste('4\tAnn Lee\t+1 111\r\n5\tBob Roy\t+2 222\r\n')
    await waitFor(() => expect(callLog(mock)).toContain('POST /projects/p1/participants'))
    const call = mock.mock.calls.find(
      ([url, init]) =>
        String(url).endsWith('/projects/p1/participants') && (init as RequestInit)?.method === 'POST',
    )
    expect(JSON.parse(bodyOf(call))).toEqual({
      items: [
        { name: 'Ann Lee', phone: '+1 111' },
        { name: 'Bob Roy', phone: '+2 222' },
      ],
    })
    expect(await screen.findByText('Ann Lee')).toBeInTheDocument()
  })

  it('adds N empty rows from the dialog', async () => {
    start()
    renderPage()
    await screen.findByText('Timur Rahimov')
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Добавить строки' }))
    const dialog = await screen.findByRole('dialog')
    const count = within(dialog).getByLabelText('Сколько пустых строк добавить')
    await user.clear(count)
    await user.type(count, '0')
    expect(within(dialog).getByRole('button', { name: 'Добавить' })).toHaveAttribute('aria-disabled', 'true')
    await user.clear(count)
    await user.type(count, '3')
    await user.click(within(dialog).getByRole('button', { name: 'Добавить' }))
    await waitFor(() => {
      const call = mock.mock.calls.find(
        ([url, init]) =>
          String(url).endsWith('/projects/p1/participants') && (init as RequestInit)?.method === 'POST',
      )
      expect(JSON.parse(bodyOf(call))).toEqual({ count: 3 })
    })
  })
})

describe('conflicts and locks', () => {
  const conflict = (): Response =>
    apiError(409, 'VERSION_CONFLICT', {
      current: { ...ROWS[0], name: 'Timur (theirs)', version: 5 },
    })

  it('offers "take theirs" after VERSION_CONFLICT and adopts the server copy', async () => {
    start({ patch: conflict })
    renderPage()
    await screen.findByText('Timur Rahimov')
    const user = userEvent.setup()
    await user.click(cell('Timur Rahimov'))
    await user.keyboard('{Enter}')
    await user.clear(screen.getByRole('textbox', { name: 'Имя' }))
    await user.type(screen.getByRole('textbox', { name: 'Имя' }), 'Timur (mine){Enter}')
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Timur (theirs)')
    expect(alert).toHaveTextContent('Timur (mine)')
    // The optimistic value was rolled back while the conflict is open.
    expect(screen.getByText('Timur Rahimov')).toBeInTheDocument()
    await user.click(within(alert).getByRole('button', { name: 'Взять чужое' }))
    expect(await screen.findByText('Timur (theirs)')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('retries on the current version with "keep mine"', async () => {
    let attempts = 0
    start({
      patch: (id, body) => {
        attempts++
        if (attempts === 1) return conflict()
        return jsonRes(200, { item: { ...ROWS[0], ...body, id, version: 6 } })
      },
    })
    renderPage()
    await screen.findByText('Timur Rahimov')
    const user = userEvent.setup()
    await user.click(cell('Timur Rahimov'))
    await user.keyboard('{Enter}')
    await user.clear(screen.getByRole('textbox', { name: 'Имя' }))
    await user.type(screen.getByRole('textbox', { name: 'Имя' }), 'Mine{Enter}')
    await user.click(await screen.findByRole('button', { name: 'Оставить моё' }))
    await waitFor(() => expect(attempts).toBe(2))
    const patches = mock.mock.calls.filter(([, init]) => (init as RequestInit)?.method === 'PATCH')
    expect(JSON.parse(bodyOf(patches[1]))).toEqual({ name: 'Mine', version: 5 })
    expect(await screen.findByText('Mine')).toBeInTheDocument()
  })

  it('shows who is editing after ROW_LOCKED, locks the row and rolls the value back', async () => {
    start({ patch: () => apiError(409, 'ROW_LOCKED', { by: 'u2' }) })
    renderPage()
    await screen.findByText('Timur Rahimov')
    const user = userEvent.setup()
    await user.click(cell('Timur Rahimov'))
    await user.keyboard('{Enter}')
    await user.clear(screen.getByRole('textbox', { name: 'Имя' }))
    await user.type(screen.getByRole('textbox', { name: 'Имя' }), 'Nope{Enter}')
    await waitFor(() => expect(rowOf('Timur Rahimov')).toHaveAttribute('data-locked', 'true'))
    expect(within(rowOf('Timur Rahimov')).getByText('Редактирует Azam Tursunov')).toBeInTheDocument()
    // A locked row refuses edits.
    await user.click(cell('Timur Rahimov'))
    await user.keyboard('{F2}')
    expect(screen.queryByRole('textbox', { name: 'Имя' })).not.toBeInTheDocument()
  })
})

describe('delete with undo', () => {
  it('defers the request, cancels it on Undo, and sends it otherwise', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    start()
    renderPage()
    await screen.findByText('Timur Rahimov')
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })

    await user.click(cell('Nadezhda Sokolova'))
    await user.keyboard('{Delete}')
    expect(await screen.findByText('Удалена 1 запись')).toBeInTheDocument()
    await act(async () => void vi.advanceTimersByTime(400))
    expect(screen.queryByText('Nadezhda Sokolova')).not.toBeInTheDocument()
    expect(callLog(mock).some((c) => c.endsWith('/delete'))).toBe(false)

    await user.click(screen.getByRole('button', { name: 'Отменить' }))
    expect(await screen.findByText('Nadezhda Sokolova')).toBeInTheDocument()
    await act(async () => void vi.advanceTimersByTime(10_000))
    expect(callLog(mock).some((c) => c.endsWith('/delete'))).toBe(false)

    await user.click(cell('Otabek Karimov'))
    await user.keyboard('{Delete}')
    await act(async () => void vi.advanceTimersByTime(4000))
    expect(callLog(mock).some((c) => c.endsWith('/delete'))).toBe(false)
    await act(async () => void vi.advanceTimersByTime(2000))
    await waitFor(() => expect(callLog(mock)).toContain('POST /projects/p1/participants/delete'))
    const del = mock.mock.calls.find(([url]) => String(url).endsWith('/delete'))
    expect(JSON.parse(bodyOf(del))).toEqual({ ids: ['id3'] })
  })

  it('does not delete without participant.delete', async () => {
    start({ perms: ALL_PERMISSIONS.filter((p) => p !== 'participant.delete') })
    renderPage()
    await screen.findByText('Timur Rahimov')
    const user = userEvent.setup()
    await user.click(cell('Timur Rahimov'))
    await user.keyboard('{Delete}')
    expect(screen.getByText('Timur Rahimov')).toBeInTheDocument()
    expect(screen.queryByText('Удалена 1 запись')).not.toBeInTheDocument()
  })
})

describe('permission gating', () => {
  const without = (...hide: string[]) => ALL_PERMISSIONS.filter((p) => !hide.includes(p))

  it('shows every action to a user with all permissions', async () => {
    start()
    renderPage()
    await screen.findByText('Timur Rahimov')
    for (const name of [
      /^Печать/,
      'Копировать билет',
      'Сохранить билет',
      'Импорт',
      'Экспорт',
      'Настройки проекта',
      'Добавить строки',
    ]) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument()
    }
  })

  it('hides print, copy and save without participant.print (and the shortcut hint)', async () => {
    start({ perms: without('participant.print') })
    renderPage()
    await screen.findByText('Timur Rahimov')
    for (const name of [/^Печать/, 'Копировать билет', 'Сохранить билет']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument()
    }
    expect(screen.queryByText('Копировать —')).not.toBeInTheDocument()
  })

  it('hides settings without project.update, export without participant.export, import without participant.import', async () => {
    start({ perms: without('project.update', 'participant.export', 'participant.import') })
    renderPage()
    await screen.findByText('Timur Rahimov')
    expect(screen.queryByRole('button', { name: 'Настройки проекта' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Экспорт' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Импорт' })).not.toBeInTheDocument()
  })

  it('hides editing controls without participant.edit', async () => {
    start({ perms: without('participant.edit') })
    renderPage()
    await screen.findByText('Timur Rahimov')
    expect(screen.queryByRole('button', { name: 'Добавить строки' })).not.toBeInTheDocument()
    const user = userEvent.setup()
    await user.click(cell('Timur Rahimov'))
    await user.keyboard('{Enter}')
    expect(screen.queryByRole('textbox', { name: 'Имя' })).not.toBeInTheDocument()
  })

  it('makes a finished project read-only with a banner, keeping print available', async () => {
    start({ status: 'finished' })
    renderPage()
    await screen.findByText('Timur Rahimov')
    expect(screen.getByText(/Проект завершён — только просмотр/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Добавить строки' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Импорт' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Печать/ })).toBeInTheDocument()
    const user = userEvent.setup()
    await user.click(cell('Timur Rahimov'))
    await user.keyboard('{Enter}')
    expect(screen.queryByRole('textbox', { name: 'Имя' })).not.toBeInTheDocument()
  })

  it('shows the copy shortcut for the current platform', async () => {
    start()
    renderPage()
    await screen.findByText('Timur Rahimov')
    expect(screen.getByText('Ctrl')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'c', ctrlKey: true })
  })
})

describe('empty and error states', () => {
  it('shows the no-image empty state in the picture panel', async () => {
    start()
    renderPage()
    expect(await screen.findByText('У проекта ещё нет картинки')).toBeInTheDocument()
  })

  it('shows the empty table with a next step', async () => {
    start({ rows: [] })
    renderPage()
    expect(await screen.findByText('Участников пока нет')).toBeInTheDocument()
  })
})

describe('U1 workspace fixes', () => {
  it('drops rows hidden by the search from the selection and the delete button', async () => {
    start()
    renderPage()
    await screen.findByText('Timur Rahimov')
    const user = userEvent.setup()
    await user.click(cell('Timur Rahimov'))
    expect(screen.getByRole('button', { name: /^Удалить/ })).toBeInTheDocument()
    await user.type(screen.getByRole('searchbox', { name: 'Поиск по участникам' }), 'zzz-no-match')
    expect(await screen.findByText('Ничего не найдено')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Удалить/ })).not.toBeInTheDocument()
  })

  it('keeps the typed value after a failed save and offers a retry', async () => {
    let fail = true
    start({
      patch: (_id, body) =>
        fail ? apiError(500, 'INTERNAL') : jsonRes(200, { item: { ...ROWS[0], ...body, version: 2 } }),
    })
    renderPage()
    await screen.findByText('Timur Rahimov')
    const user = userEvent.setup()
    await user.click(cell('Timur Rahimov'))
    await user.keyboard('{Enter}')
    await user.clear(screen.getByRole('textbox', { name: 'Имя' }))
    await user.type(screen.getByRole('textbox', { name: 'Имя' }), 'Typed Name{Enter}')
    const retry = await screen.findByRole('button', { name: /Повторить сохранение строки № 1/ })
    expect(screen.getByText('Typed Name')).toBeInTheDocument()
    fail = false
    await user.click(retry)
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /Повторить сохранение/ })).not.toBeInTheDocument(),
    )
    expect(screen.getByText('Typed Name')).toBeInTheDocument()
  })

  it('highlights a suspicious phone and warns before printing', async () => {
    start({ rows: [...ROWS, person(4, 'Bad Phone', 'abc')] })
    renderPage()
    await screen.findByText('Bad Phone')
    expect(within(cell('abc')).getByTitle(/Похоже на неверный номер/)).toBeInTheDocument()
    const user = userEvent.setup()
    await user.click(cell('Bad Phone'))
    await user.click(screen.getByRole('button', { name: 'Печать (1)' }))
    const dialog = await screen.findByRole('dialog', { name: 'Проверьте номера телефонов' })
    expect(within(dialog).getByText(/У 1 из 1 выбранных/)).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Вернуться и исправить' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('shows the selected count on the print button', async () => {
    start()
    renderPage()
    await screen.findByText('Timur Rahimov')
    expect(screen.getByRole('button', { name: 'Печать (1)' })).toBeInTheDocument()
    const user = userEvent.setup()
    await user.click(screen.getByRole('checkbox', { name: 'Выбрать все видимые' }))
    expect(screen.getByRole('button', { name: 'Печать (3)' })).toBeInTheDocument()
  })
})
