import { useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useI18n } from '../../i18n'
import { paginate, printCss } from '../../lib/ticket'
import './print.css'

/**
 * Applies CSS without an inline <style> element, which the server's Content-Security-Policy
 * blocks. A constructed stylesheet is created through the CSSOM and is not subject to that
 * check. Returns false where the browser lacks support, so the caller can fall back.
 */
function useConstructedStyle(css: string): boolean {
  const supported =
    typeof document !== 'undefined' &&
    'adoptedStyleSheets' in document &&
    typeof CSSStyleSheet !== 'undefined' &&
    'replaceSync' in CSSStyleSheet.prototype
  useEffect(() => {
    if (!supported) return
    const sheet = new CSSStyleSheet()
    sheet.replaceSync(css)
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]
    return () => {
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((x) => x !== sheet)
    }
  }, [css, supported])
  return supported
}

/**
 * Opens the browser print dialog once every ticket image is loaded (printing earlier gives blank tickets in
 * Chrome). When the images are already there it prints in the same task: Safari on iOS only prints inside the
 * user's tap, and any await in between can use that up.
 */
export function printSheets(): Promise<void> {
  const imgs = [...document.querySelectorAll<HTMLImageElement>('.print-ticket')]
  if (imgs.length > 0 && imgs.every((img) => img.complete && img.naturalWidth > 0)) {
    window.print()
    return Promise.resolve()
  }
  return Promise.all(imgs.map((img) => (img.decode?.() ?? Promise.resolve()).catch(() => undefined))).then(
    () => window.print(),
  )
}

interface PrintSheetsProps {
  /** Object URLs of the rendered tickets, in print order. */
  urls: readonly string[]
  /** The print dialog was closed (printed or cancelled). */
  onClosed: () => void
}

/**
 * A4 sheets of 70x40 mm tickets, mounted next to the app (not instead of it): they are invisible on
 * screen and the print media rules hide everything else, so the user never leaves the workspace.
 */
export function PrintSheets({ urls, onClosed }: PrintSheetsProps) {
  const { t } = useI18n()
  const pages = useMemo(() => paginate(urls.length), [urls.length])
  const css = useMemo(() => printCss(), [])
  const styled = useConstructedStyle(css)

  useEffect(() => {
    window.addEventListener('afterprint', onClosed)
    return () => window.removeEventListener('afterprint', onClosed)
  }, [onClosed])

  return createPortal(
    <div className="print-sheets" aria-hidden="true">
      {!styled && <style>{css}</style>}
      {pages.map((page, p) => (
        <section key={p} className="print-page" aria-label={t('workspace.print.page', { n: p + 1 })}>
          {page.map((i) => (
            <img key={urls[i]} className="print-ticket" src={urls[i]} alt="" />
          ))}
        </section>
      ))}
    </div>,
    document.body,
  )
}
