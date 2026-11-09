import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n } from '../../i18n'
import { BulkBar, type BulkBarProps } from './BulkBar'

beforeAll(async () => {
  await initI18n()
})

function setup(over: Partial<BulkBarProps> = {}) {
  const props: BulkBarProps = {
    count: 3,
    canClear: true,
    canPrint: true,
    copyReady: false,
    saveReady: true,
    onPrint: vi.fn(),
    onCopy: vi.fn(),
    onSave: vi.fn(),
    onClear: vi.fn(),
    onDone: vi.fn(),
    ...over,
  }
  render(<BulkBar {...props} />)
  return props
}

describe('bulk bar', () => {
  it('is one row: close, count, Print (N), clear and a menu', async () => {
    const p = setup()
    const bar = screen.getByRole('toolbar', { name: 'Действия с выбранными строками' })
    expect(within(bar).getByRole('status')).toHaveTextContent('выбрано 3')
    await userEvent.setup().click(within(bar).getByRole('button', { name: 'Печать (3)' }))
    expect(p.onPrint).toHaveBeenCalled()
    await userEvent.setup().click(within(bar).getByRole('button', { name: 'Очистить (3)' }))
    expect(p.onClear).toHaveBeenCalled()
    await userEvent.setup().click(within(bar).getByRole('button', { name: 'Готово' }))
    expect(p.onDone).toHaveBeenCalled()
  })

  it('labels Copy as one-ticket-only and offers a ZIP for several rows', async () => {
    const p = setup()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Ещё' }))
    const copy = await screen.findByRole('menuitem', { name: 'Копировать билет (только один)' })
    expect(copy).toHaveAttribute('aria-disabled', 'true')
    await userEvent.setup().click(screen.getByRole('menuitem', { name: 'Сохранить 3 билета в ZIP' }))
    expect(p.onSave).toHaveBeenCalled()
  })

  it('disables Print and Clear while nothing is selected', () => {
    setup({ count: 0 })
    expect(screen.getByRole('button', { name: 'Печать' })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByRole('button', { name: 'Очистить (0)' })).toHaveAttribute('aria-disabled', 'true')
  })

  it('hides ticket actions without the print permission', () => {
    setup({ canPrint: false })
    expect(screen.queryByRole('button', { name: /Печать/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Ещё' })).toBeNull()
  })
})
