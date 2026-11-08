import { useEffect, useState } from 'react'
import { getAccessToken } from '../../auth/tokenStore'

// The image endpoint needs the Bearer header, which <img src> cannot send, so the bytes are fetched
// and exposed as a blob URL. URLs carry ?v=<hash>, so a cache keyed by URL never goes stale.
const cache = new Map<string, Promise<string | null>>()

function load(url: string): Promise<string | null> {
  let hit = cache.get(url)
  if (!hit) {
    const headers = new Headers()
    const token = getAccessToken()
    if (token) headers.set('Authorization', `Bearer ${token}`)
    hit = fetch(url, { headers, credentials: 'include' })
      .then(async (res) => (res.ok ? URL.createObjectURL(await res.blob()) : null))
      .catch(() => null)
    cache.set(url, hit)
    // Do not cache failures: the next mount may succeed (token refreshed, network back).
    void hit.then((v) => v === null && cache.delete(url))
  }
  return hit
}

/** Resolves an API image URL to a displayable blob URL, or null while loading / on failure. */
export function useAuthedImage(url: string | null | undefined, enabled = true): string | null {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    if (!url || !enabled) {
      setSrc(null)
      return
    }
    let live = true
    void load(url).then((v) => live && setSrc(v))
    return () => {
      live = false
    }
  }, [url, enabled])
  return src
}

/** Test hook: drops the module cache. */
export function clearImageCache(): void {
  cache.clear()
}
