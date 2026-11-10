import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { useToast } from '../../components/Toast'
import { useI18n } from '../../i18n'
import { errorText } from '../../i18n/apiError'
import type { Participant } from './api'
import { COPY_CAP } from './clipboardPayload'
import {
  downloadEach,
  folderSupported,
  loadSaveMode,
  pickFolder,
  planSave,
  type SaveMode,
  storeSaveMode,
  writeToFolder,
} from './folderSave'
import { isIOS } from './platform'
import { setPrintJob } from './printJob'
import { safeFilePart } from './tableLogic'
import {
  copyTicket,
  copyTickets,
  downloadBlob,
  nextTurn,
  saveTickets,
  type TicketSource,
  ticketBatch,
} from './ticketActions'

export interface Progress {
  kind: 'save' | 'copy'
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
}

const zipName = (title: string) => `${safeFilePart(title) || 'tickets'}.zip`

/** Copy / save / print behaviour behind the workspace toolbar. All of it is gated by participant.print upstream. */
export function useTicketActions({ projectId, projectTitle, source, current, selectedRows }: Args) {
  const { t } = useI18n()
  const toast = useToast()
  const navigate = useNavigate()
  const [progress, setProgress] = useState<Progress | null>(null)
  const [fallback, setFallback] = useState<Blob | null>(null)
  const [saveMode, setSaveModeState] = useState<SaveMode>(loadSaveMode)
  const busy = useRef(false)
  const alive = useRef(true)
  const abort = useRef<AbortController | null>(null)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      abort.current?.abort()
    }
  }, [])

  const targets = selectedRows.length > 0 ? selectedRows : current ? [current] : []
  const setSaveMode = useCallback((m: SaveMode) => {
    storeSaveMode(m)
    setSaveModeState(m)
  }, [])

  const saveZipRef = useRef<() => Promise<void>>(async () => undefined)
  const toZip = useCallback(
    () => ({ label: t('workspace.copy.zip'), onAction: () => void saveZipRef.current() }),
    [t],
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
          toast.show({ message: t('workspace.toast.copyManyFailed'), tone: 'error', action: toZip() })
          return
        }
        toast.show({
          message:
            t('workspace.toast.copiedMany', { count: res.count }) +
            (res.skipped > 0
              ? ` ${t('workspace.toast.copyCapped', { cap: COPY_CAP, skipped: res.skipped })}`
              : ''),
          // Pasting HTML into a plain image field gives only one picture, so the ZIP is always on offer.
          action: toZip(),
          duration: 9000,
        })
      })
      return
    }
    void copyTicket(source, first).then(async (res) => {
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
  }, [source, targets, toast, t, toZip])

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

  const runSave = useCallback(
    async (mode: SaveMode) => {
      if (!source || targets.length === 0 || busy.current) {
        if (!source) toast.show({ message: t('workspace.toast.notReady'), tone: 'error' })
        return
      }
      const plan = planSave(targets.length, mode, { folder: folderSupported(), ios: isIOS() })
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
    [source, targets, projectTitle, toast, t, report],
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

  const print = useCallback(() => {
    if (targets.length === 0) return
    setPrintJob({ projectId, ids: targets.map((r) => r.id) })
    void navigate(`/projects/${projectId}/print`)
  }, [targets, projectId, navigate])

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
    targetCount: targets.length,
  }
}
