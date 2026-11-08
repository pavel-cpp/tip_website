import { PLACEHOLDER_KEYS, type TicketPlaceholder, type TicketPlaceholders, type TicketValues } from './types'

/** Safari/iOS canvas area limit (16.7 megapixels); larger canvases silently draw nothing. */
export const MAX_CANVAS_PIXELS = 16_777_216

/** Anything `drawImage` accepts that also reports its intrinsic size. */
export type TicketImage = CanvasImageSource & {
  naturalWidth?: number
  naturalHeight?: number
  width: number
  height: number
}

export function fontSpec(p: TicketPlaceholder): string {
  return `${p.italic ? 'italic ' : ''}${p.bold ? '700' : '400'} ${p.size}px "${p.font}", sans-serif`
}

/** Scale factor (<= 1) that brings w*h under the pixel limit; 1 when it already fits. */
export function canvasScale(w: number, h: number, maxPixels = MAX_CANVAS_PIXELS): number {
  const area = w * h
  return area <= maxPixels ? 1 : Math.sqrt(maxPixels / area)
}

export function imageSize(image: TicketImage): { w: number; h: number } {
  return { w: image.naturalWidth || image.width, h: image.naturalHeight || image.height }
}

/**
 * Safari draws a fallback face when a web font is not loaded yet, so every render awaits this first.
 * The sample text covers Cyrillic and the Uzbek Latin letters.
 */
export async function loadFonts(placeholders: TicketPlaceholders): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts) return
  const specs = new Set(PLACEHOLDER_KEYS.map((k) => fontSpec(placeholders[k])))
  await Promise.all([...specs].map((spec) => document.fonts.load(spec, 'Аа Aa oʻgʻ')))
}

/** Draws background and the text placeholders in source-image pixel coordinates. */
export function drawTicket(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource,
  size: { w: number; h: number },
  placeholders: TicketPlaceholders,
  values: TicketValues,
): void {
  ctx.drawImage(image, 0, 0, size.w, size.h)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.lineJoin = 'round'
  for (const key of PLACEHOLDER_KEYS) {
    const p = placeholders[key]
    const text = values[key]
    if (!text) continue
    ctx.font = fontSpec(p)
    if (p.stroke > 0) {
      // The stroke is centred on the glyph edge, so double it to get `stroke` px outside the fill.
      ctx.lineWidth = p.stroke * 2
      ctx.strokeStyle = p.strokeColor
      ctx.strokeText(text, p.x, p.y)
    }
    ctx.fillStyle = p.color
    ctx.fillText(text, p.x, p.y)
    if (p.underline) {
      const w = ctx.measureText(text).width
      ctx.fillRect(p.x - w / 2, p.y + p.size * 0.55, w, Math.max(1, p.size / 14))
    }
  }
}

/**
 * Renders a ticket into `canvas`. The canvas gets the image size, reduced when it would exceed the
 * iOS limit; drawing stays in image pixels so placeholder coordinates remain valid. Returns the scale used.
 * Callers must have awaited `loadFonts` for the same placeholders.
 */
export function renderTicket(
  canvas: HTMLCanvasElement,
  image: TicketImage,
  placeholders: TicketPlaceholders,
  values: TicketValues,
): number {
  const { w, h } = imageSize(image)
  const scale = canvasScale(w, h)
  canvas.width = Math.max(1, Math.floor(w * scale))
  canvas.height = Math.max(1, Math.floor(h * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2d canvas context is not available')
  if (scale !== 1) ctx.scale(canvas.width / w, canvas.height / h)
  drawTicket(ctx, image, { w, h }, placeholders, values)
  return scale
}

/** Frees the backing store; iOS keeps canvas memory alive until the size is reset. */
export function releaseCanvas(canvas: HTMLCanvasElement): void {
  canvas.width = 0
  canvas.height = 0
}

export function canvasToBlob(canvas: HTMLCanvasElement, type = 'image/png'): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas.toBlob returned null'))), type)
  })
}

/** Renders one ticket off-screen to a PNG blob and releases the canvas (use sequentially for batches). */
export async function renderTicketBlob(
  image: TicketImage,
  placeholders: TicketPlaceholders,
  values: TicketValues,
): Promise<Blob> {
  await loadFonts(placeholders)
  const canvas = document.createElement('canvas')
  try {
    renderTicket(canvas, image, placeholders, values)
    return await canvasToBlob(canvas, 'image/png')
  } finally {
    releaseCanvas(canvas)
  }
}
