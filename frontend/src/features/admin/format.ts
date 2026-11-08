const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

/** Splits a byte count into a value (1 decimal at most) and a unit code for the dictionary. */
export function splitBytes(bytes: number): { value: number; unit: (typeof UNITS)[number] } {
  let value = Math.max(0, bytes)
  let i = 0
  while (value >= 1024 && i < UNITS.length - 1) {
    value /= 1024
    i++
  }
  return { value: Math.round(value * 10) / 10, unit: UNITS[i] as (typeof UNITS)[number] }
}

/** Splits seconds of uptime into whole days, hours and minutes. */
export function splitUptime(seconds: number): { d: number; h: number; m: number } {
  const total = Math.max(0, Math.floor(seconds))
  return {
    d: Math.floor(total / 86400),
    h: Math.floor((total % 86400) / 3600),
    m: Math.floor((total % 3600) / 60),
  }
}

/** Share of the disk in use, 0..1. */
export function diskUsedRatio(free: number, total: number): number {
  if (total <= 0) return 0
  return Math.min(1, Math.max(0, 1 - free / total))
}
