import { describe, expect, it, vi } from 'vitest'
import {
  A4_MM,
  COLUMNS,
  canvasScale,
  drawTicket,
  fontSpec,
  GAP_MM,
  loadFonts,
  MAX_CANVAS_PIXELS,
  pageCount,
  paginate,
  printCss,
  ROWS,
  releaseCanvas,
  renderTicket,
  slotFor,
  slotRect,
  TICKET_ASPECT,
  TICKET_MM,
  TICKETS_PER_PAGE,
  type TicketImage,
  type TicketPlaceholder,
  type TicketPlaceholders,
} from './index'

const ph = (over: Partial<TicketPlaceholder> = {}): TicketPlaceholder => ({
  font: 'Montserrat',
  size: 30,
  stroke: 2,
  color: '#ffffff',
  strokeColor: '#141619',
  bold: true,
  italic: false,
  underline: false,
  x: 100,
  y: 50,
  ...over,
})
const all = (over: Partial<TicketPlaceholder> = {}): TicketPlaceholders => ({
  number: ph({ ...over, y: 10 }),
  name: ph({ ...over, y: 20 }),
  phone: ph({ ...over, y: 30 }),
})

describe('print layout', () => {
  it('uses the desktop constants', () => {
    expect(TICKET_MM).toEqual({ w: 70, h: 40 })
    expect(GAP_MM).toBe(0.5)
    expect(A4_MM).toEqual({ w: 210, h: 297 })
    expect(TICKET_ASPECT).toBeCloseTo(1.75)
  })

  it('fits 3 x 7 = 21 tickets per A4 page', () => {
    expect(COLUMNS).toBe(3)
    expect(ROWS).toBe(7)
    expect(TICKETS_PER_PAGE).toBe(21)
    // Rows must fit vertically without any tolerance.
    expect(ROWS * TICKET_MM.h + (ROWS - 1) * GAP_MM).toBeLessThanOrEqual(A4_MM.h)
  })

  it('flows left to right, then down, then to a new page', () => {
    expect(slotFor(0)).toEqual({ page: 0, row: 0, col: 0 })
    expect(slotFor(2)).toEqual({ page: 0, row: 0, col: 2 })
    expect(slotFor(3)).toEqual({ page: 0, row: 1, col: 0 })
    expect(slotFor(20)).toEqual({ page: 0, row: 6, col: 2 })
    expect(slotFor(21)).toEqual({ page: 1, row: 0, col: 0 })
  })

  it('places frames with the gap and zero margins', () => {
    expect(slotRect(0)).toEqual({ x: 0, y: 0, w: 70, h: 40 })
    expect(slotRect(1).x).toBeCloseTo(70.5)
    expect(slotRect(3).y).toBeCloseTo(40.5)
    expect(slotRect(21)).toEqual(slotRect(0))
  })

  it('counts and paginates', () => {
    expect(pageCount(0)).toBe(0)
    expect(pageCount(1)).toBe(1)
    expect(pageCount(21)).toBe(1)
    expect(pageCount(22)).toBe(2)
    const pages = paginate(23)
    expect(pages.map((p) => p.length)).toEqual([21, 2])
    expect(pages[1]).toEqual([21, 22])
    expect(paginate(0)).toEqual([])
  })

  it('emits print CSS with A4, zero margin and stretched images', () => {
    const css = printCss()
    expect(css).toContain('@page { size: A4; margin: 0mm }')
    expect(css).toContain('@media print {')
    expect(css).toContain('repeat(3, 70mm)')
    expect(css).toContain('object-fit: fill')
  })
})

describe('canvas safety', () => {
  it('keeps small images at scale 1 and shrinks oversized ones under the limit', () => {
    expect(canvasScale(4096, 4096)).toBe(1)
    const s = canvasScale(8000, 6000)
    expect(s).toBeLessThan(1)
    expect(Math.floor(8000 * s) * Math.floor(6000 * s)).toBeLessThanOrEqual(MAX_CANVAS_PIXELS)
  })

  it('resets the canvas size on release', () => {
    const c = { width: 10, height: 5 } as HTMLCanvasElement
    releaseCanvas(c)
    expect([c.width, c.height]).toEqual([0, 0])
  })
})

function mockCtx() {
  return {
    drawImage: vi.fn(),
    fillText: vi.fn(),
    strokeText: vi.fn(),
    fillRect: vi.fn(),
    measureText: vi.fn(() => ({ width: 40 })),
    scale: vi.fn(),
    font: '',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    textAlign: '',
    textBaseline: '',
    lineJoin: '',
  }
}
const asCtx = (m: ReturnType<typeof mockCtx>) => m as unknown as CanvasRenderingContext2D

describe('drawTicket', () => {
  const size = { w: 700, h: 400 }
  const img = {} as CanvasImageSource

  it('draws the background then fill and stroke for each non-empty value', () => {
    const ctx = mockCtx()
    drawTicket(asCtx(ctx), img, size, all(), { number: '5', name: 'Azam', phone: '' })
    expect(ctx.drawImage).toHaveBeenCalledWith(img, 0, 0, 700, 400)
    expect(ctx.fillText).toHaveBeenCalledTimes(2)
    expect(ctx.strokeText).toHaveBeenCalledTimes(2)
    expect(ctx.fillText).toHaveBeenCalledWith('5', 100, 10)
    expect(ctx.textAlign).toBe('center')
    expect(ctx.lineWidth).toBe(4)
  })

  it('skips the stroke when stroke is 0 and draws an underline when asked', () => {
    const ctx = mockCtx()
    drawTicket(asCtx(ctx), img, size, all({ stroke: 0, underline: true }), {
      number: '1',
      name: '',
      phone: '',
    })
    expect(ctx.strokeText).not.toHaveBeenCalled()
    expect(ctx.fillRect).toHaveBeenCalledWith(80, 10 + 30 * 0.55, 40, 30 / 14)
  })

  it('builds the font from bold, italic, size and family', () => {
    expect(fontSpec(ph({ bold: true, italic: true, size: 12, font: 'Open Sans' }))).toBe(
      'italic 700 12px "Open Sans", sans-serif',
    )
    expect(fontSpec(ph({ bold: false }))).toBe('400 30px "Montserrat", sans-serif')
  })
})

describe('renderTicket', () => {
  it('sizes the canvas to the image and scales the context when over the limit', () => {
    const ctx = mockCtx()
    const canvas = { width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement
    const image = {
      naturalWidth: 8000,
      naturalHeight: 6000,
      width: 8000,
      height: 6000,
    } as unknown as TicketImage
    const scale = renderTicket(canvas, image, all(), { number: '1', name: '', phone: '' })
    expect(scale).toBeLessThan(1)
    expect(canvas.width * canvas.height).toBeLessThanOrEqual(MAX_CANVAS_PIXELS)
    expect(ctx.scale).toHaveBeenCalled()
    // Coordinates stay in image pixels.
    expect(ctx.fillText).toHaveBeenCalledWith('1', 100, 10)
  })

  it('does not scale a normal image', () => {
    const ctx = mockCtx()
    const canvas = { width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement
    renderTicket(
      canvas,
      { naturalWidth: 700, naturalHeight: 400, width: 700, height: 400 } as unknown as TicketImage,
      all(),
      {
        number: '',
        name: '',
        phone: '',
      },
    )
    expect([canvas.width, canvas.height]).toEqual([700, 400])
    expect(ctx.scale).not.toHaveBeenCalled()
  })
})

describe('loadFonts', () => {
  it('loads each distinct face before rendering', async () => {
    const load = vi.fn(() => Promise.resolve([]))
    Object.defineProperty(document, 'fonts', { value: { load }, configurable: true })
    await loadFonts({ number: ph(), name: ph(), phone: ph({ font: 'Roboto', bold: false }) })
    expect(load).toHaveBeenCalledTimes(2)
    expect(load.mock.calls.map((c) => (c as unknown[])[0])).toContain('400 30px "Roboto", sans-serif')
  })
})
