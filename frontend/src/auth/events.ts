// Tiny pub/sub so the API layer can announce a lost session without importing UI or router code.
const logoutListeners = new Set<() => void>()
const refreshListeners = new Set<(expiresIn: number) => void>()

export function onLogout(cb: () => void): () => void {
  logoutListeners.add(cb)
  return () => logoutListeners.delete(cb)
}

export function emitLogout(): void {
  for (const cb of logoutListeners) cb()
}

/** Fires after every successful token rotation (reactive or proactive) with the new lifetime in seconds. */
export function onTokenRefreshed(cb: (expiresIn: number) => void): () => void {
  refreshListeners.add(cb)
  return () => refreshListeners.delete(cb)
}

export function emitTokenRefreshed(expiresIn: number): void {
  for (const cb of refreshListeners) cb(expiresIn)
}
