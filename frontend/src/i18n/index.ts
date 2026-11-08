import { useMemo, useSyncExternalStore } from 'react'
import { flushSync } from 'react-dom'
import { readStorage, writeStorage } from '../lib/storage'
import { withViewTransition } from '../lib/viewTransition'
import { type MessageKey, ru } from './ru'
import type { Locale, Message } from './types'

export type { Locale, MessageKey }
export const LOCALES: readonly Locale[] = ['ru', 'uz']
export const LOCALE_KEY = 'tip.locale'
export const INTL_TAG: Record<Locale, string> = { ru: 'ru-RU', uz: 'uz-Latn-UZ' }

export type Params = Record<string, string | number>
type Dictionary = Record<string, Message>

const numberFormats = new Map<Locale, Intl.NumberFormat>()
const pluralRules = new Map<Locale, Intl.PluralRules>()

/**
 * Uzbek (Latin) numbers use a no-break space for grouping and a decimal comma, exactly like Russian,
 * but browsers that ship without Uzbek ICU data fall back to the English "5,000" / "1.5". The ru-RU
 * rules give the CLDR uz result everywhere, and grouping is forced on so "5 000" has its space.
 */
function numberOptions(locale: Locale, opts?: Intl.NumberFormatOptions): [string, Intl.NumberFormatOptions] {
  if (locale === 'uz') return ['ru-RU', { useGrouping: 'always', ...opts } as Intl.NumberFormatOptions]
  return [INTL_TAG[locale], opts ?? {}]
}

function numberFormat(locale: Locale): Intl.NumberFormat {
  const cached = numberFormats.get(locale)
  if (cached) return cached
  const [tag, opts] = numberOptions(locale)
  const created = new Intl.NumberFormat(tag, opts)
  numberFormats.set(locale, created)
  return created
}

function pluralRule(locale: Locale): Intl.PluralRules {
  const cached = pluralRules.get(locale)
  if (cached) return cached
  const created = new Intl.PluralRules(INTL_TAG[locale])
  pluralRules.set(locale, created)
  return created
}

/** Picks the plural form (when the message has forms) and substitutes {placeholders}. Pure, for tests and `t`. */
export function formatMessage(message: Message, locale: Locale, params: Params = {}): string {
  let text: string
  if (typeof message === 'string') {
    text = message
  } else {
    const category = pluralRule(locale).select(Number(params.count ?? 0))
    text = message[category] ?? message.other
  }
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const v = params[name]
    if (v === undefined) return whole
    return typeof v === 'number' ? numberFormat(locale).format(v) : v
  })
}

/** Stored choice first, then the browser language, then Russian. */
export function detectLocale(): Locale {
  const stored = readStorage(LOCALE_KEY)
  if (stored === 'ru' || stored === 'uz') return stored
  const langs = typeof navigator === 'undefined' ? [] : (navigator.languages ?? [navigator.language])
  for (const l of langs) {
    const base = l.toLowerCase().split('-')[0]
    if (base === 'ru' || base === 'uz') return base
  }
  return 'ru'
}

let locale: Locale = 'ru'
let dictionary: Dictionary = ru
const listeners = new Set<() => void>()

async function loadDictionary(l: Locale): Promise<Dictionary> {
  if (l === 'uz') return (await import('./uz')).uz
  return ru
}

function commit(l: Locale, dict: Dictionary): void {
  locale = l
  dictionary = dict
  document.documentElement.lang = l
  for (const cb of listeners) cb()
}

export function getLocale(): Locale {
  return locale
}

/** Loads the initial dictionary before first render so there is no flash of the wrong language. */
export async function initI18n(): Promise<void> {
  const l = detectLocale()
  commit(l, await loadDictionary(l))
}

/** Switches language without a page reload; text cross-fades where View Transitions are available. */
export async function setLocale(l: Locale): Promise<void> {
  const dict = await loadDictionary(l)
  writeStorage(LOCALE_KEY, l)
  withViewTransition(() => flushSync(() => commit(l, dict)))
}

export function t(key: MessageKey, params?: Params): string {
  return formatMessage(dictionary[key] ?? ru[key] ?? key, locale, params)
}

export function formatNumber(value: number, opts?: Intl.NumberFormatOptions): string {
  if (!opts) return numberFormat(locale).format(value)
  const [tag, merged] = numberOptions(locale, opts)
  return new Intl.NumberFormat(tag, merged).format(value)
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

/** Splits a byte count into a value (1 decimal at most) and a unit code for the `admin.unit.*` keys. */
export function splitBytes(bytes: number): { value: number; unit: (typeof BYTE_UNITS)[number] } {
  let value = Math.max(0, bytes)
  let i = 0
  while (value >= 1024 && i < BYTE_UNITS.length - 1) {
    value /= 1024
    i++
  }
  return { value: Math.round(value * 10) / 10, unit: BYTE_UNITS[i] as (typeof BYTE_UNITS)[number] }
}

/** "1 006,9 ГБ" / "1 006,9 GB": number in the current locale, unit from the dictionary. */
export function formatBytes(bytes: number): string {
  const { value, unit } = splitBytes(bytes)
  return `${formatNumber(value)} ${t(`admin.unit.${unit}` as MessageKey)}`
}

export function formatDate(
  value: Date | number,
  opts: Intl.DateTimeFormatOptions = { dateStyle: 'medium' },
): string {
  if (locale === 'uz') return new Intl.DateTimeFormat('ru-RU', numericDate(opts)).format(value)
  return new Intl.DateTimeFormat(INTL_TAG[locale], opts).format(value)
}

// ICU renders uz dates like "2026 M11 8"; Uzbek users read dd.mm.yyyy, which the ru-RU tag produces.
function numericDate(opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormatOptions {
  const { dateStyle, timeStyle, ...rest } = opts
  if (!dateStyle && !timeStyle) return opts
  return {
    ...rest,
    ...(dateStyle && { day: '2-digit', month: '2-digit', year: 'numeric' }),
    ...(timeStyle && {
      hour: '2-digit',
      minute: '2-digit',
      ...(timeStyle !== 'short' && { second: '2-digit' }),
    }),
  }
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function useI18n() {
  const current = useSyncExternalStore(subscribe, getLocale, getLocale)
  // The bound functions read module state, which already matches `current` when this runs.
  return useMemo(() => ({ locale: current, t, setLocale, formatNumber, formatDate, formatBytes }), [current])
}
