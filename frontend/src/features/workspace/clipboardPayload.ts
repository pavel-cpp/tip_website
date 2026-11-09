/** Above this many tickets a multi-copy is cut off: every image is held in memory as a data URI. */
export const COPY_CAP = 50

export interface CopyEntry {
  number: number
  name: string
}

export interface CopyImage extends CopyEntry {
  dataUri: string
}

/** The first `cap` rows are copied; `skipped` tells the user how many were left out. */
export function capRows<T>(rows: readonly T[], cap = COPY_CAP): { rows: T[]; skipped: number } {
  return { rows: rows.slice(0, cap), skipped: Math.max(0, rows.length - cap) }
}

/** One "number name" line per ticket, in selection order (the text/plain flavour of the clipboard). */
export function buildTextList(items: readonly CopyEntry[]): string {
  return items.map((i) => `${i.number} ${i.name}`.trimEnd()).join('\n')
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * One HTML document with every ticket as an inline image, in order. Word, Google Docs, mail composers
 * and most chat apps keep all <img> elements of pasted HTML; no browser accepts several image files.
 */
export function buildHtml(items: readonly CopyImage[]): string {
  const body = items
    .map((i) => `<p><img src="${i.dataUri}" alt="${escapeHtml(`${i.number} ${i.name}`.trim())}"></p>`)
    .join('')
  return `<!doctype html><html><body>${body}</body></html>`
}

export function blobToDataUri(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.readAsDataURL(blob)
  })
}
