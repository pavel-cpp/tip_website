import { getAccessToken } from '../../auth/tokenStore'

/**
 * Temporary stand-in for the auth context owned by the auth stream: reads the `perms` claim of the
 * in-memory access token (docs/04-api.md: the user's permissions live in the JWT claims).
 * Swap the body for the real auth context hook when it lands; the signature is the contract.
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
  const perms = permissionsFromToken(getAccessToken())
  return { can: (p) => perms.has(p) }
}
