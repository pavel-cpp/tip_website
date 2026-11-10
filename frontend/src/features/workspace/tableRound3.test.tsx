import { fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n } from '../../i18n'
import type { Participant } from './api'
import { ParticipantsTable, type ParticipantsTableProps } from './ParticipantsTable'
import type { RowPresence } from './presence'

beforeAll(async () => {
  await initI18n()
  for (const prop of ['offsetHeight', 'clientHeight']) {
    Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: () => 600 })
  }
  for (const prop of ['offsetWidth', 'clientWidth']) {
    Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: () => 900 })
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

const row = (n: number, name: string): Participant => ({
  id: `id${n}`,
  projectId: 'p1',
  number: n,
  name,
  phone: '+998901234567',
  version: 1,
  updatedAt: '2026-11-07T10:00:00Z',
})
const none: RowPresence = { locks: new Map(), cursors: new Map() }

function Harness(props: Partial<ParticipantsTableProps>) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  return (
    <ParticipantsTable
      rows={[row(1, 'Timur'), row(2, 'Nadezhda')]}
      loading={false}
      canEdit
      selected={selected}
      onSelectedChange={setSelected}
      currentId={null}
      onCurrentChange={() => undefined}
      presence={none}
      onCommit={async () => ({ status: 'ok' })}
      onAdopt={() => undefined}
      onClear={() => undefined}
      onAddRows={() => undefined}
      onPaste={() => undefined}
      query=""
      onQueryChange={() => undefined}
      {...props}
    />
  )
}

describe('table toolbar and unsent marker', () => {
  it('keeps the clear button out of the layout until rows are selected (N7)', () => {
    render(<Harness />)
    expect(screen.queryByRole('button', { name: /Очистить/ })).not.toBeInTheDocument()
    const first = document.querySelector('[data-row-id="id1"] [data-col-name="name"]') as HTMLElement
    fireEvent.click(first)
    expect(screen.getByRole('button', { name: 'Очистить 1 строку' })).toBeInTheDocument()
  })

  it('shows the unsent marker beside the number, not over the cells (N6)', () => {
    render(<Harness unsentIds={new Set(['id1'])} />)
    const rowEl = document.querySelector('[data-row-id="id1"]') as HTMLElement
    const mark = within(rowEl).getByRole('img', { name: 'Не отправлено' })
    expect(mark.closest('[data-col-name="number"]')).not.toBeNull()
    expect(
      within(document.querySelector('[data-row-id="id2"]') as HTMLElement).queryByRole('img', {
        name: 'Не отправлено',
      }),
    ).toBeNull()
  })
})
