import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FONT_CATALOG } from './catalog.gen'
import { customFontId, customFontRef, ensureCustomFont, setFontSource } from './fonts'
import { fontSpec, loadFonts } from './render'
import { TICKET_FONTS, type TicketPlaceholder, type TicketPlaceholders } from './types'

const ID = '0198f2f0-7a3c-7c1e-9b57-2f4d5a6b7c8d'
const base: TicketPlaceholder = {
  font: 'Montserrat',
  size: 40,
  stroke: 0,
  color: '#fff',
  strokeColor: '#000',
  bold: false,
  italic: false,
  underline: false,
  x: 10,
  y: 10,
}
const all = (font: string): TicketPlaceholders => ({
  number: { ...base, font },
  name: { ...base, font },
  phone: { ...base, font },
})

describe('custom font references', () => {
  it('round-trips an id and rejects malformed values', () => {
    expect(customFontId(customFontRef(ID))).toBe(ID)
    for (const bad of ['Inter', 'custom:', 'custom:nope', `Custom:${ID}`, ID])
      expect(customFontId(bad)).toBeNull()
  })

  it('quotes the reference as a canvas font family', () => {
    expect(fontSpec({ ...base, font: customFontRef(ID), bold: true, italic: true })).toBe(
      `italic 700 40px "custom:${ID}", sans-serif`,
    )
  })
})

describe('font catalogue', () => {
  it('lists unique families with a category', () => {
    expect(new Set(TICKET_FONTS).size).toBe(TICKET_FONTS.length)
    expect(TICKET_FONTS.length).toBeGreaterThanOrEqual(30)
    expect(TICKET_FONTS).toContain('Montserrat')
    expect(FONT_CATALOG.every((f) => f.category.length > 0)).toBe(true)
  })
})

describe('uploaded fonts on the canvas', () => {
  const added: unknown[] = []
  const load = vi.fn(async () => undefined)
  let fetched: string[]

  beforeEach(() => {
    added.length = 0
    fetched = []
    load.mockClear()
    class FakeFace {
      constructor(
        readonly family: string,
        readonly data: ArrayBuffer,
      ) {}
      load = load
    }
    vi.stubGlobal('FontFace', FakeFace)
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { add: (f: unknown) => added.push(f), load: vi.fn(async () => []) },
    })
    setFontSource(async (id) => {
      fetched.push(id)
      return new ArrayBuffer(8)
    })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    setFontSource(null)
  })

  it('registers a font once, however often it is requested', async () => {
    await Promise.all([ensureCustomFont(customFontRef(ID)), ensureCustomFont(customFontRef(ID))])
    await ensureCustomFont(customFontRef(ID))
    expect(fetched).toEqual([ID])
    expect(added).toHaveLength(1)
    expect((added[0] as { family: string }).family).toBe(`custom:${ID}`)
  })

  it('ignores built-in fonts and retries after a failure', async () => {
    await ensureCustomFont('Montserrat')
    expect(fetched).toEqual([])

    let calls = 0
    setFontSource(async () => {
      calls += 1
      if (calls === 1) throw new Error('offline')
      return new ArrayBuffer(8)
    })
    await ensureCustomFont(customFontRef(ID))
    expect(added).toHaveLength(0)
    await ensureCustomFont(customFontRef(ID))
    expect(added).toHaveLength(1)
  })

  it('loadFonts waits for the uploaded face before drawing', async () => {
    await loadFonts(all(customFontRef(ID)))
    expect(added).toHaveLength(1)
    expect(document.fonts.load).toHaveBeenCalledWith(
      expect.stringContaining(`"custom:${ID}"`),
      expect.any(String),
    )
  })
})
