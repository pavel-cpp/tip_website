import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { useToast } from '../../components/Toast'
import { useI18n } from '../../i18n'
import { errorText } from '../../i18n/apiError'
import type { Participant } from './api'
import { setPrintJob } from './printJob'
import { safeFilePart } from './tableLogic'
import { copyTicket, saveTickets, type TicketSource } from './ticketActions'

export interface Progress {
  kind: 'save'
  done: number
  total: number
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
  const busy = useRef(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const targets = selectedRows.length > 0 ? selectedRows : current ? [current] : []

  /** Must run synchronously inside the click/keydown handler (Safari clipboard rule). */
  const copy = useCallback(() => {
    if (!source || !current) {
      toast.show({ message: t('workspace.toast.notReady'), tone: 'error' })
      return
    }
    void copyTicket(source, current).then(async (res) => {
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
  }, [source, current, toast, t])

  const save = useCallback(async () => {
    if (!source || targets.length === 0 || busy.current) {
      if (!source) toast.show({ message: t('workspace.toast.notReady'), tone: 'error' })
      return
    }
    busy.current = true
    if (targets.length > 1) setProgress({ kind: 'save', done: 0, total: targets.length })
    try {
      await saveTickets(
        source,
        targets,
        zipName(projectTitle),
        (done, total) => {
          if (alive.current) setProgress({ kind: 'save', done, total })
        },
        projectTitle,
      )
      toast.show({ message: t('workspace.toast.saved', { count: targets.length }) })
    } catch (e) {
      toast.show({ message: errorText(e), tone: 'error' })
    } finally {
      busy.current = false
      if (alive.current) setProgress(null)
    }
  }, [source, targets, projectTitle, toast, t])

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
    print,
    targetCount: targets.length,
  }
}
