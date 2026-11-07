// TODO: replace with the output of `npm run gen:api` (openapi-typescript) once backend/api/openapi.yaml is merged.
// Hand-written minimal subset used by the API/auth foundation.

/** Stable error codes from docs/04-api.md plus two client-side ones. */
export type ApiErrorCode =
  | 'VALIDATION'
  | 'UNAUTHENTICATED'
  | 'AUTH_UNAVAILABLE'
  | 'TOKEN_EXPIRED'
  | 'TOKEN_STALE'
  | 'REFRESH_INVALID'
  | 'BAD_CREDENTIALS'
  | 'FORBIDDEN'
  | 'PASSWORD_CHANGE_REQUIRED'
  | 'NOT_FOUND'
  | 'ROW_LOCKED'
  | 'VERSION_CONFLICT'
  | 'PROJECT_FINISHED'
  | 'LAST_ADMIN'
  | 'ROLE_IN_USE'
  | 'ROLE_SYSTEM'
  | 'TOO_LARGE'
  | 'UNSUPPORTED_MEDIA'
  | 'IMAGE_INVALID'
  | 'RATE_LIMITED'
  | 'DISK_LOW'
  | 'INTERNAL'
  /** Client-side: the request never reached the server. */
  | 'NETWORK'
  /** Client-side: a response without a recognisable error envelope. */
  | 'UNKNOWN'

export interface ApiErrorEnvelope {
  error: { code: ApiErrorCode; message: string; details?: Record<string, unknown> }
}

export interface TokenResponse {
  accessToken: string
  /** Seconds until the access token expires. */
  expiresIn: number
}

export interface User {
  id: string
  login: string
  displayName: string
  color: string
  locale: 'ru' | 'uz'
  theme: 'dark' | 'light' | 'system'
  passwordTemporary: boolean
  roles: string[]
  permissions: string[]
}

export interface LoginResponse extends TokenResponse {
  user: User
}
