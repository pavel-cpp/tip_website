import { api } from '../../api/http'
import type { components } from '../../api/schema.gen'
import type { AuthUser } from '../../auth/types'

type Schemas = components['schemas']

export const AVATAR_MAX_BYTES = 2 * 1024 * 1024
export const AVATAR_TYPES = ['image/png', 'image/jpeg']

/** The six colours of the user palette (tokens --user-1..6, dark theme values). */
export const USER_COLORS = ['#ff6b9d', '#ffb84d', '#3ddc97', '#6cb4ff', '#b18cff', '#ff9559'] as const

export async function updateMe(patch: Schemas['UpdateMeRequest']): Promise<AuthUser> {
  return (await api.patch<Schemas['UserResponse']>('/me', patch)).user
}

export async function uploadAvatar(file: File): Promise<AuthUser> {
  const body = new FormData()
  body.append('file', file)
  return (await api.put<Schemas['UserResponse']>('/me/avatar', body)).user
}

export async function deleteAvatar(): Promise<AuthUser> {
  return (await api.delete<Schemas['UserResponse']>('/me/avatar')).user
}

/** Returns an i18n error code for a file the server would reject anyway, or null when it looks fine. */
export function checkAvatarFile(file: File): 'UNSUPPORTED_MEDIA' | 'TOO_LARGE' | null {
  if (!AVATAR_TYPES.includes(file.type)) return 'UNSUPPORTED_MEDIA'
  if (file.size > AVATAR_MAX_BYTES) return 'TOO_LARGE'
  return null
}
