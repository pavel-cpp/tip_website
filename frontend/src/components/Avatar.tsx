import type { CSSProperties } from 'react'

export interface AvatarUser {
  displayName: string
  /** Hex colour, e.g. from the user palette. */
  color: string
  /** Image URL; initials are shown when absent. */
  avatar?: string | null
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => Array.from(w)[0])
    .join('')
    .toUpperCase()
}

/** Black or white, whichever reads better on the given hex colour (WCAG relative luminance). */
export function textOn(hex: string): string {
  const n = Number.parseInt(hex.replace('#', ''), 16)
  if (Number.isNaN(n)) return '#101218'
  const lin = (v: number) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  const lum = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255)
  return lum > 0.18 ? '#101218' : '#ffffff'
}

interface AvatarProps {
  user: AvatarUser
  size?: number
}

export function Avatar({ user, size = 28 }: AvatarProps) {
  const style = {
    '--size': `${size}px`,
    '--c': user.color,
    '--avatar-text': textOn(user.color),
    backgroundImage: user.avatar ? `url(${user.avatar})` : undefined,
  } as CSSProperties
  return (
    <span className="avatar" style={style} role="img" aria-label={user.displayName} title={user.displayName}>
      {!user.avatar && initials(user.displayName)}
    </span>
  )
}

interface AvatarStackProps {
  users: Array<AvatarUser & { id: string }>
  size?: number
  max?: number
}

export function AvatarStack({ users, size = 26, max = 4 }: AvatarStackProps) {
  const shown = users.slice(0, max)
  const extra = users.length - shown.length
  return (
    <div className="avatar-stack">
      {shown.map((u) => (
        <Avatar key={u.id} user={u} size={size} />
      ))}
      {extra > 0 && (
        <span className="avatar avatar-more" style={{ '--size': `${size}px` } as CSSProperties}>
          +{extra}
        </span>
      )}
    </div>
  )
}
