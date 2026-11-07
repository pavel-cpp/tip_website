// Tiny pub/sub so the API layer can announce a lost session without importing UI or router code.
const logoutListeners = new Set<() => void>()

export function onLogout(cb: () => void): () => void {
  logoutListeners.add(cb)
  return () => logoutListeners.delete(cb)
}

export function emitLogout(): void {
  for (const cb of logoutListeners) cb()
}
