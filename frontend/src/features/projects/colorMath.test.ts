import { describe, expect, it } from 'vitest'
import { hexToHsv, hsvToHex } from './colorMath'

describe('colour math', () => {
  it('converts the primaries and greys', () => {
    expect(hexToHsv('#FF0000')).toEqual({ h: 0, s: 1, v: 1 })
    expect(hexToHsv('#00FF00').h).toBe(120)
    expect(hexToHsv('#0000FF').h).toBe(240)
    expect(hexToHsv('#FFFFFF')).toEqual({ h: 0, s: 0, v: 1 })
    expect(hexToHsv('nonsense')).toEqual({ h: 0, s: 0, v: 0 })
    expect(hsvToHex({ h: 120, s: 1, v: 1 })).toBe('#00FF00')
    expect(hsvToHex({ h: 0, s: 0, v: 0 })).toBe('#000000')
  })

  it('round-trips arbitrary colours', () => {
    for (const hex of ['#1F5FE0', '#B23C06', '#7F8596', '#FFD400', '#123456']) {
      expect(hsvToHex(hexToHsv(hex))).toBe(hex)
    }
  })

  it('wraps and clamps out-of-range input', () => {
    expect(hsvToHex({ h: 360, s: 2, v: 2 })).toBe('#FF0000')
    expect(hsvToHex({ h: -120, s: 1, v: 1 })).toBe('#0000FF')
  })
})
