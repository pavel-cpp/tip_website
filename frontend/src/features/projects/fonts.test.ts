import { describe, expect, it } from 'vitest'
import { keyDelta, snapPosition } from './drag'
import { filterFonts, pickerFonts } from './fontCatalog'
import { FONT_LIMITS, fontFileProblem, fontNameFromFile } from './fontsApi'
import { dragHasFiles, imageFileProblem, MAX_IMAGE_BYTES } from './imageFile'

const custom = {
  id: '0198f2f0-7a3c-7c1e-9b57-2f4d5a6b7c8d',
  name: 'Brand Sans',
  format: 'woff2' as const,
  bytes: 100,
  url: '/x',
  createdAt: '2026-01-01T00:00:00Z',
}

describe('font picker data', () => {
  const fonts = pickerFonts([custom])

  it('lists bundled families first and uploaded ones with a custom reference', () => {
    expect(fonts[0]?.value).toBe('Montserrat')
    const last = fonts.at(-1)
    expect(last).toMatchObject({ value: `custom:${custom.id}`, label: 'Brand Sans', category: 'custom' })
  })

  it('searches case-insensitively and by category', () => {
    expect(filterFonts(fonts, 'MONTS', 'all').map((f) => f.label)).toEqual(['Montserrat'])
    expect(filterFonts(fonts, '', 'custom').map((f) => f.label)).toEqual(['Brand Sans'])
    expect(filterFonts(fonts, '', 'mono').every((f) => f.category === 'mono')).toBe(true)
    expect(filterFonts(fonts, 'zzzz', 'all')).toEqual([])
  })
})

describe('font upload validation', () => {
  it('accepts ttf, otf and woff2 within the size limit', () => {
    for (const name of ['a.ttf', 'a.OTF', 'a.woff2']) expect(fontFileProblem({ name, size: 10 })).toBeNull()
  })
  it('refuses other types and oversized files', () => {
    expect(fontFileProblem({ name: 'a.woff', size: 10 })).toBe('type')
    expect(fontFileProblem({ name: 'a.png', size: 10 })).toBe('type')
    expect(fontFileProblem({ name: 'a.ttf', size: FONT_LIMITS.maxBytes + 1 })).toBe('size')
  })
  it('derives a readable default name', () => {
    expect(fontNameFromFile('Brand_Sans-Bold.ttf')).toBe('Brand Sans Bold')
    expect(fontNameFromFile('x'.repeat(100) + '.otf')).toHaveLength(FONT_LIMITS.maxNameLength)
  })
})

describe('picture validation', () => {
  it('accepts PNG and JPEG up to the limit', () => {
    expect(imageFileProblem({ type: 'image/png', size: 1 })).toBeNull()
    expect(imageFileProblem({ type: 'image/jpeg', size: MAX_IMAGE_BYTES })).toBeNull()
  })
  it('explains type and size problems', () => {
    expect(imageFileProblem({ type: 'image/gif', size: 1 })).toBe('type')
    expect(imageFileProblem({ type: 'application/pdf', size: 1 })).toBe('type')
    expect(imageFileProblem({ type: 'image/png', size: MAX_IMAGE_BYTES + 1 })).toBe('size')
  })
  it('recognises file drags only', () => {
    expect(dragHasFiles({ types: ['Files'] })).toBe(true)
    expect(dragHasFiles({ types: ['text/plain'] })).toBe(false)
    expect(dragHasFiles(null)).toBe(false)
  })
})

describe('snapping to other fields', () => {
  const image = { w: 1000, h: 500 }
  it('aligns with the centre line of another field within the threshold', () => {
    const r = snapPosition({ x: 303, y: 120 }, image, 8, { xs: [300], ys: [400] })
    expect(r.point).toEqual({ x: 300, y: 120 })
    expect(r.guides).toEqual({ x: 300, y: null })
  })
  it('keeps the raw value outside the threshold and still snaps to the page centre', () => {
    const r = snapPosition({ x: 480, y: 251 }, image, 8, { xs: [300] })
    expect(r.point).toEqual({ x: 480, y: 250 })
    expect(r.guides).toEqual({ x: null, y: 250 })
  })
  it('nudges by one pixel, ten with Shift', () => {
    expect(keyDelta('ArrowLeft', false)).toEqual({ x: -1, y: 0 })
    expect(keyDelta('ArrowDown', true)).toEqual({ x: 0, y: 10 })
  })
})
