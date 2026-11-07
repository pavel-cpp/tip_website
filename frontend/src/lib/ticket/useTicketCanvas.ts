import { type RefObject, useEffect, useState } from 'react'
import { loadFonts, renderTicket, type TicketImage } from './render'
import type { TicketPlaceholders, TicketValues } from './types'

/** Loads an image URL (blob or same-origin) into an HTMLImageElement; null until decoded. */
export function useImageElement(src: string | null | undefined): HTMLImageElement | null {
  const [img, setImg] = useState<HTMLImageElement | null>(null)
  useEffect(() => {
    setImg(null)
    if (!src) return
    let live = true
    const el = new Image()
    el.onload = () => live && setImg(el)
    el.src = src
    return () => {
      live = false
      el.onload = null
    }
  }, [src])
  return img
}

/**
 * Keeps `canvas` in sync with the ticket inputs. Fonts are awaited before every draw and draws are
 * coalesced into one per animation frame, so rapid edits (dragging, typing) never queue stale work.
 */
export function useTicketCanvas(
  canvas: RefObject<HTMLCanvasElement | null>,
  image: TicketImage | null,
  placeholders: TicketPlaceholders | null,
  values: TicketValues,
): void {
  const { number, name, phone } = values
  useEffect(() => {
    if (!image || !placeholders) return
    let live = true
    let frame = 0
    void loadFonts(placeholders).then(() => {
      if (!live) return
      frame = requestAnimationFrame(() => {
        const el = canvas.current
        if (live && el) renderTicket(el, image, placeholders, { number, name, phone })
      })
    })
    return () => {
      live = false
      cancelAnimationFrame(frame)
    }
  }, [canvas, image, placeholders, number, name, phone])
}
