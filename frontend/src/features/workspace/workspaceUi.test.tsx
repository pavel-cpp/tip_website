import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearAccessToken } from '../../auth/tokenStore'
import { initI18n, setLocale } from '../../i18n'
import { jsonRes, stubFetch } from '../../test/mockApi'
import { renderWithProviders } from '../../test/render'
import type { Participant } from './api'
import { ImportDialog } from './Dialogs'
import { workspaceRu } from './messages.ru'
import { workspaceUz } from './messages.uz'
import { ParticipantsTable, type ParticipantsTableProps } from './ParticipantsTable'
import { copyShortcutLabel, hasCommandKey, isApplePlatform } from './platform'
import type { RowPresence } from './presence'
import { nextZoom, ZOOM_STEPS } from './TicketPanel'

beforeAll(async () => {
  await initI18n()
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
afterEach(async () => {
  clearAccessToken()
  vi.unstubAllGlobals()
  await setLocale('ru')
})

const person = (n: number, name: string): Participant => ({
  id: `id${n}`,
  projectId: 'p1',
  number: n,
  name,
  phone: '+1',
  version: 1,
  updatedAt: '2026-11-07T10:00:00Z',
})
const ROWS = [person(1, 'Timur'), person(2, 'Nadezhda'), person(3, 'Otabek')]
const AZAM = { id: 'u2', displayName: 'Azam Tursunov', color: '#ffb84d', avatarUrl: null }

function Harness({ presence }: { presence: RowPresence }) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [query, setQuery] = useState('')
  const props: ParticipantsTableProps = {
    rows: ROWS,
    loading: false,
    canEdit: true,
    selected,
    onSelectedChange: setSelected,
    currentId: null,
    onCurrentChange: () => undefined,
    presence,
    onCommit: async () => ({ status: 'ok' }),
    onAdopt: () => undefined,
    onClear: () => undefined,
    onAddRows: () => undefined,
    onPaste: () => undefined,
    query,
    onQueryChange: setQuery,
  }
  return <ParticipantsTable {...props} />
}

describe('row lock presentation (realtime seam)', () => {
  const locked: RowPresence = { locks: new Map([['id2', AZAM]]), cursors: new Map() }
  const none: RowPresence = { locks: new Map(), cursors: new Map() }
  const rowOf = (name: string) => screen.getByText(name).closest('[role="row"]') as HTMLElement

  it('outlines a locked row in the editor colour with an "Editing: <name>" tooltip', () => {
    render(<Harness presence={locked} />)
    const row = rowOf('Nadezhda')
    expect(row).toHaveAttribute('data-locked', 'true')
    expect(row.style.getPropertyValue('--lock')).toBe('#ffb84d')
    expect(row.querySelector('.pt-lock-ring')).not.toBeNull()
    expect(within(row).getByText('Редактирует Azam Tursunov')).toBeInTheDocument()
    expect(rowOf('Timur')).not.toHaveAttribute('data-locked')
  })

  it('refuses editing a locked row and shakes the outline instead', async () => {
    render(<Harness presence={locked} />)
    const user = userEvent.setup()
    await user.click(screen.getByText('Nadezhda'))
    await user.keyboard('{F2}')
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(rowOf('Nadezhda').querySelector('.pt-lock-ring')).toHaveAttribute('data-shake')
    expect(rowOf('Nadezhda')).toHaveAttribute('data-tip', 'true')
    await user.dblClick(screen.getByText('Nadezhda'))
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('opens the tooltip by tap on touch devices', async () => {
    render(<Harness presence={locked} />)
    const cellEl = screen.getByText('Nadezhda').closest('[role="gridcell"]') as HTMLElement
    fireEvent.pointerDown(screen.getByRole('grid'), { pointerType: 'touch' })
    fireEvent.click(cellEl)
    expect(rowOf('Nadezhda')).toHaveAttribute('data-tip', 'true')
  })

  it('releases the lock when presence clears, and draws colleague cursors on the cursor layer', () => {
    const { rerender } = render(<Harness presence={locked} />)
    rerender(
      <Harness
        presence={{
          locks: none.locks,
          cursors: new Map([['id1', [{ id: 'u2', displayName: 'Azam Tursunov', color: '#3ddc97' }]]]),
        }}
      />,
    )
    expect(rowOf('Nadezhda')).not.toHaveAttribute('data-locked')
    const cursor = document.querySelector('.pt-cursors .pt-cursor') as HTMLElement
    expect(cursor).not.toBeNull()
    expect(cursor.style.background).not.toBe('')
    expect(cursor.style.transform).toMatch(/^translateY\(\d+px\) scaleY\(36\)$/)
    expect(rowOf('Timur')).not.toHaveAttribute('data-locked')
  })
})

describe('import dialog', () => {
  beforeEach(() => undefined)

  it('runs a dry run, lists row errors, and imports in the chosen mode on confirm', async () => {
    const mock = stubFetch(({ method, path, body }) => {
      if (method === 'POST' && path.startsWith('/projects/p1/participants/import')) {
        const dry = path.includes('dryRun=1')
        const form = body as FormData
        return jsonRes(200, {
          dryRun: dry,
          mode: form.get('mode'),
          total: 3,
          valid: 2,
          imported: dry ? 0 : 2,
          errors: [{ row: 3, field: 'phone', code: 'too_long', message: 'phone is too long' }],
        })
      }
      return undefined
    })
    const onDone = vi.fn()
    renderWithProviders(<ImportDialog open projectId="p1" onClose={() => undefined} onDone={onDone} />)
    const user = userEvent.setup()
    const file = new File(['name,phone\nA,1\n'], 'people.csv', { type: 'text/csv' })
    await user.upload(screen.getByTestId('import-file'), file)

    expect(await screen.findByText(/Найдено строк: 3\. Без ошибок: 2\. С ошибками: 1\./)).toBeInTheDocument()
    const table = screen.getByRole('table')
    expect(within(table).getByText('phone is too long')).toBeInTheDocument()
    expect(within(table).getByText('Номер телефона')).toBeInTheDocument()
    // No real import happened yet.
    const imports = () => mock.mock.calls.filter(([url]) => String(url).includes('/import'))
    expect(imports().every(([url]) => String(url).includes('dryRun=1'))).toBe(true)

    await user.click(screen.getByRole('radio', { name: /Заменить всю таблицу/ }))
    expect(await screen.findByText(/текущие строки будут удалены/)).toBeInTheDocument()
    await waitFor(() => expect(imports().length).toBe(2))

    await user.click(screen.getByRole('button', { name: 'Импортировать 2 строки' }))
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
    const last = imports().at(-1) as [string, RequestInit]
    expect(String(last[0])).not.toContain('dryRun')
    expect((last[1].body as FormData).get('mode')).toBe('replace')
    expect((last[1].body as FormData).get('file')).toBeInstanceOf(File)
  })

  it('keeps confirm disabled when the file has no valid rows or the API rejects it', async () => {
    stubFetch(({ method, path }) =>
      method === 'POST' && path.startsWith('/projects/p1/participants/import')
        ? jsonRes(415, { error: { code: 'UNSUPPORTED_MEDIA', message: 'x' } })
        : undefined,
    )
    renderWithProviders(
      <ImportDialog open projectId="p1" onClose={() => undefined} onDone={() => undefined} />,
    )
    await userEvent.setup().upload(screen.getByTestId('import-file'), new File(['x'], 'a.csv'))
    expect(await screen.findByRole('alert')).toHaveTextContent('Этот тип файла не поддерживается')
    expect(screen.getByRole('button', { name: /Импортировать/ })).toHaveAttribute('aria-disabled', 'true')
  })
})

describe('platform and zoom helpers', () => {
  it('shows Cmd on Apple platforms and Ctrl elsewhere', () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel', userAgent: 'Mac', maxTouchPoints: 0 })
    expect(isApplePlatform()).toBe(true)
    expect(copyShortcutLabel()).toBe('Cmd')
    expect(hasCommandKey({ metaKey: true, ctrlKey: false })).toBe(true)
    expect(hasCommandKey({ metaKey: false, ctrlKey: true })).toBe(false)

    vi.stubGlobal('navigator', { platform: 'Win32', userAgent: 'Windows', maxTouchPoints: 0 })
    expect(copyShortcutLabel()).toBe('Ctrl')
    expect(hasCommandKey({ metaKey: false, ctrlKey: true })).toBe(true)

    vi.stubGlobal('navigator', {
      platform: 'MacIntel',
      userAgent: 'Mozilla/5.0 (Macintosh)',
      maxTouchPoints: 5,
    })
    expect(copyShortcutLabel()).toBe('Cmd')
  })

  it('steps through zoom levels and stops at the ends', () => {
    expect(nextZoom(1, 1)).toBe(1.5)
    expect(nextZoom(1, -1)).toBe(0.75)
    expect(nextZoom(ZOOM_STEPS[ZOOM_STEPS.length - 1] as number, 1)).toBe(3)
    expect(nextZoom(0.5, -1)).toBe(0.5)
  })
})

describe('workspace i18n namespace', () => {
  const keys = (o: object) => Object.keys(o).sort()
  const text = (m: unknown) => (typeof m === 'string' ? m : Object.values(m as object).join(' '))
  const placeholders = (m: unknown) => new Set([...text(m).matchAll(/\{(\w+)\}/g)].map((x) => x[1]))

  it('has the same keys in ru and uz, all under workspace.', () => {
    expect(keys(workspaceUz)).toEqual(keys(workspaceRu))
    expect(keys(workspaceRu).every((k) => k.startsWith('workspace.'))).toBe(true)
  })

  it('uses the same placeholders and plural shape per key', () => {
    for (const k of keys(workspaceRu)) {
      const a = (workspaceRu as Record<string, unknown>)[k]
      const b = (workspaceUz as Record<string, unknown>)[k]
      expect(typeof b, k).toBe(typeof a)
      expect(placeholders(b), k).toEqual(placeholders(a))
    }
  })

  it('has no empty strings and Cyrillic only in ru plus the shared numero sign', () => {
    for (const [k, v] of Object.entries(workspaceUz)) {
      expect(text(v).trim(), k).not.toBe('')
      expect(/[а-яё]/i.test(text(v)), k).toBe(false)
    }
  })

  it('switches the workspace UI to Uzbek', async () => {
    await setLocale('uz')
    const { t } = await import('../../i18n')
    expect(t('workspace.addRows')).toBe('Qatorlar qoʻshish')
  })
})
