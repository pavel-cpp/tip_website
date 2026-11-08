import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { TicketPlaceholder } from '../../lib/ticket'
import { chipAnchor } from './PlaceholderPreview'

const ph = (x: number, y: number, size = 40): TicketPlaceholder => ({
  font: 'Montserrat',
  size,
  stroke: 0,
  color: '#fff',
  strokeColor: '#000',
  bold: false,
  italic: false,
  underline: false,
  x,
  y,
})

beforeEach(() => {
  // Every glyph is 10 image px wide, so "Name" is 40 px.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    measureText: (s: string) => ({ width: s.length * 10 }),
  } as unknown as CanvasRenderingContext2D)
})
afterEach(() => vi.restoreAllMocks())

it('puts the handle to the left of the text, level with it', () => {
  // The text spans x 480..520 at scale 1, so the handle's right edge is a gap before 480.
  const a = chipAnchor(ph(500, 200), 'Name', 1)
  expect(a.y).toBe(200)
  expect(a.x).toBeLessThan(480)
})

it('never lands on the glyphs of a long name on a narrow screen', () => {
  // A long name spreads over almost the whole stage; the handle must not sit inside the text box.
  const text = 'Abdurahmonova-Khayrullaeva Mukhabbat'
  const a = chipAnchor(ph(150, 120, 20), text, 0.3)
  const textLeft = (150 - (text.length * 10) / 2) * 0.3
  expect(a.x <= textLeft || a.y < 120 - (20 * 0.3) / 2).toBe(true)
})

it('moves above the first glyph when there is no room on the left', () => {
  const a = chipAnchor(ph(30, 200, 40), 'Name', 1)
  expect(a.y).toBeLessThan(200 - 20)
  expect(a.x).toBeGreaterThan(0)
})
