import { apiRequest } from '../../api/http'

export const CUSTOM_FONT_PREFIX = 'custom:'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Id of an uploaded font from a placeholder font value, or null for built-in fonts. */
export function customFontId(font: string): string | null {
  if (!font.startsWith(CUSTOM_FONT_PREFIX)) return null
  const id = font.slice(CUSTOM_FONT_PREFIX.length)
  return UUID.test(id) ? id : null
}

export const customFontRef = (id: string): string => `${CUSTOM_FONT_PREFIX}${id}`

/** Fetches the bytes of an uploaded font; replaceable in tests. */
export type FontSource = (id: string) => Promise<ArrayBuffer>

const apiSource: FontSource = async (id) => (await apiRequest(`/fonts/${id}/file`)).arrayBuffer()
let source: FontSource = apiSource

export function setFontSource(next: FontSource | null): void {
  source = next ?? apiSource
  custom.clear()
}

// A font is registered once per page: the promise is shared by every drawing that needs it. A failure is
// forgotten so the next attempt (network back, token refreshed) tries again; the canvas meanwhile falls
// back to the generic face.
const custom = new Map<string, Promise<void>>()

/** Registers an uploaded font with the FontFace API so the canvas and the DOM can use it. */
export function ensureCustomFont(font: string): Promise<void> {
  const id = customFontId(font)
  if (!id || typeof document === 'undefined' || typeof FontFace === 'undefined') return Promise.resolve()
  let hit = custom.get(font)
  if (!hit) {
    hit = source(id)
      .then(async (data) => {
        const face = new FontFace(font, data)
        await face.load()
        document.fonts.add(face)
      })
      .catch(() => {
        custom.delete(font)
      })
    custom.set(font, hit)
  }
  return hit
}

// The @font-face rules of the bundled families (about 5 KB gzip) live in their own stylesheet that is
// fetched on first use, so they never delay the first paint; the font files themselves are fetched by the
// browser only for the families and scripts that are actually drawn.
let catalogCss: Promise<unknown> | null = null

export function ensureCatalogFonts(): Promise<unknown> {
  catalogCss ??= import('../../styles/ticketFonts.css').catch(() => {
    catalogCss = null
  })
  return catalogCss
}
