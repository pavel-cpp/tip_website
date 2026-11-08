import { beforeEach, describe, expect, it } from 'vitest'
import { detectLocale, formatMessage, getLocale, initI18n, LOCALE_KEY, setLocale, t } from './index'
import { ru } from './ru'
import type { Message } from './types'
import { uz } from './uz'

const ruDict = ru as Record<string, Message>
const uzDict = uz as Record<string, Message>

const placeholders = (m: Message): string[] =>
  [...(typeof m === 'string' ? [m] : Object.values(m)).join(' ').matchAll(/\{(\w+)\}/g)].map(
    (x) => x[1] as string,
  )

describe('dictionary parity', () => {
  it('has no key in ru that is missing in uz', () => {
    expect(Object.keys(ruDict).filter((k) => !(k in uzDict))).toEqual([])
  })

  it('has no key in uz that is missing in ru', () => {
    expect(Object.keys(uzDict).filter((k) => !(k in ruDict))).toEqual([])
  })

  it('uses the same shape (plain or plural) and the same placeholders per key', () => {
    for (const key of Object.keys(ruDict)) {
      const a = ruDict[key] as Message
      const b = uzDict[key] as Message
      expect(typeof b, key).toBe(typeof a)
      expect(new Set(placeholders(b)), key).toEqual(new Set(placeholders(a)))
    }
  })

  it('provides every plural form its language needs', () => {
    for (const [key, m] of Object.entries(ruDict)) {
      if (typeof m === 'string') continue
      expect(Object.keys(m).sort(), `ru ${key}`).toEqual(['few', 'many', 'one', 'other'])
    }
    for (const [key, m] of Object.entries(uzDict)) {
      if (typeof m !== 'string') expect(Object.keys(m).sort(), `uz ${key}`).toEqual(['one', 'other'])
    }
  })

  it('has a non-empty ru and uz value for every key', () => {
    for (const dict of [ruDict, uzDict]) {
      for (const [key, m] of Object.entries(dict)) {
        expect((typeof m === 'string' ? m : m.other).trim().length, key).toBeGreaterThan(0)
      }
    }
  })

  it('writes Uzbek oʻ and gʻ with U+02BB, never with an ASCII or typographic apostrophe', () => {
    const bad = /[oOgG]['‘’`´ʼ]/
    for (const [key, m] of Object.entries(uzDict)) {
      const text = typeof m === 'string' ? m : Object.values(m).join(' ')
      expect(bad.test(text), key).toBe(false)
    }
    expect(JSON.stringify(uz)).toContain('ʻ')
  })

  it('has an error text for every API error code in both languages', () => {
    const codes = [
      'VALIDATION',
      'UNAUTHENTICATED',
      'AUTH_UNAVAILABLE',
      'TOKEN_EXPIRED',
      'TOKEN_STALE',
      'REFRESH_INVALID',
      'BAD_CREDENTIALS',
      'FORBIDDEN',
      'PASSWORD_CHANGE_REQUIRED',
      'NOT_FOUND',
      'ROW_LOCKED',
      'VERSION_CONFLICT',
      'PROJECT_FINISHED',
      'LAST_ADMIN',
      'ROLE_IN_USE',
      'ROLE_SYSTEM',
      'TOO_LARGE',
      'UNSUPPORTED_MEDIA',
      'IMAGE_INVALID',
      'RATE_LIMITED',
      'DISK_LOW',
      'INTERNAL',
      'NETWORK',
      'UNKNOWN',
    ]
    for (const c of codes) expect(`errors.${c}` in ruDict, c).toBe(true)
  })
})

describe('formatMessage', () => {
  it('interpolates strings and formats numbers per locale', () => {
    expect(formatMessage('Hi {name}', 'ru', { name: 'Azam' })).toBe('Hi Azam')
    expect(formatMessage('{n} rows', 'ru', { n: 1234567 })).toMatch(/^1\s234\s567 rows$/)
    expect(formatMessage('keep {missing}', 'ru')).toBe('keep {missing}')
  })

  it('selects Russian plural forms one/few/many', () => {
    const m = ru['toast.rowsDeleted']
    expect(formatMessage(m, 'ru', { count: 1 })).toBe('Удалена 1 запись')
    expect(formatMessage(m, 'ru', { count: 3 })).toBe('Удалено 3 записи')
    expect(formatMessage(m, 'ru', { count: 5 })).toBe('Удалено 5 записей')
    expect(formatMessage(m, 'ru', { count: 11 })).toBe('Удалено 11 записей')
    expect(formatMessage(m, 'ru', { count: 21 })).toBe('Удалена 21 запись')
  })

  it('selects Uzbek plural forms one/other', () => {
    const m = uz['toast.rowsDeleted']
    expect(formatMessage(m, 'uz', { count: 1 })).toBe('1 ta yozuv oʻchirildi')
    expect(formatMessage(m, 'uz', { count: 7 })).toBe('7 ta yozuv oʻchirildi')
  })
})

describe('locale detection and switching', () => {
  beforeEach(async () => {
    localStorage.clear()
    await setLocale('ru')
    localStorage.clear()
  })

  it('prefers the stored locale, then navigator.language, then ru', () => {
    expect(detectLocale()).toBe('ru')
    localStorage.setItem(LOCALE_KEY, 'uz')
    expect(detectLocale()).toBe('uz')
    localStorage.clear()
    Object.defineProperty(navigator, 'languages', { value: ['uz-UZ', 'en'], configurable: true })
    expect(detectLocale()).toBe('uz')
    Object.defineProperty(navigator, 'languages', { value: ['de-DE'], configurable: true })
    expect(detectLocale()).toBe('ru')
    Reflect.deleteProperty(navigator, 'languages')
  })

  it('switches language at runtime, persists it and updates <html lang>', async () => {
    expect(t('action.save')).toBe('Сохранить')
    await setLocale('uz')
    expect(getLocale()).toBe('uz')
    expect(t('action.save')).toBe('Saqlash')
    expect(localStorage.getItem(LOCALE_KEY)).toBe('uz')
    expect(document.documentElement.lang).toBe('uz')
    await setLocale('ru')
    expect(t('action.save')).toBe('Сохранить')
  })

  it('initI18n restores the persisted language', async () => {
    localStorage.setItem(LOCALE_KEY, 'uz')
    await initI18n()
    expect(t('action.cancel')).toBe('Bekor qilish')
  })
})

describe('Uzbek terminology', () => {
  const texts = Object.values(uzDict).flatMap((m) => (typeof m === 'string' ? [m] : Object.values(m)))

  it('uses one word for a ticket: chipta, never bilet', () => {
    expect(texts.filter((s) => /bilet/i.test(s))).toEqual([])
  })

  it('does not call project colleagues "ishtirokchilar" (that word means contest participants)', () => {
    expect(uzDict['workspace.people.contributors']).toBe('Loyiha hamkasblari')
    expect(texts.filter((s) => /loyiha ishtirokchi/i.test(s))).toEqual([])
  })
})
