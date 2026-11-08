import { useQueryClient } from '@tanstack/react-query'
import { type ReactElement, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { isApiError } from '../api/errors'
import { useAuth } from '../auth/AuthProvider'
import { useCan } from '../auth/guards'
import { AppLink } from '../components/AppLink'
import { AvatarStack } from '../components/Avatar'
import { Button } from '../components/Button'
import { Icon } from '../components/Icon'
import { Menu, type MenuItem } from '../components/Menu'
import { Modal } from '../components/Modal'
import { Panel } from '../components/Panel'
import { Skeleton, useSkeleton } from '../components/Skeleton'
import { Tabs } from '../components/Tabs'
import { useToast } from '../components/Toast'
import { Tooltip } from '../components/Tooltip'
import { type Project, useProject } from '../features/projects/api'
import { useAuthedImage } from '../features/projects/useAuthedImage'
import { RealtimeProvider, useRealtime } from '../features/realtime/RealtimeProvider'
import { OnlineAvatars } from '../features/realtime/RealtimeStatus'
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
import { WsIcon, type WsIconName } from '../features/workspace/icons'
import { OfflineBanner, useConnectionDown } from '../features/workspace/OfflineBanner'
import { type CommitResult, ParticipantsTable } from '../features/workspace/ParticipantsTable'
import { PhoneToolbar } from '../features/workspace/PhoneToolbar'
import { copyShortcutLabel } from '../features/workspace/platform'
import type { RowLockOwner } from '../features/workspace/presence'
import { useRowPresence } from '../features/workspace/presence'
import { BIG_PRINT_THRESHOLD, estimateMs, formatDuration } from '../features/workspace/printEstimate'
import { TicketPanel } from '../features/workspace/TicketPanel'
import { countSuspiciousPhones, filterRows, planPaste, safeFilePart } from '../features/workspace/tableLogic'
import { downloadBlob } from '../features/workspace/ticketActions'
import { useNarrow } from '../features/workspace/useNarrow'
import { useTicketActions } from '../features/workspace/useTicketActions'
import { useUndoableDelete } from '../features/workspace/useUndoableDelete'
import { useI18n } from '../i18n'
import { errorText } from '../i18n/apiError'
import { readStorage, writeStorage } from '../lib/storage'
import { imageSize, TICKET_ASPECT, type TicketPlaceholders, useImageElement } from '../lib/ticket'
import '../features/workspace/workspace.css'
import '../features/workspace/workspace-mobile.css'

type PanelId = 'picture' | 'db'
interface Layout {
  max: PanelId | null
  closed: Record<PanelId, boolean>
}
const LAYOUT_KEY = 'tip.workspace.layout'
const DEFAULT_LAYOUT: Layout = { max: null, closed: { picture: false, db: false } }
const FRESH_MS = 1400
const NO_IDS: ReadonlySet<string> = new Set()

function loadLayout(): Layout {
  try {
    const raw = readStorage(LAYOUT_KEY)
    if (!raw) return DEFAULT_LAYOUT
    const v = JSON.parse(raw) as Partial<Layout>
    return {
      max: v.max === 'picture' || v.max === 'db' ? v.max : null,
      closed: { picture: !!v.closed?.picture, db: !!v.closed?.db },
    }
  } catch {
    return DEFAULT_LAYOUT
  }
}

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
}: {
  /** Visible text next to the icon; the accessible name stays `label`. */
  text?: string
  label: string
  hint?: string
  icon: WsIconName | 'settings'
  variant?: 'primary' | 'secondary' | 'ghost'
  disabled?: boolean
  disabledReason?: string
  onClick: () => void
}): ReactElement {
  return (
    <Tooltip
      content={disabled && disabledReason ? disabledReason : hint ? `${label} (${hint})` : label}
      side="bottom"
    >
      <Button variant={variant} iconOnly={!text} aria-label={label} disabled={disabled} onClick={onClick}>
        {icon === 'settings' ? <Icon name="settings" /> : <WsIcon name={icon} />}
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
  const [layout, setLayout] = useState<Layout>(loadLayout)
  const [tab, setTab] = useState<PanelId>('picture')
  const updateLayout = (fn: (l: Layout) => Layout) =>
    setLayout((l) => {
      const next = fn(l)
      writeStorage(LAYOUT_KEY, JSON.stringify(next))
      return next
    })
  // On phones the tabs decide what is shown; the panel layout state only applies to wider screens.
  const visible = (p: PanelId) =>
    narrow ? tab === p : !layout.closed[p] && (layout.max === null || layout.max === p)
  const toggleMax = (p: PanelId) => updateLayout((l) => ({ ...l, max: l.max === p ? null : p }))
  const close = (p: PanelId) =>
    updateLayout((l) => ({ max: l.max === p ? null : l.max, closed: { ...l.closed, [p]: true } }))
  const restore = (p: PanelId) =>
    updateLayout((l) => ({ max: l.max && l.max !== p ? null : l.max, closed: { ...l.closed, [p]: false } }))

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
  // On phones every secondary action sits in one menu so the primary "Print (N)" keeps its full label.
  const phoneItems: MenuItem[] = []
  if (canPrint) {
    phoneItems.push(
      {
        id: 'copy',
        label: t('workspace.copy'),
        disabled: !current || !source,
        disabledReason: noPrintReason ?? t('workspace.toast.notReady'),
        onSelect: actions.copy,
      },
      {
        id: 'save',
        label:
          actions.targetCount > 1
            ? t('workspace.bulk.saveMany', { count: actions.targetCount })
            : t('workspace.save'),
        disabled: !current || !source,
        disabledReason: noPrintReason ?? t('workspace.toast.notReady'),
        onSelect: () => void actions.save(),
      },
    )
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
  const ratioOff = project.image ? Math.abs(project.image.w / project.image.h - TICKET_ASPECT) > 0.05 : false
  const picSize = imageEl ? imageSize(imageEl) : null

  const dbPanel = (
    <Panel
      title={t('workspace.panel.db')}
      icon="users"
      className="ws-panel"
      actions={<PanelButtons id="db" max={layout.max === 'db'} onMax={toggleMax} onClose={close} />}
    >
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
    <Panel
      title={t('workspace.panel.picture')}
      icon="pencil"
      className="ws-panel"
      actions={<PanelButtons id="picture" max={layout.max === 'picture'} onMax={toggleMax} onClose={close} />}
    >
      <TicketPanel
        image={imageEl}
        imageLoading={!!project.image && !imageEl}
        hasProjectImage={!!project.image}
        placeholders={project.image ? (project.placeholders as TicketPlaceholders) : null}
        participant={current}
        emptyReason={list.isError ? 'error' : rows.length === 0 && !list.isPending ? 'no-rows' : 'select'}
        onRetry={() => void list.refetch()}
        settingsTo={canSettings ? `/projects/${project.id}/settings` : undefined}
        footer={
          ratioOff && canSettings ? (
            <p className="tk-hint muted">
              <Icon name="info" size={14} />
              {t('workspace.ticket.ratio', { size: picSize ? `${picSize.w}x${picSize.h}` : '' })}
            </p>
          ) : null
        }
      />
    </Panel>
  )

  const hiddenPanels: PanelId[] = (['picture', 'db'] as const).filter((p) => layout.closed[p])
  const anyVisible = visible('picture') || visible('db')

  return (
    <div className="ws" data-tab={tab}>
      <div className="ws-head">
        <nav className="breadcrumb" aria-label={t('workspace.crumbs')}>
          <AppLink to="/" className="muted">
            {t('projects.title')}
          </AppLink>
          <span className="muted" aria-hidden="true">
            /
          </span>
          <h1 className="breadcrumb-current ws-title" title={project.title}>
            {project.title}
          </h1>
        </nav>
        <div className="ws-people">
          {hasOnline && (
            <div className="ws-people-group">
              <span className="ws-people-label">{t('workspace.people.online')}</span>
              <OnlineAvatars />
            </div>
          )}
          {project.contributors.length > 0 && (
            <div className="ws-people-group">
              <span className="ws-people-label">{t('workspace.people.contributors')}</span>
              <AvatarStack users={project.contributors.map((c) => ({ ...c, avatar: null }))} />
            </div>
          )}
        </div>
      </div>
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
            copyReady={!!source && selectedRows.length === 1}
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
            printLabel={printLabel}
            printDisabled={noPrintReason}
            items={phoneItems}
            onPrint={onPrint}
          />
        )
      ) : (
        <div className="ws-toolbar" role="toolbar" aria-label={t('workspace.toolbar')}>
          {canPrint && (
            <>
              <ToolButton
                icon="print"
                variant="primary"
                label={printLabel}
                text={printLabel}
                disabled={!current || !project.image}
                disabledReason={noPrintReason}
                onClick={onPrint}
              />
              <ToolButton
                icon="copy"
                label={t('workspace.copy')}
                hint={`${shortcut}+C`}
                disabled={!current || !source}
                disabledReason={noPrintReason ?? t('workspace.toast.notReady')}
                onClick={actions.copy}
              />
              <ToolButton
                icon="save"
                label={t('workspace.save')}
                disabled={!current || !source}
                disabledReason={noPrintReason ?? t('workspace.toast.notReady')}
                onClick={() => void actions.save()}
              />
            </>
          )}
          {(canImport || canExport) && <span className="ws-sep" aria-hidden="true" />}
          {canImport && (
            <ToolButton
              icon="upload"
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
                  <Button {...props} aria-label={t('workspace.export')}>
                    <WsIcon name="exportTable" />
                    <span className="ws-tool-text">{t('workspace.export')}</span>
                  </Button>
                </Tooltip>
              )}
            />
          )}
          {canSettings && (
            <>
              <span className="ws-sep" aria-hidden="true" />
              <ToolButton
                icon="settings"
                label={t('workspace.settings')}
                onClick={() => void navigate(`/projects/${project.id}/settings`, { viewTransition: true })}
              />
            </>
          )}
          {!narrow &&
            hiddenPanels.map((p) => (
              <Button key={p} size="sm" variant="ghost" onClick={() => restore(p)}>
                <WsIcon name={p === 'picture' ? 'image' : 'table'} size={16} />
                {t('workspace.showPanel', {
                  name: t(p === 'picture' ? 'workspace.panel.picture' : 'workspace.panel.db'),
                })}
              </Button>
            ))}
          <span className="spacer" />
          {canPrint && (
            <span className="ws-hint">
              {t('workspace.copyHint')} <kbd>{shortcut}</kbd>+<kbd>C</kbd>
            </span>
          )}
        </div>
      )}

      {actions.progress && (
        <div className="ws-progress" role="status">
          <div
            className="ws-progress-bar"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={actions.progress.total}
            aria-valuenow={actions.progress.done}
            aria-label={t('workspace.progress.save')}
          >
            <span style={{ transform: `scaleX(${actions.progress.done / actions.progress.total})` }} />
          </div>
          <span className="muted">
            {t('workspace.progress.count', {
              done: formatNumber(actions.progress.done),
              total: formatNumber(actions.progress.total),
            })}
          </span>
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
        data-picture={visible('picture') ? 'on' : 'off'}
        data-db={visible('db') ? 'on' : 'off'}
      >
        <div
          className="ws-slot"
          data-panel="picture"
          aria-hidden={!visible('picture') || undefined}
          inert={!visible('picture')}
        >
          {picturePanel}
        </div>
        <div
          className="ws-slot"
          data-panel="db"
          aria-hidden={!visible('db') || undefined}
          inert={!visible('db')}
        >
          {dbPanel}
        </div>
        {!narrow && !anyVisible && (
          <p className="muted ws-none" role="status">
            {t('workspace.allClosed')}
          </p>
        )}
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

function PanelButtons({
  id,
  max,
  onMax,
  onClose,
}: {
  id: PanelId
  max: boolean
  onMax: (id: PanelId) => void
  onClose: (id: PanelId) => void
}): ReactNode {
  const { t } = useI18n()
  return (
    <span className="ws-panel-actions">
      <Button
        variant="ghost"
        size="sm"
        iconOnly
        aria-label={max ? t('workspace.panel.restore') : t('workspace.panel.maximize')}
        aria-pressed={max}
        onClick={() => onMax(id)}
      >
        <WsIcon name={max ? 'restore' : 'maximize'} size={18} />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        iconOnly
        aria-label={t('workspace.panel.close')}
        onClick={() => onClose(id)}
      >
        <Icon name="x" size={18} />
      </Button>
    </span>
  )
}
