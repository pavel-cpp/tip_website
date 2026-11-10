import { customFontRef, FONT_CATALOG, type FontCategory } from '../../lib/ticket'
import type { CustomFont } from './fontsApi'

export type FontFilter = 'all' | FontCategory | 'custom'

export const FONT_FILTERS: readonly FontFilter[] = [
  'all',
  'sans',
  'serif',
  'display',
  'script',
  'mono',
  'custom',
]

export interface PickerFont {
  /** The value stored in the placeholder (family name, or custom:<id>). */
  value: string
  label: string
  category: FontCategory | 'custom'
  custom: CustomFont | null
}

/** Bundled families first (catalogue order), then the uploaded fonts. */
export function pickerFonts(custom: readonly CustomFont[] | undefined): PickerFont[] {
  return [
    ...FONT_CATALOG.map((f) => ({ value: f.family, label: f.family, category: f.category, custom: null })),
    ...(custom ?? []).map((f) => ({
      value: customFontRef(f.id),
      label: f.name,
      category: 'custom' as const,
      custom: f,
    })),
  ]
}

/** Case-insensitive substring search over the label, narrowed by the category filter. */
export function filterFonts(fonts: readonly PickerFont[], query: string, filter: FontFilter): PickerFont[] {
  const q = query.trim().toLowerCase()
  return fonts.filter(
    (f) => (filter === 'all' || f.category === filter) && (q === '' || f.label.toLowerCase().includes(q)),
  )
}

/** CSS font-family for previewing a picker entry in its own face. */
export function previewFamily(value: string): string {
  return `"${value}", sans-serif`
}
