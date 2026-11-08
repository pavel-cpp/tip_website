import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router'
import { useProject } from '../features/projects/api'
import { useAuthedImage } from '../features/projects/useAuthedImage'
import { logPrinted, useParticipants } from '../features/workspace/api'
import { isIOS } from '../features/workspace/platform'
import { clearPrintJob, getPrintJob } from '../features/workspace/printJob'
import { renderPrintBatch } from '../features/workspace/ticketActions'
import { useI18n } from '../i18n'
import { errorText } from '../i18n/apiError'
import { paginate, printCss, type TicketPlaceholders, useImageElement } from '../lib/ticket'
import '../features/workspace/print.css'

/**
 * Dedicated print page (docs/06-frontend.md, sections 5 and 6): always light, A4 sheets of 70x40 mm
 * tickets with zero margins. Tickets are rendered one by one, then the browser print dialog opens.
 * The audit record (ids only) is sent after the dialog closes.
 */
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

export default function Print() {
  const { id = '' } = useParams()
  const job = getPrintJob(id)
  if (!job) return <Navigate to={`/projects/${id}`} replace />
  return <PrintSheet projectId={id} ids={job.ids} />
}

function PrintSheet({ projectId, ids }: { projectId: string; ids: string[] }) {
  const { t, formatNumber } = useI18n()
  const navigate = useNavigate()
  const project = useProject(projectId)
  const list = useParticipants(projectId)
  const blobUrl = useAuthedImage(project.data?.image?.url)
  const imageEl = useImageElement(blobUrl)
  const [urls, setUrls] = useState<string[]>([])
  const [progress, setProgress] = useState(0)
  const [failed, setFailed] = useState<string | null>(null)
  const rows = useMemo(() => {
    const byId = new Map((list.data?.items ?? []).map((r) => [r.id, r]))
    return ids.flatMap((i) => byId.get(i) ?? [])
  }, [list.data, ids])

  const back = useCallback(() => {
    clearPrintJob()
    void navigate(`/projects/${projectId}`)
  }, [navigate, projectId])

  const placeholders = project.data?.placeholders as TicketPlaceholders | undefined
  const ready = !!imageEl && !!placeholders && !!list.data

  // The batch starts once, when everything is loaded; later refetches must not restart it.
  const latest = useRef({ imageEl, placeholders, rows })
  latest.current = { imageEl, placeholders, rows }
  useEffect(() => {
    const { imageEl, placeholders, rows } = latest.current
    if (!ready || !imageEl || !placeholders) return
    let cancelled = false
    const made: string[] = []
    void renderPrintBatch(
      { image: imageEl, placeholders },
      rows,
      (done) => !cancelled && setProgress(done),
      () => cancelled,
    )
      .then((blobs) => {
        if (cancelled) return
        for (const b of blobs) made.push(URL.createObjectURL(b))
        setUrls([...made])
      })
      .catch((e) => !cancelled && setFailed(errorText(e)))
    return () => {
      cancelled = true
      for (const u of made) URL.revokeObjectURL(u)
    }
  }, [ready])

  // Object URLs created after the effect cleanup ran are released with the page.
  useEffect(
    () => () => {
      for (const u of urls) URL.revokeObjectURL(u)
    },
    [urls],
  )

  const total = rows.length
  const done = urls.length > 0 && urls.length === total
  const pages = useMemo(() => paginate(urls.length), [urls.length])
  const css = useMemo(() => printCss(), [])
  const styled = useConstructedStyle(css)

  const doPrint = useCallback(async () => {
    // Printing before the images are decoded yields blank tickets in Chrome.
    await Promise.all(
      [...document.querySelectorAll<HTMLImageElement>('.print-ticket')].map((img) =>
        (img.decode?.() ?? Promise.resolve()).catch(() => undefined),
      ),
    )
    window.print()
    // Browsers block inside print(), so this runs after the dialog closed. Only ids are sent.
    void logPrinted(
      projectId,
      rows.map((r) => r.id),
    ).catch(() => undefined)
  }, [projectId, rows])

  const autoPrinted = useRef(false)
  useEffect(() => {
    // iOS needs a user gesture for printing, so it only offers the button.
    if (!done || autoPrinted.current || isIOS()) return
    autoPrinted.current = true
    void doPrint()
  }, [done, doPrint])

  return (
    <div className="print-root">
      {!styled && <style>{css}</style>}
      <div className="print-ui">
        <div className="print-bar">
          <button type="button" className="print-btn" onClick={back}>
            {t('workspace.print.back')}
          </button>
          <div className="print-status" role="status">
            {failed ? (
              <span className="print-error">{failed}</span>
            ) : done ? (
              t('workspace.print.ready', { count: total, pages: pages.length })
            ) : (
              t('workspace.print.rendering', { done: formatNumber(progress), total: formatNumber(total) })
            )}
          </div>
          <button
            type="button"
            className="print-btn print-btn-primary"
            disabled={!done}
            onClick={() => void doPrint()}
          >
            {t('workspace.print.button')}
          </button>
        </div>
        {!done && !failed && (
          <div
            className="print-progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={progress}
            aria-label={t('workspace.print.progress')}
          >
            <span style={{ transform: `scaleX(${total ? progress / total : 0})` }} />
          </div>
        )}
        <p className="print-tip">{t('workspace.print.tip')}</p>
      </div>
      <div className="print-pages">
        {pages.map((page, p) => (
          <section key={p} className="print-page" aria-label={t('workspace.print.page', { n: p + 1 })}>
            {page.map((i) => (
              <img key={urls[i]} className="print-ticket" src={urls[i]} alt="" />
            ))}
          </section>
        ))}
      </div>
    </div>
  )
}
