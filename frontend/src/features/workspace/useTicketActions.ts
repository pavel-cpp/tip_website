import { useCallback, useEffect, useRef, useState } from 'react'
import { useToast } from '../../components/Toast'
import { useI18n } from '../../i18n'
import { errorText } from '../../i18n/apiError'
import { paginate, renderTicketBlob } from '../../lib/ticket'
import { logPrinted, type Participant } from './api'
import { COPY_CAP } from './clipboardPayload'
import {
  chunkFiles,
  downloadEach,
  folderSupported,
  loadSaveMode,
  pickFolder,
  planSave,
  type SaveMode,
  storeSaveMode,
  writeToFolder,
} from './folderSave'
import { printSheets } from './PrintSheets'
import { isIOS } from './platform'
import { safeFilePart } from './tableLogic'
import {
  canShareFiles,
  copyTicket,
  copyTickets,
  downloadBlob,
  isTouchDevice,
  nextTurn,
  renderPrintBatch,
  saveTickets,
  type TicketSource,
  ticketBatch,
  ticketValues,
} from './ticketActions'

export interface Progress {
  kind: 'save' | 'copy' | 'print'
  done: number
  total: number
  /** Folder and serial-download saves can be stopped half way. */
  cancellable?: boolean
}

interface Args {
  projectId: string
  projectTitle: string
  /** Null until the project image and placeholders are ready. */
  source: TicketSource | null
  /** The row shown in the ticket panel. */
  current: Participant | null
  /** Selected rows in table order; falls back to `current` when empty. */
  selectedRows: readonly Participant[]
  /** Phone layout: several tickets are saved as image files through the share sheet, never as a ZIP. */
  phone?: boolean
}

const zipName = (title: string) => `${safeFilePart(title) || 'tickets'}.zip`

/** Copy / save / print behaviour behind the workspace toolbar. All of it is gated by participant.print upstream. */
export function useTicketActions({
  projectId,
  projectTitle,
  source,
  current,
  selectedRows,
  phone = false,
}: Args) {
  const { t } = useI18n()
  const toast = useToast()
  const [progress, setProgress] = useState<Progress | null>(null)
  const [fallback, setFallback] = useState<Blob | null>(null)
  const [saveMode, setSaveModeState] = useState<SaveMode>(loadSaveMode)
  const busy = useRef(false)
  const alive = useRef(true)
  const abort = useRef<AbortController | null>(null)
  // Rendered print sheets live (as object URLs) until the print dialog closes.
  const [sheets, setSheets] = useState<string[] | null>(null)
  const sheetUrls = useRef<string[]>([])
  const printedIds = useRef<string[]>([])
  const dropSheets = useCallback(() => {
    for (const u of sheetUrls.current) URL.revokeObjectURL(u)
    sheetUrls.current = []
  }, [])
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      abort.current?.abort()
      dropSheets()
    }
  }, [dropSheets])

  const targets = selectedRows.length > 0 ? selectedRows : current ? [current] : []

  // Touch screens: a clipboard write must start inside the tap, and Safari is strict about how long the picture
  // may take. So the single ticket is rendered ahead (after a short pause, so paging does not queue renders)
  // and the tap hands the clipboard a finished blob.
  const warm = useRef<{ source: TicketSource; row: Participant; blob: Promise<Blob> } | null>(null)
  const only = targets.length === 1 ? targets[0] : undefined
  useEffect(() => {
    warm.current = null
    if (!only || !source || !window.matchMedia('(pointer: coarse)').matches) return
    const id = setTimeout(() => {
      const blob = renderTicketBlob(source.image, source.placeholders, ticketValues(only))
      blob.catch(() => undefined)
      warm.current = { source, row: only, blob }
    }, 250)
    return () => clearTimeout(id)
  }, [source, only?.id, only?.number, only?.name, only?.phone])
  const setSaveMode = useCallback((m: SaveMode) => {
    storeSaveMode(m)
    setSaveModeState(m)
  }, [])

  const saveZipRef = useRef<() => Promise<void>>(async () => undefined)
  // On phones the "save instead" offer is image files, not an archive.
  const toZip = useCallback(
    () => ({
      label: t(phone ? 'workspace.copy.images' : 'workspace.copy.zip'),
      onAction: () => void saveZipRef.current(),
    }),
    [t, phone],
  )

  /** Must run synchronously inside the click/keydown handler (Safari clipboard rule). */
  const copy = useCallback(() => {
    const first = targets[0]
    if (!source || !first) {
      toast.show({ message: t('workspace.toast.notReady'), tone: 'error' })
      return
    }
    if (targets.length > 1) {
      if (busy.current) return
      busy.current = true
      const total = Math.min(targets.length, COPY_CAP)
      setProgress({ kind: 'copy', done: 0, total })
      void copyTickets(source, targets, (done, all) => {
        if (alive.current) setProgress({ kind: 'copy', done, total: all })
      }).then((res) => {
        busy.current = false
        if (alive.current) setProgress(null)
        if (!res.ok) {
          toast.show({
            message: t(phone ? 'workspace.toast.copyManyFailedPhone' : 'workspace.toast.copyManyFailed'),
            tone: 'error',
            action: toZip(),
          })
          return
        }
        toast.show({
          message:
            t('workspace.toast.copiedMany', { count: res.count }) +
            (res.skipped > 0
              ? ` ${t(phone ? 'workspace.toast.copyCappedPhone' : 'workspace.toast.copyCapped', { cap: COPY_CAP, skipped: res.skipped })}`
              : ''),
          // Pasting HTML into a plain image field gives only one picture, so the ZIP is always on offer.
          action: toZip(),
          duration: 9000,
        })
      })
      return
    }
    const w = warm.current
    const ready =
      w &&
      w.source === source &&
      w.row.id === first.id &&
      w.row.name === first.name &&
      w.row.phone === first.phone
        ? w.blob
        : undefined
    void copyTicket(source, first, ready).then(async (res) => {
      if (res.ok) {
        toast.show({ message: t('workspace.toast.copied') })
        return
      }
      // Tell the user why the usual "copied" confirmation did not appear, then offer the manual path.
      toast.show({ message: t('workspace.toast.copyFailed'), tone: 'error' })
      try {
        setFallback(await res.blob)
      } catch (e) {
        toast.show({ message: errorText(e), tone: 'error' })
      }
    })
  }, [source, targets, toast, t, toZip, phone])

  const report = useCallback(
    (res: { saved: number; failed: { name: string }[]; cancelled: boolean }, total: number) => {
      if (res.cancelled) {
        toast.show({ message: t('workspace.toast.saveCancelled', { saved: res.saved, total }) })
      } else if (res.failed.length > 0) {
        toast.show({
          message: t('workspace.toast.saveSomeFailed', {
            saved: res.saved,
            total,
            names: res.failed.map((f) => f.name).join(', '),
          }),
          tone: 'error',
          duration: 12000,
        })
      } else {
        toast.show({ message: t('workspace.toast.saved', { count: res.saved }) })
      }
    },
    [toast, t],
  )

  /**
   * Hands prepared image files to the share sheet (Save to Photos / Gallery), one chunk per sheet. A sheet only
   * opens inside a tap, so the first one opens at once while the tap is still fresh and every other chunk is
   * offered in a short-lived toast whose button is that tap.
   */
  const offerShare = useCallback(
    function offer(chunks: File[][], i: number, total: number, now: boolean): void {
      const open = () => {
        navigator.share({ files: chunks[i] as File[] }).then(
          () => {
            if (i + 1 < chunks.length) offer(chunks, i + 1, total, false)
            else toast.show({ message: t('workspace.toast.saved', { count: total }) })
          },
          (e: unknown) => {
            if (e instanceof DOMException && e.name === 'AbortError') {
              const saved = chunks.slice(0, i).reduce((n, c) => n + c.length, 0)
              toast.show({ message: t('workspace.toast.saveCancelled', { saved, total }) })
            } else {
              toast.show({ message: errorText(e), tone: 'error' })
            }
          },
        )
      }
      if (now) {
        open()
        return
      }
      toast.show({
        message: t('workspace.share.ready', { part: i + 1, parts: chunks.length }),
        action: { label: t('workspace.share.save'), onAction: open },
        duration: 60_000,
      })
    },
    [toast, t],
  )

  const runSave = useCallback(
    async (mode: SaveMode) => {
      if (!source || targets.length === 0 || busy.current) {
        if (!source) toast.show({ message: t('workspace.toast.notReady'), tone: 'error' })
        return
      }
      const plan = planSave(targets.length, mode, {
        folder: folderSupported(),
        ios: isIOS(),
        phone: phone && isTouchDevice(),
      })
      busy.current = true
      const ctl = new AbortController()
      abort.current = ctl
      const onProgress = (cancellable: boolean) => (done: number, total: number) => {
        if (alive.current) setProgress({ kind: 'save', done, total, cancellable })
      }
      try {
        if (plan.kind === 'folder') {
          // The picker needs the click's user activation, so it opens before anything is rendered.
          const dir = await pickFolder()
          if (!dir) return
          setProgress({ kind: 'save', done: 0, total: targets.length, cancellable: true })
          report(
            await writeToFolder(dir, ticketBatch(source, targets, projectTitle), {
              onProgress: onProgress(true),
              signal: ctl.signal,
              tick: nextTurn,
            }),
            targets.length,
          )
        } else if (plan.kind === 'downloads') {
          toast.show({ message: t('workspace.toast.noFolder'), duration: 8000 })
          setProgress({ kind: 'save', done: 0, total: targets.length, cancellable: true })
          report(
            await downloadEach(ticketBatch(source, targets, projectTitle), downloadBlob, {
              onProgress: onProgress(true),
              signal: ctl.signal,
            }),
            targets.length,
          )
        } else if (plan.kind === 'share') {
          // Render everything first (one canvas alive at a time), then share the files in as few sheets as possible.
          setProgress({ kind: 'save', done: 0, total: targets.length, cancellable: true })
          const files: File[] = []
          const batch = ticketBatch(source, targets, projectTitle)
          for (const [i, item] of batch.entries()) {
            if (ctl.signal.aborted) break
            files.push(new File([await item.render()], item.name, { type: 'image/png' }))
            onProgress(true)(i + 1, batch.length)
            await nextTurn()
          }
          if (ctl.signal.aborted) {
            report({ saved: 0, failed: [], cancelled: true }, targets.length)
          } else if (canShareFiles(chunkFiles(files)[0] ?? [])) {
            offerShare(chunkFiles(files), 0, files.length, navigator.userActivation?.isActive === true)
          } else {
            toast.show({ message: t('workspace.toast.shareFallback'), duration: 8000 })
            report(
              await downloadEach(
                files.map((f) => ({ name: f.name, render: async () => f })),
                downloadBlob,
                { onProgress: onProgress(true), signal: ctl.signal, gapMs: 700 },
              ),
              files.length,
            )
          }
        } else {
          if (plan.kind === 'zip' && plan.note) {
            toast.show({ message: t('workspace.toast.noFolderZip'), duration: 8000 })
          }
          if (targets.length > 1) setProgress({ kind: 'save', done: 0, total: targets.length })
          await saveTickets(source, targets, zipName(projectTitle), onProgress(false), projectTitle)
          toast.show({ message: t('workspace.toast.saved', { count: targets.length }) })
        }
      } catch (e) {
        toast.show({ message: errorText(e), tone: 'error' })
      } finally {
        busy.current = false
        abort.current = null
        if (alive.current) setProgress(null)
      }
    },
    [source, targets, projectTitle, toast, t, report, phone, offerShare],
  )

  const save = useCallback(() => runSave(saveMode), [runSave, saveMode])
  const saveAs = useCallback(
    (m: SaveMode) => {
      setSaveMode(m)
      return runSave(m)
    },
    [runSave, setSaveMode],
  )
  saveZipRef.current = () => runSave('zip')

  const cancel = useCallback(() => abort.current?.abort(), [])

  /** Renders the tickets, mounts them as hidden sheets and opens the print dialog without leaving the page. */
  const runPrint = useCallback(async () => {
    if (!source || targets.length === 0 || busy.current) {
      if (!source) toast.show({ message: t('workspace.toast.notReady'), tone: 'error' })
      return
    }
    busy.current = true
    const ctl = new AbortController()
    abort.current = ctl
    const rows = targets
    setProgress({ kind: 'print', done: 0, total: rows.length, cancellable: true })
    try {
      const blobs = await renderPrintBatch(
        source,
        rows,
        (done, total) => {
          if (alive.current) setProgress({ kind: 'print', done, total, cancellable: true })
        },
        () => ctl.signal.aborted,
      )
      if (ctl.signal.aborted || !alive.current) return
      dropSheets()
      sheetUrls.current = blobs.map((b) => URL.createObjectURL(b))
      printedIds.current = rows.map((r) => r.id)
      setSheets([...sheetUrls.current])
      if (isIOS()) {
        // Safari only prints from a user gesture, and the rendering above used it up.
        toast.show({
          message: t('workspace.print.ready', { count: rows.length, pages: paginate(rows.length).length }),
          action: { label: t('workspace.print.button'), onAction: () => void printSheets() },
          duration: 30_000,
        })
      }
    } catch (e) {
      toast.show({ message: errorText(e), tone: 'error' })
    } finally {
      busy.current = false
      abort.current = null
      if (alive.current) setProgress(null)
    }
  }, [source, targets, toast, t, dropSheets])
  const print = useCallback(() => void runPrint(), [runPrint])

  const printClosed = useCallback(() => {
    dropSheets()
    setSheets(null)
    // Only ids are sent; the dialog gives no way to tell printed from cancelled.
    void logPrinted(projectId, printedIds.current).catch(() => undefined)
  }, [dropSheets, projectId])

  return {
    progress,
    fallback,
    closeFallback: () => setFallback(null),
    copy,
    save,
    saveAs,
    saveMode,
    setSaveMode,
    cancel,
    print,
    sheets,
    printClosed,
    targetCount: targets.length,
  }
}
