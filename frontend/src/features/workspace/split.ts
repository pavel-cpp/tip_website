import { readStorage, writeStorage } from '../../lib/storage'

/** Share of the space the first panel (the ticket picture) takes while both panels are visible. */
export const MIN_RATIO = 0.2
export const MAX_RATIO = 0.8
export const DEFAULT_RATIO = 0.5
const KEY_STEP = 0.03
const KEY_STEP_BIG = 0.1

/** Which panel is hidden; the other one fills the space and the handle stays on the edge. */
export type Collapsed = 'first' | 'second' | null

export interface SplitState {
  ratio: number
  collapsed: Collapsed
}

export const DEFAULT_SPLIT: SplitState = { ratio: DEFAULT_RATIO, collapsed: null }

export const clampRatio = (r: number): number =>
  Number.isFinite(r) ? Math.min(MAX_RATIO, Math.max(MIN_RATIO, r)) : DEFAULT_RATIO

/** Dragging the handle closer than this to an edge hides that panel; pulling it back out shows it again. */
export const COLLAPSE_AT = 0.1
/** A hidden panel comes back only past this, so the edge does not flicker under a shaky hand. */
const REOPEN_AT = COLLAPSE_AT + 0.04

/** Pointer position along the container -> unclamped ratio of the first panel, handle width excluded. */
export function ratioFromPointer(pos: number, start: number, size: number, handle: number): number {
  const room = size - handle
  if (room <= 0) return DEFAULT_RATIO
  return (pos - start - handle / 2) / room
}

/**
 * State after the handle was dragged to `raw`. The visible ratio is remembered while a panel is hidden,
 * so keyboard restore (and the next drag out) returns to a sensible size.
 */
export function dragState(raw: number, prev: SplitState): SplitState {
  if (!Number.isFinite(raw)) return prev
  const hideFirst = prev.collapsed === 'first' ? REOPEN_AT : COLLAPSE_AT
  const hideSecond = prev.collapsed === 'second' ? 1 - REOPEN_AT : 1 - COLLAPSE_AT
  if (raw < hideFirst) return { ratio: prev.ratio, collapsed: 'first' }
  if (raw > hideSecond) return { ratio: prev.ratio, collapsed: 'second' }
  return { ratio: clampRatio(raw), collapsed: null }
}

/**
 * Arrow keys: `dir` -1 moves the handle towards the first panel, +1 towards the second. Pushing past the
 * limit hides the panel, and a step away from a hidden panel shows it again.
 */
export function nudgeState(s: SplitState, dir: -1 | 1, big = false): SplitState {
  if (s.collapsed) return (dir === 1) === (s.collapsed === 'first') ? { ratio: s.ratio, collapsed: null } : s
  const raw = s.ratio + dir * (big ? KEY_STEP_BIG : KEY_STEP)
  if (raw < MIN_RATIO && s.ratio <= MIN_RATIO) return { ratio: s.ratio, collapsed: 'first' }
  if (raw > MAX_RATIO && s.ratio >= MAX_RATIO) return { ratio: s.ratio, collapsed: 'second' }
  return { ratio: clampRatio(raw), collapsed: null }
}

/** Grid track list; the hidden panel collapses to 0fr so the size change can animate. */
export function tracks({ ratio, collapsed }: SplitState, handlePx: number): string {
  const [a, b] = collapsed === 'first' ? [0, 1] : collapsed === 'second' ? [1, 0] : [ratio, 1 - ratio]
  return `${a}fr ${handlePx}px ${b}fr`
}

const key = (userId: string) => `tip.workspace.split.${userId}`

export function parseSplit(raw: string | null): SplitState {
  if (!raw) return DEFAULT_SPLIT
  try {
    const v = JSON.parse(raw) as Partial<SplitState>
    const collapsed = v.collapsed === 'first' || v.collapsed === 'second' ? v.collapsed : null
    return { ratio: clampRatio(typeof v.ratio === 'number' ? v.ratio : DEFAULT_RATIO), collapsed }
  } catch {
    return DEFAULT_SPLIT
  }
}

export const loadSplit = (userId: string): SplitState => parseSplit(readStorage(key(userId)))
export const saveSplit = (userId: string, s: SplitState): void => writeStorage(key(userId), JSON.stringify(s))
