import { readStorage, writeStorage } from '../../lib/storage'

/** Share of the space the first panel (the ticket picture) takes while both panels are visible. */
export const MIN_RATIO = 0.2
export const MAX_RATIO = 0.8
export const DEFAULT_RATIO = 0.5
const KEY_STEP = 0.03
const KEY_STEP_BIG = 0.1

/** Which panel is hidden; the other one fills the space and the handle stays on the edge. */
export type Collapsed = 'first' | 'second' | null
export type Side = 'first' | 'second'

export interface SplitState {
  ratio: number
  collapsed: Collapsed
}

export const DEFAULT_SPLIT: SplitState = { ratio: DEFAULT_RATIO, collapsed: null }

export const clampRatio = (r: number): number =>
  Number.isFinite(r) ? Math.min(MAX_RATIO, Math.max(MIN_RATIO, r)) : DEFAULT_RATIO

/** Pointer position along the container -> ratio of the first panel, with the handle's own width excluded. */
export function ratioFromPointer(pos: number, start: number, size: number, handle: number): number {
  const room = size - handle
  if (room <= 0) return DEFAULT_RATIO
  return clampRatio((pos - start - handle / 2) / room)
}

/** Arrow keys: `dir` -1 moves the handle towards the first panel, +1 towards the second. */
export function nudgeRatio(ratio: number, dir: -1 | 1, big = false): number {
  return clampRatio(ratio + dir * (big ? KEY_STEP_BIG : KEY_STEP))
}

/**
 * What an arrow on the handle does. The arrow pointing at a panel hides it; once the other panel is
 * hidden, the same arrow brings that one back. Nothing to do for the arrow pointing at a hidden panel.
 */
export function arrowAction(collapsed: Collapsed, side: Side): 'hide' | 'show' | null {
  if (collapsed === null) return 'hide'
  return collapsed === side ? null : 'show'
}

export function applyArrow(collapsed: Collapsed, side: Side): Collapsed {
  const act = arrowAction(collapsed, side)
  if (act === 'hide') return side
  if (act === 'show') return null
  return collapsed
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
