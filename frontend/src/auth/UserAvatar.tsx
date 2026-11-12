import { useEffect, useState } from 'react'
import { Avatar, type AvatarUser } from '../components/Avatar'
import { refreshAccessToken } from './refresh'
import { getAccessToken } from './tokenStore'

// Avatar images sit behind the Bearer token, so an <img src> or CSS url() cannot load them directly.
// Each URL carries a version (?v=...), which makes it safe to cache the blob URL for the whole session.
const cache = new Map<string, Promise<string>>()

async function download(url: string, retried = false): Promise<string> {
  const token = getAccessToken()
  const res = await fetch(url, {
    credentials: 'include',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (res.status === 401 && !retried) {
    await refreshAccessToken()
    return download(url, true)
  }
  if (!res.ok) throw new Error(`avatar ${res.status}`)
  return URL.createObjectURL(await res.blob())
}

export function loadAvatar(url: string): Promise<string> {
  let hit = cache.get(url)
  if (!hit) {
    hit = download(url)
    cache.set(url, hit)
    // A failed download must not poison the cache.
    hit.catch(() => cache.delete(url))
  }
  return hit
}

/** Resolves an avatar URL to a displayable blob URL; null while loading or when there is no image. */
export function useAvatarSrc(url: string | null | undefined): string | null {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    setSrc(null)
    if (!url) return
    let live = true
    loadAvatar(url).then(
      (s) => live && setSrc(s),
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [url])
  return src
}

interface UserAvatarProps {
  user: { displayName: string; color: string; avatarUrl: string | null }
  size?: number
  /** Local preview (blob URL) that wins over the stored avatar, e.g. while uploading. */
  override?: string | null
  /** Skip the native title when a Tooltip already names the person. */
  noTitle?: boolean
}

/** Avatar for API users: loads the protected image, shows initials until it arrives or when there is none. */
export function UserAvatar({ user, size, override, noTitle }: UserAvatarProps) {
  const fetched = useAvatarSrc(override ? null : user.avatarUrl)
  const shown: AvatarUser = { displayName: user.displayName, color: user.color, avatar: override ?? fetched }
  return <Avatar user={shown} size={size} noTitle={noTitle} />
}
