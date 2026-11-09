import { useQueryClient } from '@tanstack/react-query'
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { isApiError } from '../api/errors'
import { useAuth } from '../auth/AuthProvider'
import { useCan } from '../auth/guards'
import { AppLink } from '../components/AppLink'
import { Button } from '../components/Button'
import { Icon } from '../components/Icon'
import { Menu, type MenuItem } from '../components/Menu'
import { Modal } from '../components/Modal'
import { Panel } from '../components/Panel'
import { Skeleton, useSkeleton } from '../components/Skeleton'
import { Tabs } from '../components/Tabs'
import { useToast } from '../components/Toast'
import { Tooltip } from '../components/Tooltip'
import { TopbarPortal } from '../components/TopbarSlot'
import { type Project, useProject } from '../features/projects/api'
import { useAuthedImage } from '../features/projects/useAuthedImage'
import { FollowChip } from '../features/realtime/FollowChip'
import { followJump, peerStatus, spotlightCss } from '../features/realtime/follow'
import { RealtimeProvider, useRealtime } from '../features/realtime/RealtimeProvider'
import {
  downloadExport,
  type ExportFormat,
  type Participant,
  type ParticipantInput,
  participantKeys,
  useCreateParticipants,
  useDeleteParticipants,
  useParticipants,
  useUpdateParticipant,
} from '../features/workspace/api'
import { BulkBar } from '../features/workspace/BulkBar'
import { AddRowsDialog, CopyFallbackDialog, ImportDialog } from '../features/workspace/Dialogs'
import { folderSupported } from '../features/workspace/folderSave'
import { WsIcon, type WsIconName } from '../features/workspace/icons'
import { OfflineBanner, useConnectionDown } from '../features/workspace/OfflineBanner'
import { type CommitResult, ParticipantsTable } from '../features/workspace/ParticipantsTable'
import { PhoneToolbar } from '../features/workspace/PhoneToolbar'
import { copyShortcutLabel } from '../features/workspace/platform'
import type { RowLockOwner } from '../features/workspace/presence'
import { useRowPresence } from '../features/workspace/presence'
import { BIG_PRINT_THRESHOLD, estimateMs, formatDuration } from '../features/workspace/printEstimate'
import { stepRow } from '../features/workspace/rowStep'
import { SaveButton } from '../features/workspace/SaveButton'
import { HANDLE_PX, Splitter } from '../features/workspace/Splitter'
import { applyArrow, loadSplit, type SplitState, saveSplit, tracks } from '../features/workspace/split'
import { TicketPanel } from '../features/workspace/TicketPanel'
import { countSuspiciousPhones, filterRows, planPaste, safeFilePart } from '../features/workspace/tableLogic'
import { downloadBlob } from '../features/workspace/ticketActions'
import { useNarrow, useStacked } from '../features/workspace/useNarrow'
import { useTicketActions } from '../features/workspace/useTicketActions'
import { useUndoableDelete } from '../features/workspace/useUndoableDelete'
import { WorkspaceTopbar } from '../features/workspace/WorkspaceTopbar'
import { useI18n } from '../i18n'
import { errorText } from '../i18n/apiError'
import type { TicketPlaceholders } from '../lib/ticket'
import { useImageElement } from '../lib/ticket'
import '../features/workspace/workspace.css'
import '../features/workspace/workspace-mobile.css'

type PanelId = 'picture' | 'db'
const FRESH_MS = 1400
const NO_IDS: ReadonlySet<string> = new Set()

export default function Workspace() {
  const { id = '' } = useParams()
  const { t } = useI18n()
  const project = useProject(id)
  const showSkeleton = useSkeleton(project.isPending)

  if (project.isError) {
    return (
      <div className="state-box" role="alert">
        <h2>{t('workspace.error.title')}</h2>
        <p className="muted">{errorText(project.error)}</p>
        <div className="state-actions">
          <Button onClick={() => void project.refetch()}>{t('action.retry')}</Button>
          <AppLink to="/">{t('projects.title')}</AppLink>
        </div>
      </div>
    )
  }
  if (!project.data) {
    return showSkeleton ? (
      <div className="ws-skeleton" role="status" aria-label={t('state.loading')}>
        <Skeleton height={32} width="40%" />
        <Skeleton height={44} />
        <Skeleton height={420} radius={18} />
      </div>
    ) : null
  }
  return (
    <RealtimeProvider projectId={project.data.id}>
      <WorkspaceView project={project.data} />
    </RealtimeProvider>
  )
}

function ToolButton({
  label,
  hint,
  icon,
  variant = 'secondary',
  disabled,
  disabledReason,
  onClick,
  text,
  className,
}: {
  /** Visible text next to the icon; the accessible name stays `label`. */
  text?: string
  label: string
  hint?: string
  icon: WsIconName
  variant?: 'primary' | 'secondary' | 'ghost'
  disabled?: boolean
  disabledReason?: string
  onClick: () => void
  className?: string
}): ReactElement {
  return (
    <Tooltip
      content={disabled && disabledReason ? disabledReason : hint ? `${label} (${hint})` : label}
      side="bottom"
    >
      <Button
        variant={variant}
        className={className}
        iconOnly={!text}
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
      >
        <WsIcon name={icon} />
        {text && <span className="ws-tool-text">{text}</span>}
      </Button>
    </Tooltip>
  )
}

function WorkspaceView({ project }: { project: Project }) {
  const { t, formatNumber } = useI18n()
  const toast = useToast()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { user } = useAuth()
  const finished = project.status === 'finished'
  const canView = useCan('participant.view')
  const canEditPerm = useCan('participant.edit')
  const canDeletePerm = useCan('participant.delete')
  const canPrint = useCan('participant.print')
  const canExport = useCan('participant.export')
  const canImportPerm = useCan('participant.import')
  const canSettings = useCan('project.update')
  const canEdit = canEditPerm && !finished
  const canDelete = canDeletePerm && !finished
  const canImport = canImportPerm && !finished

  const narrow = useNarrow()
  // Phone selection mode: its bulk bar takes the bottom toolbar's place.
  const [selectMode, setSelectMode] = useState(false)

  // Lifts toasts above the table footer / bottom bar (see workspace.css).
  useEffect(() => {
    document.body.dataset.workspace = ''
    return () => {
      delete document.body.dataset.workspace
    }
  }, [])

  // ---- data
  const list = useParticipants(project.id, canView)
  const allRows = list.data?.items
  const del = useDeleteParticipants(project.id)
  const undoable = useUndoableDelete({
    commit: (ids) => del.mutateAsync(ids),
    onFailed: (_ids, e) => toast.show({ message: errorText(e), tone: 'error' }),
  })
  const rows = useMemo(
    () => (allRows ?? []).filter((r) => !undoable.hidden.has(r.id)),
    [allRows, undoable.hidden],
  )
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [currentId, setCurrentId] = useState<string | null>(null)
  const firstVisible = useMemo(() => filterRows(rows, query)[0], [rows, query])
  const current = rows.find((r) => r.id === currentId) ?? firstVisible ?? null
  // Only rows the search leaves visible count as selected, so print/save never act on hidden rows.
  const selectedRows = useMemo(
    () => filterRows(rows, query).filter((r) => selected.has(r.id)),
    [rows, query, selected],
  )

  const presence = useRowPresence(project.id)
  const rtSnapshot = useRealtime()?.snapshot
  const hasOnline = (rtSnapshot?.peers ?? []).some((p) => p.id !== rtSnapshot?.you)
  const remoteLeaving = useRealtime()?.leaving
  const remoteFresh = useRealtime()?.remoteFresh
  const leavingAll = useMemo(
    () => (remoteLeaving?.size ? new Set([...undoable.leaving, ...remoteLeaving]) : undoable.leaving),
    [undoable.leaving, remoteLeaving],
  )
  const people = useMemo(() => {
    const m = new Map<string, RowLockOwner>()
    for (const c of project.contributors) m.set(c.id, c)
    return m
  }, [project.contributors])

  // ---- ticket source
  const blobUrl = useAuthedImage(project.image?.url)
  const imageEl = useImageElement(blobUrl)
  const source = useMemo(
    () => (imageEl ? { image: imageEl, placeholders: project.placeholders as TicketPlaceholders } : null),
    [imageEl, project.placeholders],
  )
  const actions = useTicketActions({
    projectId: project.id,
    projectTitle: project.title,
    source,
    current,
    selectedRows,
  })

  // Cmd/Ctrl+C copies the ticket unless the user is copying text out of a field.
  const copyRef = useRef(actions.copy)
  copyRef.current = actions.copy
  useEffect(() => {
    if (!canPrint) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'c' || e.shiftKey || e.altKey || !(e.metaKey || e.ctrlKey)) return
      const el = document.activeElement
      const typing =
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        (el as HTMLElement | null)?.isContentEditable
      if (typing || (window.getSelection()?.toString() ?? '') !== '') return
      e.preventDefault()
      copyRef.current()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [canPrint])

  // ---- mutations
  const update = useUpdateParticipant(project.id)
  const create = useCreateParticipants(project.id)
  const chains = useRef(new Map<string, Promise<unknown>>())
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set())
  const [reveal, setReveal] = useState<string | null>(null)
  // Rows added by colleagues glow in the accent colour (the frame does not say who added them).
  const freshAll = useMemo(
    () => (remoteFresh?.size ? new Set([...fresh, ...remoteFresh]) : fresh),
    [fresh, remoteFresh],
  )
  const freshTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(freshTimer.current), [])

  const [pending, setPending] = useState<ReadonlySet<string>>(new Set())
  const pendingCount = useRef(new Map<string, number>())
  const track = useCallback((id: string, delta: 1 | -1) => {
    const n = (pendingCount.current.get(id) ?? 0) + delta
    if (n > 0) pendingCount.current.set(id, n)
    else pendingCount.current.delete(id)
    setPending(new Set(pendingCount.current.keys()))
  }, [])
  const down = useConnectionDown()
  // The failure toast of a row goes away as soon as a retry of that row succeeds.
  const failToasts = useRef(new Map<string, number>())
  const clearFailToast = useCallback(
    (rowId: string) => {
      const id = failToasts.current.get(rowId)
      if (id === undefined) return
      failToasts.current.delete(rowId)
      toast.dismiss(id)
    },
    [toast],
  )

  const attempt = useCallback(
    async (row: Participant, patch: { name?: string; phone?: string }): Promise<CommitResult> => {
      try {
        await update.mutateAsync({ id: row.id, version: row.version, ...patch })
        clearFailToast(row.id)
        return { status: 'ok' }
      } catch (e) {
        if (isApiError(e)) {
          if (e.code === 'VERSION_CONFLICT' && e.details?.current) {
            return { status: 'conflict', current: e.details.current as unknown as Participant }
          }
          if (e.code === 'ROW_LOCKED') return { status: 'locked', by: e.details?.by as string | undefined }
        }
        clearFailToast(row.id)
        failToasts.current.set(
          row.id,
          toast.show({
            message: t('workspace.toast.saveFailed', { number: row.number, reason: errorText(e) }),
            tone: 'error',
          }),
        )
        return { status: 'error' }
      }
    },
    [update, toast, t, clearFailToast],
  )

  // Edits of one row run one after another so each PATCH carries the version the previous one produced.
  const commit = useCallback(
    (row: Participant, patch: { name?: string; phone?: string }): Promise<CommitResult> => {
      const previous = chains.current.get(row.id) ?? Promise.resolve()
      track(row.id, 1)
      const run = previous
        .catch(() => undefined)
        .then(() => {
          const cached = qc.getQueryData<{ items: Participant[] }>(participantKeys.list(project.id))
          const latest = cached?.items.find((r) => r.id === row.id)
          return attempt(latest && latest.version > row.version ? latest : row, patch)
        })
        .finally(() => track(row.id, -1))
      chains.current.set(row.id, run)
      return run
    },
    [attempt, qc, project.id, track],
  )

  const adopt = useCallback(
    (row: Participant) =>
      qc.setQueryData<{ items: Participant[]; rev: number }>(participantKeys.list(project.id), (l) =>
        l ? { ...l, items: l.items.map((r) => (r.id === row.id ? row : r)) } : l,
      ),
    [qc, project.id],
  )

  // Moving the cursor to the first new row must wait until a closing dialog has given focus back.
  const pendingFocus = useRef(false)
  const [focusNonce, setFocusNonce] = useState(0)

  /** Points the ticket, the selection and the table cursor at one row (after a paste or on "Show"). */
  const follow = useCallback(
    (id: string) => {
      setCurrentId(id)
      // On phones the selection is a separate mode; the ticket and the print target follow the current row.
      if (!narrow) setSelected(new Set([id]))
      setReveal(id)
      pendingFocus.current = true
      setFocusNonce((n) => n + 1)
    },
    [narrow],
  )

  const addRows = useCallback(
    async (
      vars: { count: number } | { items: ParticipantInput[] },
      filled?: { count: number; firstId: string; firstNumber: number },
    ) => {
      try {
        const created = await create.mutateAsync(vars)
        setFresh(new Set(created.map((r) => r.id)))
        clearTimeout(freshTimer.current)
        freshTimer.current = setTimeout(() => setFresh(new Set()), FRESH_MS)
        const first = filled?.firstId ?? created[0]?.id
        if (first && 'items' in vars) {
          follow(first)
        } else if (first) {
          setReveal(first)
          pendingFocus.current = true
        }
        const firstNumber = filled?.firstNumber ?? created[0]?.number
        if (first && 'items' in vars && firstNumber !== undefined) {
          toast.show({
            message: t('workspace.toast.pasted', {
              count: created.length + (filled?.count ?? 0),
              number: firstNumber,
            }),
            action: { label: t('workspace.toast.show'), onAction: () => follow(first) },
          })
        } else {
          toast.show({
            message: t('workspace.toast.added', { count: created.length + (filled?.count ?? 0) }),
          })
        }
        return true
      } catch (e) {
        toast.show({ message: errorText(e), tone: 'error' })
        return false
      }
    },
    [create, toast, t, follow],
  )

  // Pasted rows fill blank rows first (starting at the current one) and only the rest is appended.
  const pasteRows = useCallback(
    async (items: ParticipantInput[]) => {
      const plan = planPaste(rows, items, currentId)
      if (plan.fills.length === 0) {
        void addRows({ items })
        return
      }
      const results = await Promise.all(
        plan.fills.map((f) => commit(f.row, { name: f.item.name, phone: f.item.phone })),
      )
      const ok = plan.fills.filter((_, i) => results[i]?.status === 'ok')
      const first = ok[0]?.row
      const filled = first ? { count: ok.length, firstId: first.id, firstNumber: first.number } : undefined
      if (plan.rest.length > 0) {
        await addRows({ items: plan.rest }, filled)
        if (filled) follow(filled.firstId)
      } else if (filled) {
        follow(filled.firstId)
        toast.show({
          message: t('workspace.toast.pasted', { count: filled.count, number: filled.firstNumber }),
          action: { label: t('workspace.toast.show'), onAction: () => follow(filled.firstId) },
        })
      }
    },
    [rows, currentId, addRows, commit, toast, t, follow],
  )

  const onDelete = useCallback(
    (ids: string[]) => {
      if (ids.length === 0 || !canDelete) return
      const token = undoable.request(ids)
      toast.show({
        message: t('toast.rowsDeleted', { count: ids.length }),
        action: { label: t('action.undo'), onAction: () => undoable.undo(token) },
        duration: 5000,
      })
      setSelected(new Set())
    },
    [canDelete, undoable, toast, t],
  )

  // ---- dialogs and layout
  const [addOpen, setAddOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  useEffect(() => {
    if (addOpen || !pendingFocus.current) return
    pendingFocus.current = false
    setFocusNonce((n) => n + 1)
  }, [addOpen, reveal])
  const [tab, setTab] = useState<PanelId>('picture')
  const stacked = useStacked()
  const userId = user?.id ?? 'anon'
  const [split, setSplit] = useState<SplitState>(() => loadSplit(userId))
  const [dragging, setDragging] = useState(false)
  const gridRef = useRef<HTMLDivElement>(null)
  // Persisted once a drag is over, not on every pointer move.
  useEffect(() => {
    if (!dragging) saveSplit(userId, split)
  }, [split, dragging, userId])
  // On phones the tabs decide what is shown; the splitter state only applies to wider screens.
  const visible = (p: PanelId) =>
    narrow ? tab === p : split.collapsed !== (p === 'picture' ? 'first' : 'second')
  const pictureOnly = !narrow && split.collapsed === 'second'

  // Previous/next participant in picture-only mode (the table is hidden, so the arrows replace it).
  const shownRows = useMemo(() => filterRows(rows, query), [rows, query])
  const prevRow = stepRow(shownRows, current?.id ?? null, -1)
  const nextRow = stepRow(shownRows, current?.id ?? null, 1)
  const stepTo = useCallback((row: Participant | null) => {
    if (!row) return
    setCurrentId(row.id)
    setSelected(new Set([row.id]))
    setReveal(row.id)
  }, [])
  const stepRef = useRef({ prev: prevRow, next: nextRow, go: stepTo })
  stepRef.current = { prev: prevRow, next: nextRow, go: stepTo }
  useEffect(() => {
    if (!pictureOnly) return
    const onKey = (e: KeyboardEvent) => {
      if (
        (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') ||
        e.metaKey ||
        e.ctrlKey ||
        e.altKey ||
        e.shiftKey
      ) {
        return
      }
      const el = e.target instanceof HTMLElement ? e.target : null
      if (
        el?.closest(
          'input, textarea, select, [contenteditable="true"], [role="menu"], [role="dialog"], [role="tablist"]',
        )
      ) {
        return
      }
      e.preventDefault()
      stepRef.current.go(e.key === 'ArrowLeft' ? stepRef.current.prev : stepRef.current.next)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [pictureOnly])

  // ---- colleagues: jump to their row, optionally follow them
  const [watch, setWatch] = useState<{ id: string; following: boolean } | null>(null)
  const lastAuto = useRef<string | null>(null)
  const watchedPeer = watch ? rtSnapshot?.peers.find((p) => p.id === watch.id) : undefined
  const watchStatus = useMemo(
    () => (watch && rtSnapshot ? peerStatus(watch.id, rtSnapshot.cursors, rtSnapshot.locks) : null),
    [watch, rtSnapshot],
  )
  const jumpTo = useCallback(
    (rowId: string) => {
      lastAuto.current = rowId
      // A search that hides the row, or a hidden ticket panel, would defeat the jump.
      if (!filterRows(rows, query).some((r) => r.id === rowId)) setQuery('')
      setSplit((s) => (s.collapsed === 'first' ? { ...s, collapsed: null } : s))
      follow(rowId)
    },
    [rows, query, follow],
  )
  const selectPeer = (id: string) => {
    if (watch?.id === id) {
      setWatch(watch.following ? { id, following: false } : null)
      return
    }
    setWatch({ id, following: false })
    const st = rtSnapshot ? peerStatus(id, rtSnapshot.cursors, rtSnapshot.locks) : null
    lastAuto.current = null
    if (st?.rowId && rows.some((r) => r.id === st.rowId)) jumpTo(st.rowId)
  }
  const toggleFollow = () => {
    lastAuto.current = null
    setWatch((w) => (w ? { ...w, following: !w.following } : w))
  }
  const following = !!watch?.following
  const watchRowId = watchStatus?.rowId ?? null
  useEffect(() => {
    if (!following) return
    const target = followJump(watchRowId, lastAuto.current, (rid) => rows.some((r) => r.id === rid))
    if (target) jumpTo(target)
  }, [following, watchRowId, rows, jumpTo])
  // Moving somewhere else by hand ends the following.
  const seenCurrent = useRef(currentId)
  useEffect(() => {
    // Only a change of the current row counts; our own jump sets `lastAuto` first, so it never matches here.
    if (currentId === seenCurrent.current) return
    seenCurrent.current = currentId
    if (following && currentId !== lastAuto.current) {
      setWatch((w) => (w ? { ...w, following: false } : w))
    }
  }, [following, currentId])
  // The colleague went offline.
  const rtOnline = rtSnapshot?.state === 'online'
  useEffect(() => {
    if (watch && rtOnline && !watchedPeer) setWatch(null)
  }, [watch, rtOnline, watchedPeer])
  useEffect(() => {
    if (!watch) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      setWatch((w) => (w?.following ? { ...w, following: false } : null))
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [watch])

  const exportFile = async (format: ExportFormat) => {
    try {
      downloadBlob(
        await downloadExport(project.id, format),
        `${safeFilePart(project.title, 80) || 'participants'}.${format}`,
      )
    } catch (e) {
      toast.show({ message: errorText(e), tone: 'error' })
    }
  }

  const printTargets = selectedRows.length > 0 ? selectedRows : current ? [current] : []
  const [printWarn, setPrintWarn] = useState<{ bad: number; total: number } | null>(null)
  const [printBig, setPrintBig] = useState<number | null>(null)
  // A huge batch takes minutes to render, so say so before the page turns into a progress bar.
  const startPrint = () => {
    if (printTargets.length > BIG_PRINT_THRESHOLD) setPrintBig(printTargets.length)
    else actions.print()
  }
  const onPrint = () => {
    const bad = countSuspiciousPhones(printTargets)
    if (bad > 0) setPrintWarn({ bad, total: printTargets.length })
    else startPrint()
  }

  const shortcut = copyShortcutLabel()
  const printLabel =
    actions.targetCount > 0
      ? t('workspace.print.withCount', { count: actions.targetCount })
      : t('workspace.print')
  const noPrintReason = !project.image
    ? t('workspace.noImageReason')
    : !current
      ? t('workspace.noRowsReason')
      : undefined
  const notReadyReason = noPrintReason ?? (source ? undefined : t('workspace.toast.notReady'))
  const copyLabel =
    actions.targetCount > 1 ? t('workspace.copy.many', { count: actions.targetCount }) : t('workspace.copy')
  const saveLabel =
    actions.targetCount > 1 ? t('workspace.save.many', { count: actions.targetCount }) : t('workspace.save')
  // On phones Copy and Save sit in the bar; print, import, export and settings are in the menu.
  const phoneItems: MenuItem[] = []
  if (canPrint) {
    phoneItems.push({
      id: 'print',
      label: printLabel,
      disabled: !!noPrintReason,
      disabledReason: noPrintReason,
      onSelect: onPrint,
    })
  }
  if (canImport) {
    phoneItems.push({
      id: 'import',
      label: t('workspace.import'),
      separatorBefore: phoneItems.length > 0,
      onSelect: () => setImportOpen(true),
    })
  }
  if (canExport) {
    phoneItems.push(
      {
        id: 'xlsx',
        label: t('workspace.exportAs.xlsx'),
        separatorBefore: !canImport && phoneItems.length > 0,
        onSelect: () => void exportFile('xlsx'),
      },
      { id: 'csv', label: t('workspace.exportAs.csv'), onSelect: () => void exportFile('csv') },
    )
  }
  if (canSettings) {
    phoneItems.push({
      id: 'settings',
      label: t('workspace.settings'),
      separatorBefore: phoneItems.length > 0,
      onSelect: () => void navigate(`/projects/${project.id}/settings`, { viewTransition: true }),
    })
  }
  const topbarContent = (
    <WorkspaceTopbar
      title={project.title}
      contributors={project.contributors}
      hasOnline={hasOnline}
      watchedId={watch?.id ?? null}
      onSelectPeer={selectPeer}
    />
  )
  const names = { first: t('workspace.panel.picture'), second: t('workspace.panel.db') }

  const dbPanel = (
    <Panel title={t('workspace.panel.db')} icon="users" className="ws-panel">
      {canView ? (
        <ParticipantsTable
          rows={rows}
          loading={list.isPending}
          error={
            list.isError ? (
              <>
                <h3 className="pt-state-title">{t('workspace.loadError.title')}</h3>
                <p className="muted">{errorText(list.error)}</p>
                <Button onClick={() => void list.refetch()} loading={list.isFetching}>
                  {t('action.retry')}
                </Button>
              </>
            ) : undefined
          }
          canEdit={canEdit}
          canDelete={canDelete}
          selected={selected}
          onSelectedChange={setSelected}
          currentId={current?.id ?? null}
          onCurrentChange={setCurrentId}
          leaving={leavingAll}
          freshIds={freshAll}
          freshColor={remoteFresh?.size ? undefined : user?.color}
          presence={presence}
          people={people}
          onCommit={commit}
          onAdopt={adopt}
          onDelete={onDelete}
          onAddRows={() => setAddOpen(true)}
          onPasteRows={(items) => void pasteRows(items)}
          revealId={reveal}
          focusNonce={focusNonce}
          unsentIds={down ? pending : NO_IDS}
          query={query}
          onQueryChange={setQuery}
          cards={narrow}
          onNotify={(message) => toast.show({ message })}
          selectMode={selectMode}
          onSelectModeChange={setSelectMode}
          sheetPreview={(row) => (
            <TicketPanel
              compact
              image={imageEl}
              imageLoading={!!project.image && !imageEl}
              hasProjectImage={!!project.image}
              placeholders={project.image ? (project.placeholders as TicketPlaceholders) : null}
              participant={row}
            />
          )}
        />
      ) : (
        <p className="muted pt-state">{t('errors.FORBIDDEN')}</p>
      )}
    </Panel>
  )

  const picturePanel = (
    <Panel title={t('workspace.panel.picture')} icon="pencil" className="ws-panel">
      <TicketPanel
        image={imageEl}
        imageLoading={!!project.image && !imageEl}
        hasProjectImage={!!project.image}
        placeholders={project.image ? (project.placeholders as TicketPlaceholders) : null}
        participant={current}
        emptyReason={list.isError ? 'error' : rows.length === 0 && !list.isPending ? 'no-rows' : 'select'}
        onRetry={() => void list.refetch()}
        settingsTo={canSettings ? `/projects/${project.id}/settings` : undefined}
        nav={
          pictureOnly
            ? {
                hasPrev: !!prevRow,
                hasNext: !!nextRow,
                onPrev: () => stepTo(prevRow),
                onNext: () => stepTo(nextRow),
              }
            : undefined
        }
      />
    </Panel>
  )

  const peerColor = watchedPeer?.color ?? ''

  return (
    <div className="ws" data-tab={tab}>
      {/* The page heading for assistive technology and the document title; the visible path is in the top bar. */}
      <h1 className="sr-only">{project.title}</h1>
      <TopbarPortal fallback={<div className="ws-head">{topbarContent}</div>}>{topbarContent}</TopbarPortal>
      <OfflineBanner down={down} />

      {finished && (
        <p className="ws-banner" role="status">
          <Icon name="lock" size={16} />
          {t('workspace.finished')}
        </p>
      )}

      {narrow ? (
        selectMode ? (
          <BulkBar
            count={selectedRows.length}
            canPrint={canPrint}
            printBlocked={project.image ? undefined : t('workspace.noImageReason')}
            canDelete={canDelete}
            copyReady={!!source && selectedRows.length >= 1}
            saveReady={!!source}
            onPrint={onPrint}
            onCopy={actions.copy}
            onSave={() => void actions.save()}
            onDelete={() => {
              onDelete(selectedRows.map((r) => r.id))
              setSelectMode(false)
            }}
            onDone={() => {
              setSelectMode(false)
              setSelected(new Set())
            }}
          />
        ) : (
          <PhoneToolbar
            canPrint={canPrint}
            copyLabel={copyLabel}
            saveLabel={saveLabel}
            disabledReason={notReadyReason}
            items={phoneItems}
            onCopy={actions.copy}
            onSave={() => void actions.save()}
          />
        )
      ) : (
        <div className="ws-toolbar" role="toolbar" aria-label={t('workspace.toolbar')}>
          {canPrint && (
            <>
              <ToolButton
                icon="copy"
                variant="primary"
                label={copyLabel}
                text={copyLabel}
                hint={`${shortcut}+C`}
                disabled={!current || !source}
                disabledReason={notReadyReason}
                onClick={actions.copy}
              />
              <SaveButton
                count={actions.targetCount}
                mode={actions.saveMode}
                folderSupported={folderSupported()}
                disabled={!current || !source}
                disabledReason={notReadyReason}
                onSave={() => void actions.save()}
                onSaveAs={(m) => void actions.saveAs(m)}
              />
            </>
          )}
          {(canImport || canExport) && <span className="ws-sep" aria-hidden="true" />}
          {canImport && (
            <ToolButton
              icon="upload"
              variant="ghost"
              label={t('workspace.import')}
              text={t('workspace.import')}
              onClick={() => setImportOpen(true)}
            />
          )}
          {canExport && (
            <Menu
              label={t('workspace.export')}
              items={[
                { id: 'xlsx', label: t('workspace.export.xlsx'), onSelect: () => void exportFile('xlsx') },
                { id: 'csv', label: t('workspace.export.csv'), onSelect: () => void exportFile('csv') },
              ]}
              trigger={(props) => (
                <Tooltip content={t('workspace.export')} side="bottom">
                  <Button {...props} variant="ghost" aria-label={t('workspace.export')}>
                    <WsIcon name="exportTable" />
                    <span className="ws-tool-text">{t('workspace.export')}</span>
                  </Button>
                </Tooltip>
              )}
            />
          )}
          {canPrint && (
            <>
              <span className="ws-sep" aria-hidden="true" />
              <ToolButton
                icon="print"
                variant="ghost"
                className="ws-print"
                label={printLabel}
                text={printLabel}
                disabled={!current || !project.image}
                disabledReason={noPrintReason}
                onClick={onPrint}
              />
            </>
          )}
          {canSettings && (
            <>
              <span className="ws-sep" aria-hidden="true" />
              <ToolButton
                icon="gear"
                variant="ghost"
                label={t('workspace.settings')}
                text={t('workspace.settings.short')}
                onClick={() => void navigate(`/projects/${project.id}/settings`, { viewTransition: true })}
              />
            </>
          )}
          <span className="spacer" />
          {canPrint && (
            <span className="ws-hint">
              {t('workspace.copyHint')} <kbd>{shortcut}</kbd>+<kbd>C</kbd>
            </span>
          )}
        </div>
      )}

      {watch && watchedPeer && watchStatus && (
        <FollowChip
          peer={watchedPeer}
          status={watchStatus}
          rowNumber={rows.find((r) => r.id === watchStatus.rowId)?.number ?? null}
          following={following}
          onToggleFollow={toggleFollow}
          onClose={() => setWatch(null)}
        />
      )}
      {watchedPeer && watchRowId && <style>{spotlightCss(watchRowId, peerColor)}</style>}

      {actions.progress && (
        <div className="ws-progress" role="status">
          <div
            className="ws-progress-bar"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={actions.progress.total}
            aria-valuenow={actions.progress.done}
            aria-label={t(
              actions.progress.kind === 'copy' ? 'workspace.progress.copy' : 'workspace.progress.save',
            )}
          >
            <span style={{ transform: `scaleX(${actions.progress.done / actions.progress.total})` }} />
          </div>
          <span className="muted">
            {t('workspace.progress.count', {
              done: formatNumber(actions.progress.done),
              total: formatNumber(actions.progress.total),
            })}
          </span>
          {actions.progress.cancellable && (
            <Button size="sm" variant="ghost" onClick={actions.cancel}>
              {t('action.cancel')}
            </Button>
          )}
        </div>
      )}

      {narrow && (
        <Tabs
          tabs={[
            { id: 'picture', label: t('workspace.panel.picture') },
            { id: 'db', label: t('workspace.panel.db') },
          ]}
          value={tab}
          onChange={(v) => setTab(v as PanelId)}
          label={t('workspace.tabs')}
        />
      )}

      <div
        className="ws-grid"
        ref={gridRef}
        data-dragging={dragging || undefined}
        data-collapsed={narrow ? undefined : (split.collapsed ?? undefined)}
        style={
          narrow
            ? undefined
            : stacked
              ? { gridTemplateRows: tracks(split, HANDLE_PX) }
              : { gridTemplateColumns: tracks(split, HANDLE_PX) }
        }
      >
        <div
          className="ws-slot"
          data-panel="picture"
          aria-hidden={!visible('picture') || undefined}
          inert={!visible('picture')}
        >
          {picturePanel}
        </div>
        {!narrow && (
          <Splitter
            orientation={stacked ? 'vertical' : 'horizontal'}
            ratio={split.ratio}
            collapsed={split.collapsed}
            gridRef={gridRef}
            names={names}
            onRatio={(ratio) => setSplit((s) => ({ ...s, ratio }))}
            onDragging={setDragging}
            onArrow={(side) => setSplit((s) => ({ ...s, collapsed: applyArrow(s.collapsed, side) }))}
            onReset={() => setSplit({ ratio: 0.5, collapsed: null })}
          />
        )}
        <div
          className="ws-slot"
          data-panel="db"
          aria-hidden={!visible('db') || undefined}
          inert={!visible('db')}
        >
          {dbPanel}
        </div>
      </div>

      <AddRowsDialog
        open={addOpen}
        busy={create.isPending}
        onClose={() => setAddOpen(false)}
        onSubmit={async (count) => {
          if (await addRows({ count })) setAddOpen(false)
        }}
      />
      <ImportDialog
        open={importOpen}
        projectId={project.id}
        onClose={() => setImportOpen(false)}
        onDone={(res) => {
          setImportOpen(false)
          toast.show({ message: t('workspace.toast.imported', { count: res.imported }) })
          void qc.invalidateQueries({ queryKey: participantKeys.list(project.id) })
          void qc.invalidateQueries({ queryKey: ['projects', 'detail', project.id] })
        }}
      />
      <Modal
        open={printWarn !== null}
        onClose={() => setPrintWarn(null)}
        title={t('workspace.printWarn.title')}
        actions={
          <>
            <Button variant="ghost" data-autofocus onClick={() => setPrintWarn(null)}>
              {t('workspace.printWarn.cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setPrintWarn(null)
                startPrint()
              }}
            >
              {t('workspace.printWarn.continue')}
            </Button>
          </>
        }
      >
        <p>{t('workspace.printWarn.body', { count: printWarn?.bad ?? 0, total: printWarn?.total ?? 0 })}</p>
      </Modal>
      <Modal
        open={printBig !== null}
        onClose={() => setPrintBig(null)}
        title={t('workspace.printBig.title')}
        actions={
          <>
            <Button variant="ghost" data-autofocus onClick={() => setPrintBig(null)}>
              {t('workspace.printBig.cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setPrintBig(null)
                actions.print()
              }}
            >
              {t('workspace.printBig.continue')}
            </Button>
          </>
        }
      >
        <p>
          {t('workspace.printBig.body', {
            count: printBig ?? 0,
            time: formatDuration(estimateMs(printBig ?? 0), t),
          })}
        </p>
      </Modal>
      <CopyFallbackDialog blob={actions.fallback} onClose={actions.closeFallback} />
    </div>
  )
}
