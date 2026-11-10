/** Mirrors domain.MaxImageBytes; the server stays the authority (MAX_IMAGE_MB may differ). */
export const MAX_IMAGE_BYTES = 10 << 20

export const IMAGE_TYPES = ['image/png', 'image/jpeg'] as const

/** Why a picked or dropped file cannot be used as the ticket picture, or null when it looks fine. */
export function imageFileProblem(file: { type: string; size: number }): 'type' | 'size' | null {
  if (!(IMAGE_TYPES as readonly string[]).includes(file.type)) return 'type'
  if (file.size > MAX_IMAGE_BYTES) return 'size'
  return null
}

/** True while the drag carries files (and not, say, selected text). */
export function dragHasFiles(dt: { types: readonly string[] | DOMStringList } | null): boolean {
  return dt !== null && Array.prototype.includes.call(dt.types, 'Files')
}
