export interface Hsv {
  /** 0..360 */
  h: number
  /** 0..1 */
  s: number
  /** 0..1 */
  v: number
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

/** `#RRGGBB` -> HSV. Anything else is treated as black. */
export function hexToHsv(hex: string): Hsv {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  const n = m?.[1] ? Number.parseInt(m[1], 16) : 0
  const r = ((n >> 16) & 255) / 255
  const g = ((n >> 8) & 255) / 255
  const b = (n & 255) / 255
  const max = Math.max(r, g, b)
  const d = max - Math.min(r, g, b)
  let h = 0
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  return { h, s: max === 0 ? 0 : d / max, v: max }
}

/** HSV -> uppercase `#RRGGBB`. */
export function hsvToHex({ h, s, v }: Hsv): string {
  const hh = ((h % 360) + 360) % 360
  const ss = clamp(s, 0, 1)
  const vv = clamp(v, 0, 1)
  const f = (n: number) => {
    const k = (n + hh / 60) % 6
    return vv - vv * ss * Math.max(0, Math.min(k, 4 - k, 1))
  }
  const byte = (x: number) =>
    Math.round(x * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${byte(f(5))}${byte(f(3))}${byte(f(1))}`.toUpperCase()
}
