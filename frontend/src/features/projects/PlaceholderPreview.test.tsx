import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n } from '../../i18n'
import type { TicketPlaceholder, TicketPlaceholders } from '../../lib/ticket'
import { PlaceholderPreview } from './PlaceholderPreview'

const ph = (x: number, y: number): TicketPlaceholder => ({
  font: 'Montserrat',
  size: 30,
  stroke: 2,
  color: '#FFFFFF',
  strokeColor: '#141619',
  bold: true,
  italic: false,
  underline: false,
  x,
  y,
})
const placeholders: TicketPlaceholders = { number: ph(500, 100), name: ph(500, 250), phone: ph(500, 400) }
const values = { number: '5', name: 'Azam', phone: '+998' }
const image = {
  width: 1000,
  height: 500,
  naturalWidth: 1000,
  naturalHeight: 500,
} as unknown as HTMLImageElement

beforeAll(() => initI18n())
beforeEach(() => {
  // jsdom has no canvas: a context stub is enough because only the calls matter here.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage() {},
    fillText() {},
    strokeText() {},
    fillRect() {},
    measureText: () => ({ width: 10 }),
    scale() {},
  } as unknown as CanvasRenderingContext2D)
  // The stage is shown at half size: 500 x 250 on screen for a 1000 x 500 image.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    top: 0,
    width: 500,
    height: 250,
    right: 500,
    bottom: 250,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  })
})
afterEach(() => vi.restoreAllMocks())

function setup(extra: Partial<React.ComponentProps<typeof PlaceholderPreview>> = {}) {
  const onMove = vi.fn()
  const onSelect = vi.fn()
  render(
    <PlaceholderPreview
      image={image}
      size={{ w: 1000, h: 500 }}
      placeholders={placeholders}
      values={values}
      active="name"
      onSelect={onSelect}
      onMove={onMove}
      {...extra}
    />,
  )
  return { onMove, onSelect, chip: screen.getByRole('button', { name: 'Имя, перетащить' }) }
}

describe('PlaceholderPreview dragging', () => {
  it('renders one chip per placeholder and marks the active one', () => {
    setup()
    expect(screen.getAllByRole('button')).toHaveLength(3)
    expect(screen.getByRole('button', { name: 'Имя, перетащить' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Номер телефона, перетащить' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })

  it('selects on press and follows the pointer 1:1 in image pixels', () => {
    const { chip, onMove, onSelect } = setup()
    fireEvent.pointerDown(chip, { pointerId: 1, button: 0, clientX: 250, clientY: 125 })
    expect(onSelect).toHaveBeenCalledWith('name')
    fireEvent.pointerMove(chip, { pointerId: 1, clientX: 300, clientY: 150 })
    // 50 screen px at half size are 100 image px.
    expect(onMove).toHaveBeenLastCalledWith('name', { x: 600, y: 300 })
    fireEvent.pointerUp(chip, { pointerId: 1, clientX: 300, clientY: 150 })
  })

  it('does not drag when disabled', () => {
    const { chip, onMove } = setup({ disabled: true })
    fireEvent.pointerDown(chip, { pointerId: 1, button: 0, clientX: 250, clientY: 125 })
    fireEvent.pointerMove(chip, { pointerId: 1, clientX: 300, clientY: 150 })
    expect(onMove).not.toHaveBeenCalled()
  })

  it('nudges with arrow keys by 1 px and by 10 px with Shift', () => {
    const { chip, onMove } = setup()
    fireEvent.keyDown(chip, { key: 'ArrowRight' })
    expect(onMove).toHaveBeenLastCalledWith('name', { x: 501, y: 250 })
    fireEvent.keyDown(chip, { key: 'ArrowUp', shiftKey: true })
    expect(onMove).toHaveBeenLastCalledWith('name', { x: 500, y: 240 })
  })
})
