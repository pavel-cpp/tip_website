import type { components } from '../api/schema.gen'

// The generated schema is the source of truth; api/types.ts keeps an older hand-written subset.
type Schemas = components['schemas']

export type AuthUser = Schemas['User']
export type PermissionCode = Schemas['PermissionCode']
export type Locale = Schemas['Locale']
export type ThemePref = Schemas['Theme']
export type TokenResponse = Schemas['TokenResponse']
export type LoginResponse = Schemas['LoginResponse']
