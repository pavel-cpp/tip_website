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
