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
  it('is one row: close, count, primary Copy (N), then Save, Print and Clear', async () => {
    const p = setup({ copyReady: true })
    const bar = screen.getByRole('toolbar', { name: 'Действия с выбранными строками' })
    expect(within(bar).getByRole('status')).toHaveTextContent('выбрано 3')
    const user = userEvent.setup()
    await user.click(within(bar).getByRole('button', { name: 'Копировать (3)' }))
    expect(p.onCopy).toHaveBeenCalled()
    await user.click(within(bar).getByRole('button', { name: 'Сохранить 3 билета в ZIP' }))
    expect(p.onSave).toHaveBeenCalled()
    await user.click(within(bar).getByRole('button', { name: 'Печать (3)' }))
    expect(p.onPrint).toHaveBeenCalled()
    await user.click(within(bar).getByRole('button', { name: 'Очистить (3)' }))
    expect(p.onClear).toHaveBeenCalled()
    await user.click(within(bar).getByRole('button', { name: 'Готово' }))
    expect(p.onDone).toHaveBeenCalled()
  })

  it('makes Copy the only primary action and keeps Print neutral', () => {
    setup({ copyReady: true })
    const copy = screen.getByRole('button', { name: 'Копировать (3)' })
    const print = screen.getByRole('button', { name: 'Печать (3)' })
    expect(copy.className).toContain('primary')
    expect(print.className).not.toContain('primary')
  })

  it('disables Print and Clear while nothing is selected', () => {
    setup({ count: 0 })
    expect(screen.getByRole('button', { name: 'Печать' })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByRole('button', { name: 'Копировать билет' })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByRole('button', { name: 'Очистить (0)' })).toHaveAttribute('aria-disabled', 'true')
  })

  it('hides ticket actions without the print permission', () => {
    setup({ canPrint: false })
    expect(screen.queryByRole('button', { name: /Печать/ })).toBeNull()
  })
})
