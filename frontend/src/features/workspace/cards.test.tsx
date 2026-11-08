import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n, setLocale } from '../../i18n'
import type { Participant } from './api'
import { ParticipantsTable, type ParticipantsTableProps } from './ParticipantsTable'
import type { RowPresence } from './presence'

beforeAll(async () => {
  await initI18n()
  for (const prop of ['offsetHeight', 'clientHeight']) {
    Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: () => 600 })
  }
  for (const prop of ['offsetWidth', 'clientWidth']) {
    Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: () => 360 })
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
  vi.useRealTimers()
  await setLocale('ru')
})

const person = (n: number, name: string, phone = '+998901234567'): Participant => ({
  id: `id${n}`,
  projectId: 'p1',
  number: n,
  name,
  phone,
  version: 1,
  updatedAt: '2026-11-07T10:00:00Z',
})
const LONG = 'Abdurahmonova-Xudoyberdiyeva Dilnozaxon Alisherovna'
const ROWS = [person(1, 'Timur'), person(2, 'Nadezhda'), person(3, LONG, '+998 90 108 33 44')]
const AZAM = { id: 'u2', displayName: 'Azam Tursunov', color: '#ffb84d', avatarUrl: null }
const none: RowPresence = { locks: new Map(), cursors: new Map() }

function Harness(props: Partial<ParticipantsTableProps> & { presence?: RowPresence }) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [query, setQuery] = useState('')
  return (
    <ParticipantsTable
      rows={ROWS}
      loading={false}
      canEdit
      canDelete
      selected={selected}
      onSelectedChange={setSelected}
      currentId={null}
      onCurrentChange={() => undefined}
      presence={none}
      onCommit={async () => ({ status: 'ok' })}
      onAdopt={() => undefined}
      onDelete={() => undefined}
      onAddRows={() => undefined}
      onPasteRows={() => undefined}
      query={query}
      onQueryChange={setQuery}
      cards
      {...props}
    />
  )
}

const card = (text: string) => screen.getByText(text).closest('[role="listitem"]') as HTMLElement

describe('phone cards', () => {
  it('shows number, the full name and the full phone without truncation', () => {
    render(<Harness />)
    const c = card(LONG)
    expect(within(c).getByText('3')).toBeInTheDocument()
    expect(within(c).getByText('+998 90 108 33 44')).toBeInTheDocument()
    expect(screen.queryByRole('grid')).not.toBeInTheDocument()
  })

  it('opens the sheet on tap, saves both fields in one patch and closes', async () => {
    const onCommit = vi.fn(async () => ({ status: 'ok' as const }))
    render(<Harness onCommit={onCommit} />)
    const user = userEvent.setup()
    await user.click(within(card('Timur')).getByRole('button'))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Строка № 1')).toBeInTheDocument()
    const name = within(dialog).getByLabelText('Имя')
    expect(name).toHaveFocus()
    await user.clear(name)
    await user.type(name, 'Timur K')
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }))
    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(1))
    expect(onCommit).toHaveBeenCalledWith(expect.objectContaining({ id: 'id1' }), { name: 'Timur K' })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('closes on Escape, and pages to the next row', async () => {
    render(<Harness />)
    const user = userEvent.setup()
    await user.click(within(card('Timur')).getByRole('button'))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Следующая строка' }))
    expect(await screen.findByText('Строка № 2')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('does not open a row a colleague is editing and says who holds it', async () => {
    const onNotify = vi.fn()
    const presence: RowPresence = { locks: new Map([['id2', AZAM]]), cursors: new Map() }
    render(<Harness presence={presence} onNotify={onNotify} />)
    const c = card('Nadezhda')
    expect(c).toHaveAttribute('data-locked', 'true')
    expect(c.style.getPropertyValue('--lock')).toBe('#ffb84d')
    await userEvent.setup().click(within(c).getByRole('button'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(onNotify).toHaveBeenCalledWith(expect.stringContaining('Azam Tursunov'))
  })

  it('marks cards with an unsent edit', () => {
    render(<Harness unsentIds={new Set(['id1'])} />)
    expect(within(card('Timur')).getByText('Не отправлено')).toBeInTheDocument()
    expect(within(card('Nadezhda')).queryByText('Не отправлено')).not.toBeInTheDocument()
  })

  it('keeps a failed save on the card with a retry that resends it', async () => {
    const onCommit = vi.fn(async () => ({ status: 'error' as const }))
    render(<Harness onCommit={onCommit} />)
    const user = userEvent.setup()
    await user.click(within(card('Timur')).getByRole('button'))
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText('Имя'), ' K')
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Не удалось сохранить')
    await user.click(within(dialog).getByRole('button', { name: 'Закрыть' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    const retry = within(card('Timur K')).getByRole('button', { name: /Повторить сохранение строки № 1/ })
    await user.click(retry)
    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(2))
    expect(onCommit).toHaveBeenLastCalledWith(expect.anything(), { name: 'Timur K' })
  })

  it('enters selection mode on long press with a bar of bulk actions', async () => {
    vi.useFakeTimers()
    const onDelete = vi.fn()
    render(<Harness onDelete={onDelete} canPrint copyReady />)
    const main = within(card('Timur')).getByRole('button')
    fireEvent.pointerDown(main)
    act(() => {
      vi.advanceTimersByTime(600)
    })
    // The click that follows the long press must not open the sheet.
    fireEvent.click(main)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    const bar = screen.getByRole('toolbar', { name: 'Действия с выбранными строками' })
    expect(within(bar).getByRole('status')).toHaveTextContent('выбрана 1')
    expect(within(bar).getByRole('button', { name: 'Печать' })).toBeEnabled()

    fireEvent.click(within(card('Nadezhda')).getByRole('button'))
    expect(within(bar).getByRole('status')).toHaveTextContent('выбрано 2')
    fireEvent.click(within(bar).getByRole('button', { name: 'Удалить (2)' }))
    expect(onDelete).toHaveBeenCalledWith(['id1', 'id2'])
    expect(screen.queryByRole('toolbar', { name: 'Действия с выбранными строками' })).not.toBeInTheDocument()
  })

  it('a press that moves is a scroll and does not select', () => {
    vi.useFakeTimers()
    render(<Harness />)
    const main = within(card('Timur')).getByRole('button')
    fireEvent.pointerDown(main, { clientX: 10, clientY: 10 })
    fireEvent.pointerMove(main, { clientX: 10, clientY: 60 })
    act(() => {
      vi.advanceTimersByTime(600)
    })
    expect(screen.queryByRole('toolbar', { name: 'Действия с выбранными строками' })).not.toBeInTheDocument()
  })
})
