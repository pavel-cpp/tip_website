import { PLACEHOLDER_KEYS, PLACEHOLDER_LIMITS, type TicketPlaceholder } from '../../lib/ticket'
import type { Project, UpdateProjectRequest } from './api'

export interface Draft {
  title: string
  placeholders: Project['placeholders']
}

export function toDraft(p: Pick<Project, 'title' | 'placeholders'>): Draft {
  return { title: p.title, placeholders: structuredClone(p.placeholders) }
}

const samePlaceholder = (a: TicketPlaceholder, b: TicketPlaceholder): boolean =>
  a.font === b.font &&
  a.size === b.size &&
  a.stroke === b.stroke &&
  a.color.toLowerCase() === b.color.toLowerCase() &&
  a.strokeColor.toLowerCase() === b.strokeColor.toLowerCase() &&
  a.bold === b.bold &&
  a.italic === b.italic &&
  a.underline === b.underline &&
  a.x === b.x &&
  a.y === b.y

export function changedKeys(draft: Draft, base: Pick<Project, 'placeholders'>) {
  return PLACEHOLDER_KEYS.filter((k) => !samePlaceholder(draft.placeholders[k], base.placeholders[k]))
}

export function isDirty(draft: Draft, base: Pick<Project, 'title' | 'placeholders'>): boolean {
  return draft.title !== base.title || changedKeys(draft, base).length > 0
}

/** PATCH body with only what changed, guarded by the project version (optimistic concurrency). */
export function buildPatch(
  draft: Draft,
  base: Pick<Project, 'title' | 'placeholders' | 'version'>,
): UpdateProjectRequest {
  const patch: UpdateProjectRequest = { version: base.version }
  if (draft.title !== base.title) patch.title = draft.title.trim()
  const keys = changedKeys(draft, base)
  if (keys.length > 0) {
    patch.placeholders = Object.fromEntries(keys.map((k) => [k, draft.placeholders[k]]))
  }
  return patch
}

export const isHexColor = (v: string): boolean => /^#[0-9a-fA-F]{6}$/.test(v)

export function clampInt(v: number, min: number, max: number): number {
  return Math.min(Math.max(Math.round(v), min), max)
}

/** Keeps a placeholder inside the limits the backend enforces (domain.Placeholder.Validate). */
export function normalizePlaceholder(
  p: TicketPlaceholder,
  image?: { w: number; h: number } | null,
): TicketPlaceholder {
  const { minSize, maxSize, minStroke, maxStroke } = PLACEHOLDER_LIMITS
  return {
    ...p,
    size: clampInt(p.size, minSize, maxSize),
    stroke: clampInt(p.stroke, minStroke, maxStroke),
    x: clampInt(p.x, 0, image?.w ?? Number.MAX_SAFE_INTEGER),
    y: clampInt(p.y, 0, image?.h ?? Number.MAX_SAFE_INTEGER),
  }
}

/** True when the image is noticeably not 7:4 (2% tolerance); the UI then shows a gentle hint. */
export function isOffRatio(w: number, h: number, target = 7 / 4, tolerance = 0.02): boolean {
  if (w <= 0 || h <= 0) return false
  return Math.abs(w / h / target - 1) > tolerance
}

export function formatBytes(bytes: number, locale: string): string {
  const mb = bytes / (1024 * 1024)
  const fmt = (n: number, unit: 'megabyte' | 'kilobyte') =>
    new Intl.NumberFormat(locale, {
      style: 'unit',
      unit,
      unitDisplay: 'short',
      maximumFractionDigits: 1,
    }).format(n)
  return mb >= 1 ? fmt(mb, 'megabyte') : fmt(bytes / 1024, 'kilobyte')
}
