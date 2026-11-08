import { useOptionalAuth } from '../../auth/AuthProvider'
import { getAccessToken } from '../../auth/tokenStore'

/**
 * Delegates to the auth context (src/auth); the `perms` claim of the in-memory access token
 * (docs/04-api.md) is only a fallback when rendered outside the provider.
 * The server still decides everything; this only shows or hides UI.
 */
export interface Permissions {
  can: (permission: string) => boolean
}

export function permissionsFromToken(token: string | null): ReadonlySet<string> {
  if (!token) return new Set()
  try {
    const payload = token.split('.')[1]
    if (!payload) return new Set()
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
    const claims = JSON.parse(json) as { perms?: unknown }
    return new Set(Array.isArray(claims.perms) ? claims.perms.filter((p) => typeof p === 'string') : [])
  } catch {
    return new Set()
  }
}

export function usePermissions(): Permissions {
  const auth = useOptionalAuth()
  const perms: ReadonlySet<string> = auth?.user
    ? new Set<string>(auth.user.permissions)
    : permissionsFromToken(getAccessToken())
  return { can: (p) => perms.has(p) }
}
