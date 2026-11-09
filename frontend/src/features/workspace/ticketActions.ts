import { Zip, ZipPassThrough } from 'fflate'
import {
  canvasScale,
  canvasToBlob,
  drawTicket,
  imageSize,
  loadFonts,
  releaseCanvas,
  renderTicketBlob,
  type TicketImage,
  type TicketPlaceholders,
  type TicketValues,
} from '../../lib/ticket'
import type { Participant } from './api'
import { blobToDataUri, buildHtml, buildTextList, type CopyImage, capRows } from './clipboardPayload'
import type { BatchItem } from './folderSave'
import { isIOS } from './platform'
import { safeFilePart } from './tableLogic'

export interface TicketSource {
  image: TicketImage
  placeholders: TicketPlaceholders
}

export const ticketValues = (p: Pick<Participant, 'number' | 'name' | 'phone'>): TicketValues => ({
  number: String(p.number),
  name: p.name,
  phone: p.phone,
})

/** `<project>_<number>_<name>.png`, each part sanitized; empty parts are left out. */
export const ticketFileName = (p: Pick<Participant, 'number' | 'name'>, projectTitle = ''): string =>
  `${[safeFilePart(projectTitle), String(p.number), safeFilePart(p.name)].filter(Boolean).join('_')}.png`

/** Lets the browser paint between heavy steps so progress bars and animations keep running. */
export const nextTurn = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

// ---------------------------------------------------------------- copy

export type CopyResult = { ok: true } | { ok: false; blob: Promise<Blob> }

/**
 * Copies the ticket as a PNG. Safari only accepts the write inside the user gesture, so the render
 * promise goes straight into the ClipboardItem instead of being awaited first. When the clipboard is
 * unavailable or refuses, the caller gets the image to show in a "long-press to copy" dialog.
 */
export async function copyTicket(source: TicketSource, participant: Participant): Promise<CopyResult> {
  const blob = renderTicketBlob(source.image, source.placeholders, ticketValues(participant))
  blob.catch(() => undefined)
  try {
    if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) throw new Error('unsupported')
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
    return { ok: true }
  } catch {
    return { ok: false, blob }
  }
}

export type CopyManyResult = { ok: true; count: number; skipped: number } | { ok: false; skipped: number }

/**
 * Copies several tickets as ONE clipboard item holding text/html (every image inline, in order) and
 * text/plain ("number name" lines). Browsers accept only a single image file per clipboard write
 * (Chromium rejects several ClipboardItems), so HTML is the only way to put many images on it. Like
 * `copyTicket`, the write starts synchronously inside the gesture; the HTML is a promise filled in
 * while images render one at a time.
 */
export function copyTickets(
  source: TicketSource,
  rows: readonly Participant[],
  onProgress?: SaveProgress,
): Promise<CopyManyResult> {
  const { rows: kept, skipped } = capRows(rows)
  const html = (async () => {
    const images: CopyImage[] = []
    for (const [i, row] of kept.entries()) {
      const blob = await renderTicketBlob(source.image, source.placeholders, ticketValues(row))
      images.push({ number: row.number, name: row.name, dataUri: await blobToDataUri(blob) })
      onProgress?.(i + 1, kept.length)
      await nextTurn()
    }
    return new Blob([buildHtml(images)], { type: 'text/html' })
  })()
  html.catch(() => undefined)
  const text = new Blob([buildTextList(kept)], { type: 'text/plain' })
  return (async (): Promise<CopyManyResult> => {
    try {
      if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) throw new Error('unsupported')
      await navigator.clipboard.write([new ClipboardItem({ 'text/html': html, 'text/plain': text })])
      return { ok: true, count: kept.length, skipped }
    } catch {
      return { ok: false, skipped }
    }
  })()
}

/** Files of a batch: sanitized names and a lazy render, so only one canvas is alive at a time. */
export function ticketBatch(
  source: TicketSource,
  rows: readonly Participant[],
  projectTitle: string,
): BatchItem[] {
  return rows.map((row) => ({
    name: ticketFileName(row, projectTitle),
    render: () => renderTicketBlob(source.image, source.placeholders, ticketValues(row)),
  }))
}

// ---------------------------------------------------------------- save

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Safari needs the URL to outlive the click for a moment.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** iOS prefers the share sheet for files; returns false when it is unavailable or was dismissed. */
export async function shareFile(file: File): Promise<boolean> {
  if (!isIOS() || typeof navigator.canShare !== 'function' || !navigator.canShare({ files: [file] })) {
    return false
  }
  try {
    await navigator.share({ files: [file] })
    return true
  } catch {
    return false
  }
}

async function deliver(blob: Blob, filename: string): Promise<void> {
  const file = new File([blob], filename, { type: blob.type })
  if (!(await shareFile(file))) downloadBlob(blob, filename)
}

export type SaveProgress = (done: number, total: number) => void

/** One participant becomes <project>_<number>_<name>.png; several become one ZIP (iOS blocks serial downloads). */
export async function saveTickets(
  source: TicketSource,
  rows: readonly Participant[],
  zipName: string,
  onProgress?: SaveProgress,
  projectTitle = '',
): Promise<void> {
  const [only] = rows
  if (!only) return
  if (rows.length === 1) {
    const blob = await renderTicketBlob(source.image, source.placeholders, ticketValues(only))
    await deliver(blob, ticketFileName(only, projectTitle))
    return
  }
  const zip = await buildZip(source, rows, onProgress, projectTitle)
  await deliver(zip, zipName)
}

export async function buildZip(
  source: TicketSource,
  rows: readonly Participant[],
  onProgress?: SaveProgress,
  projectTitle = '',
): Promise<Blob> {
  const chunks: Uint8Array<ArrayBuffer>[] = []
  const done = new Promise<void>((resolve, reject) => {
    const zip = new Zip((err, chunk, final) => {
      if (err) return reject(err)
      chunks.push(chunk as Uint8Array<ArrayBuffer>)
      if (final) resolve()
    })
    void (async () => {
      try {
        // PNGs are already compressed, so entries are stored without deflate.
        for (const [i, row] of rows.entries()) {
          const blob = await renderTicketBlob(source.image, source.placeholders, ticketValues(row))
          const entry = new ZipPassThrough(ticketFileName(row, projectTitle))
          zip.add(entry)
          entry.push(new Uint8Array(await blob.arrayBuffer()), true)
          onProgress?.(i + 1, rows.length)
          await nextTurn()
        }
        zip.end()
      } catch (e) {
        zip.terminate()
        reject(e)
      }
    })()
  })
  await done
  return new Blob(chunks, { type: 'application/zip' })
}

// ---------------------------------------------------------------- print

/** Print resolution cap: 70 mm at ~450 dpi is plenty, and keeps thousands of tickets in memory. */
export const PRINT_MAX_WIDTH = 1240

/**
 * Renders a ticket for the print sheet at reduced size to a JPEG blob and releases the canvas.
 * Fonts must be loaded by the caller once per batch (`loadFonts`).
 */
export async function renderPrintBlob(
  source: TicketSource,
  values: TicketValues,
  maxWidth = PRINT_MAX_WIDTH,
): Promise<Blob> {
  const { w, h } = imageSize(source.image)
  const scale = Math.min(1, maxWidth / w, canvasScale(w, h))
  const canvas = document.createElement('canvas')
  try {
    canvas.width = Math.max(1, Math.round(w * scale))
    canvas.height = Math.max(1, Math.round(h * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('2d canvas context is not available')
    ctx.scale(canvas.width / w, canvas.height / h)
    drawTicket(ctx, source.image, { w, h }, source.placeholders, values)
    return await canvasToBlob(canvas, 'image/jpeg')
  } finally {
    releaseCanvas(canvas)
  }
}

export type PrintProgress = (done: number, total: number) => void

/** Renders every row sequentially (one canvas alive at a time) and yields between rows for the UI. */
export async function renderPrintBatch(
  source: TicketSource,
  rows: readonly Participant[],
  onProgress: PrintProgress,
  isCancelled: () => boolean = () => false,
): Promise<Blob[]> {
  await loadFonts(source.placeholders)
  const out: Blob[] = []
  for (const [i, row] of rows.entries()) {
    if (isCancelled()) break
    out.push(await renderPrintBlob(source, ticketValues(row)))
    onProgress(i + 1, rows.length)
    await nextTurn()
  }
  return out
}
