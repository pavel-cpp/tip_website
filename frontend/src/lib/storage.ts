// localStorage can throw (private mode, blocked site data) or be wiped by ITP; every access is guarded.
export function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Persistence is a convenience only.
  }
}
