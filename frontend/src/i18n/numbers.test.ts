import { beforeEach, describe, expect, it } from 'vitest'
import { formatBytes, formatMessage, formatNumber, setLocale, splitBytes } from './index'

const NBSP = ' '

describe('number formatting', () => {
  beforeEach(async () => {
    await setLocale('ru')
  })

  it('groups with a space and uses a decimal comma in Uzbek, never the English style', async () => {
    await setLocale('uz')
    expect(formatNumber(5000)).toBe(`5${NBSP}000`)
    expect(formatNumber(1006.9)).toBe(`1${NBSP}006,9`)
    expect(formatMessage('{count} ta', 'uz', { count: 12345 })).toBe(`12${NBSP}345 ta`)
  })

  it('formats Russian the same way', () => {
    expect(formatNumber(1006.9)).toBe(`1${NBSP}006,9`)
    expect(formatMessage('{count}', 'ru', { count: 20000 })).toBe(`20${NBSP}000`)
  })

  it('keeps caller options in both locales', async () => {
    expect(formatNumber(0.256, { style: 'percent' })).toMatch(/^26\s?%$/)
    await setLocale('uz')
    expect(formatNumber(1234.5678, { maximumFractionDigits: 1 })).toBe(`1${NBSP}234,6`)
  })

  it('formats byte sizes with a localized unit', async () => {
    expect(splitBytes(1024 * 1024 * 1.5)).toEqual({ value: 1.5, unit: 'MB' })
    const size = 1006.9 * 1024 ** 3
    expect(formatBytes(size)).toBe(`1${NBSP}006,9 ГБ`)
    await setLocale('uz')
    expect(formatBytes(size)).toBe(`1${NBSP}006,9 GB`)
  })
})
