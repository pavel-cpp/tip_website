import { onTokenRefreshed } from './events'
import { refreshAccessToken } from './refresh'

/** The access token is renewed this long before it expires (docs/06-frontend.md, pitfall 1). */
export const REFRESH_LEAD_MS = 60_000
const MIN_DELAY_MS = 5_000
const RETRY_MS = 15_000

let timer: ReturnType<typeof setTimeout> | undefined
let expiresAt = 0
let active = false

function clearTimer(): void {
  if (timer !== undefined) clearTimeout(timer)
  timer = undefined
}

function fire(): void {
  timer = undefined
  // The 401 path (closed chain) already clears the token and emits logout inside refreshAccessToken;
  // any other failure is transient, so try again until the token really expires.
  refreshAccessToken().catch(() => {
    if (active && Date.now() < expiresAt) timer = setTimeout(fire, RETRY_MS)
  })
}

/** Plans the next renewal from the lifetime (seconds) reported by login, refresh or password change. */
export function scheduleRefresh(expiresInSeconds: number): void {
  clearTimer()
  active = true
  const lifetime = expiresInSeconds * 1000
  expiresAt = Date.now() + lifetime
  timer = setTimeout(fire, Math.max(MIN_DELAY_MS, lifetime - REFRESH_LEAD_MS))
}

/** Stops renewing; called on logout and when the session is lost. */
export function cancelRefresh(): void {
  active = false
  clearTimer()
}

/**
 * Re-plans after every rotation (including 401-triggered ones) and catches up after the tab was asleep:
 * timers are throttled or frozen in background tabs and on suspended laptops.
 */
export function watchRefresh(): () => void {
  const offRefreshed = onTokenRefreshed(scheduleRefresh)
  const onVisible = () => {
    if (document.visibilityState !== 'visible' || !active) return
    if (Date.now() >= expiresAt - REFRESH_LEAD_MS) {
      clearTimer()
      fire()
    }
  }
  document.addEventListener('visibilitychange', onVisible)
  return () => {
    offRefreshed()
    document.removeEventListener('visibilitychange', onVisible)
    cancelRefresh()
  }
}
