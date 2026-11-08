import type { MessageKey, Params } from '../../i18n'

/** Above this many tickets the user confirms before the batch is rendered. */
export const BIG_PRINT_THRESHOLD = 500
/** Rough render time of one ticket on a modest office PC; only used before real timings exist. */
export const PRINT_MS_PER_TICKET = 40
/** Remaining time is not shown until this many tickets are done (the first ones are not representative). */
const MIN_SAMPLE = 8

export function estimateMs(count: number): number {
  return Math.max(0, count) * PRINT_MS_PER_TICKET
}

/** Time left, from the pace so far; null while there is too little data to say anything honest. */
export function remainingMs(done: number, total: number, elapsedMs: number): number | null {
  if (done < MIN_SAMPLE || elapsedMs <= 0 || done >= total) return null
  return ((total - done) * elapsedMs) / done
}

/** Whole seconds, rounded up to a step that keeps the text calm: 5 s below a minute, 10 s below ten, then 30 s. */
export function roundedSeconds(ms: number): number {
  const s = Math.max(1, Math.ceil(ms / 1000))
  const step = s < 60 ? 5 : s < 600 ? 10 : 30
  return Math.ceil(s / step) * step
}

type Translate = (key: MessageKey, params?: Params) => string

/** "45 s", "3 min", "3 min 20 s" in the active language. */
export function formatDuration(ms: number, t: Translate): string {
  const total = roundedSeconds(ms)
  const m = Math.floor(total / 60)
  const s = total % 60
  if (m === 0) return t('workspace.duration.sec', { s })
  if (s === 0) return t('workspace.duration.min', { m })
  return t('workspace.duration.minSec', { m, s })
}
