import { useSyncExternalStore } from 'react'

/** Below this width the participants are shown as cards and edited in a bottom sheet. */
export const NARROW_QUERY = '(max-width: 699px), (orientation: landscape) and (max-height: 500px)'

/** Panels are stacked instead of side by side (keep in sync with the stacked rule in workspace.css). */
export const STACKED_QUERY = '(max-width: 1099px) and (not ((min-width: 860px) and (orientation: landscape)))'

export function useStacked(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia(STACKED_QUERY)
      mq.addEventListener('change', cb)
      return () => mq.removeEventListener('change', cb)
    },
    () => window.matchMedia(STACKED_QUERY).matches,
    () => false,
  )
}

export function useNarrow(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia(NARROW_QUERY)
      mq.addEventListener('change', cb)
      return () => mq.removeEventListener('change', cb)
    },
    () => window.matchMedia(NARROW_QUERY).matches,
    () => false,
  )
}
