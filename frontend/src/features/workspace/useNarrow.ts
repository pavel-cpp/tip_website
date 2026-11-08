import { useSyncExternalStore } from 'react'

/** Below this width the participants are shown as cards and edited in a bottom sheet. */
export const NARROW_QUERY = '(max-width: 699px), (orientation: landscape) and (max-height: 500px)'

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
