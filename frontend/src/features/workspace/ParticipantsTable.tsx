// biome-ignore-all lint/a11y/useSemanticElements: virtualized spreadsheet grid needs the ARIA grid pattern, not <table>
// biome-ignore-all lint/a11y/useFocusableInteractive: focus is managed on the grid via aria-activedescendant
// biome-ignore-all lint/a11y/useAriaPropsSupportedByRole: row/cell state attributes follow the ARIA grid pattern
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  type ClipboardEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Button } from '../../components/Button'
import { Icon } from '../../components/Icon'
import { Skeleton, useSkeleton } from '../../components/Skeleton'
import { useI18n } from '../../i18n'
import type { Participant, ParticipantInput } from './api'
import { BulkBar } from './BulkBar'
import { WsIcon } from './icons'
import { CARD_ESTIMATE, type CardHandlers, ParticipantCard } from './ParticipantCards'
import {
  type ConflictState,
  cellId,
  type EditState,
  type FailedState,
  ParticipantRow,
  ROW_HEIGHT,
  type RowHandlers,
  type RowPatch,
} from './ParticipantRow'
import { hasCommandKey } from './platform'
import { type RowLockOwner, type RowPresence, useRowCollab } from './presence'
import { RowSheet, type SheetSaveResult } from './RowSheet'
import {
  allVisibleSelected,
  applyClick,
  type Cell,
  COLUMNS,
  columnValue,
  filterRows,
  isEditableCol,
  isTabular,
  type Move,
  moveCell,
  parsePaste,
  pruneSelection,
  selectAllVisible,
} from './tableLogic'

export type CommitResult =
  | { status: 'ok' }
  | { status: 'conflict'; current: Participant }
  | { status: 'locked'; by?: string }
  | { status: 'error' }

export interface ParticipantsTableProps {
  rows: readonly Participant[]
  loading: boolean
  /** Shown instead of the grid when loading failed. */
  error?: ReactNode
  canEdit: boolean
  canDelete: boolean
  selected: ReadonlySet<string>
  onSelectedChange: (next: ReadonlySet<string>) => void
  currentId: string | null
  onCurrentChange: (id: string) => void
  /** Rows playing their collapse animation before they leave the list. */
  leaving?: ReadonlySet<string>
  /** Freshly inserted rows (highlighted in `freshColor`). */
  freshIds?: ReadonlySet<string>
  freshColor?: string
  presence: RowPresence
  /** Project members by user id, used to name the holder of a ROW_LOCKED 409. */
  people?: ReadonlyMap<string, RowLockOwner>
  onCommit: (row: Participant, patch: { name?: string; phone?: string }) => Promise<CommitResult>
  /** Replaces a row with the server's current copy ("take theirs"). */
  onAdopt: (row: Participant) => void
  onDelete: (ids: string[]) => void
  onAddRows: () => void
  onPasteRows: (items: ParticipantInput[]) => void
  /** Scrolls this row into view when it changes (e.g. after adding rows at the end). */
  revealId?: string | null
  /** Bumped when the cursor should move to `revealId` and the grid take keyboard focus. */
  focusNonce?: number
  /** Rows with an edit still waiting to be sent while offline. */
  unsentIds?: ReadonlySet<string>
  query: string
  onQueryChange: (q: string) => void
  /** Phone layout: cards plus a bottom-sheet editor instead of the spreadsheet grid. */
  cards?: boolean
  /** Short messages (e.g. "row is being edited by X") shown as a toast by the page. */
  onNotify?: (message: string) => void
  /** Bulk ticket actions of the card layout's selection bar; hidden when `canPrint` is false. */
  canPrint?: boolean
  /** The ticket image is ready and exactly one row is selected, so copying makes sense. */
  copyReady?: boolean
  onBulkPrint?: () => void
  onBulkCopy?: () => void
  onBulkSave?: () => void
  /** Ticket preview for the sheet; receives the draft values of the row being edited. */
  sheetPreview?: (row: Participant) => ReactNode
}

const EMPTY_SET: ReadonlySet<string> = new Set()
const LOCAL_LOCK_MS = 8000

export function ParticipantsTable(props: ParticipantsTableProps) {
  const {
    rows,
    loading,
    error,
    canEdit,
    canDelete,
    selected,
    onSelectedChange,
    currentId,
    onCurrentChange,
    leaving = EMPTY_SET,
    freshIds = EMPTY_SET,
    freshColor = 'var(--accent)',
    presence,
    people,
    onCommit,
    onAdopt,
    onDelete,
    onAddRows,
    onPasteRows,
    revealId,
    focusNonce = 0,
    unsentIds = EMPTY_SET,
    query,
    onQueryChange,
    cards = false,
    onNotify,
    canPrint = false,
    copyReady = false,
    onBulkPrint,
    onBulkCopy,
    onBulkSave,
    sheetPreview,
  } = props
  const { t } = useI18n()
  const showSkeleton = useSkeleton(loading)

  const visible = useMemo(() => filterRows(rows, query), [rows, query])
  const ids = useMemo(() => visible.map((r) => r.id), [visible])

  const scroller = useRef<HTMLDivElement>(null)
  const grid = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState<Cell | null>(null)
  const [edit, setEdit] = useState<EditState | null>(null)
  const [anchor, setAnchor] = useState<number | null>(null)
  const [conflicts, setConflicts] = useState<ReadonlyMap<string, ConflictState>>(new Map())
  const [localLocks, setLocalLocks] = useState<ReadonlyMap<string, RowLockOwner>>(new Map())
  const [failed, setFailed] = useState<ReadonlyMap<string, FailedState>>(new Map())
  const [shakes, setShakes] = useState<ReadonlyMap<string, number>>(new Map())
  const [tipId, setTipId] = useState<string | null>(null)
  // Card layout: the row open in the bottom sheet and whether taps select instead of open.
  const [sheetId, setSheetId] = useState<string | null>(null)
  const [selectMode, setSelectMode] = useState(false)
  const lastPointer = useRef<string>('mouse')
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>())

  const later = useCallback((fn: () => void, ms: number) => {
    const id = setTimeout(() => {
      timers.current.delete(id)
      fn()
    }, ms)
    timers.current.add(id)
  }, [])
  useEffect(() => {
    const pending = timers.current
    return () => {
      for (const id of pending) clearTimeout(id)
    }
  }, [])

  // Keep the cursor inside the list when rows disappear (filter, deletion).
  useEffect(() => {
    setActive((a) =>
      a && visible.length > 0 && a.row >= visible.length ? { ...a, row: visible.length - 1 } : a,
    )
  }, [visible.length])
  useEffect(() => {
    // The selection never keeps rows the search hides, so bulk actions only touch what is on screen.
    const pruned = pruneSelection(selected, ids)
    if (pruned !== selected) onSelectedChange(pruned)
  }, [ids, selected, onSelectedChange])
  const selectedVisible = useMemo(() => ids.filter((id) => selected.has(id)), [ids, selected])

  const rowVirtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => (cards ? CARD_ESTIMATE : ROW_HEIGHT),
    overscan: cards ? 6 : 8,
    getItemKey: (i) => visible[i]?.id ?? i,
  })
  // Cards have measured, variable heights; switching layout must drop the cached sizes.
  useEffect(() => {
    rowVirtualizer.measure()
    if (!cards) {
      setSelectMode(false)
      setSheetId(null)
    }
  }, [cards, rowVirtualizer])

  useEffect(() => {
    if (!revealId) return
    const index = visible.findIndex((r) => r.id === revealId)
    if (index >= 0) rowVirtualizer.scrollToIndex(index, { align: 'start' })
    // Only a new reveal request should scroll, not every row change.
  }, [revealId])

  const focusGrid = useCallback(() => grid.current?.focus({ preventScroll: true }), [])

  const focusSeen = useRef(0)
  useEffect(() => {
    if (focusNonce === focusSeen.current) return
    focusSeen.current = focusNonce
    const index = revealId ? visible.findIndex((r) => r.id === revealId) : -1
    if (index < 0) return
    // Put the cursor on the first new row's name cell so typing can start right away.
    setActive({ row: index, col: 1 })
    setAnchor(index)
    requestAnimationFrame(focusGrid)
  }, [focusNonce])

  const lockFor = useCallback(
    (id: string): RowLockOwner | null => presence.locks.get(id) ?? localLocks.get(id) ?? null,
    [presence.locks, localLocks],
  )

  const shake = useCallback(
    (id: string) => {
      setShakes((m) => new Map(m).set(id, (m.get(id) ?? 0) + 1))
      setTipId(id)
      later(() => setTipId((cur) => (cur === id ? null : cur)), 2500)
    },
    [later],
  )

  const goTo = useCallback(
    (cell: Cell, opts: { extend?: boolean } = {}) => {
      setActive(cell)
      rowVirtualizer.scrollToIndex(cell.row, { align: 'auto' })
      const id = ids[cell.row]
      if (id === undefined) return
      onCurrentChange(id)
      const next = applyClick({ selected, anchor }, ids, cell.row, { shift: !!opts.extend, toggle: false })
      onSelectedChange(next.selected)
      if (!opts.extend || anchor === null) setAnchor(cell.row)
    },
    [ids, selected, anchor, onCurrentChange, onSelectedChange, rowVirtualizer],
  )

  const startEdit = useCallback(
    (cell: Cell, replaceWith?: string): boolean => {
      const row = visible[cell.row]
      if (!row || !canEdit || !isEditableCol(cell.col)) return false
      if (lockFor(row.id)) {
        shake(row.id)
        return false
      }
      const original = columnValue(row, cell.col)
      const retained = failed.get(row.id)
      const prefill = retained?.col === cell.col ? retained.value : original
      setEdit({ id: row.id, col: cell.col, value: replaceWith ?? prefill, original })
      return true
    },
    [visible, canEdit, lockFor, shake, failed],
  )

  /** Sends a patch (one cell from the grid, or both fields from the sheet) and records the outcome per row. */
  const commitPatch = useCallback(
    async (rowId: string, patch: RowPatch, col: number): Promise<CommitResult> => {
      const row = rows.find((r) => r.id === rowId)
      if (!row) return { status: 'error' }
      const field = patch.name !== undefined ? 'name' : 'phone'
      const value = patch[field] ?? ''
      const both = patch.name !== undefined && patch.phone !== undefined ? patch : undefined
      const res = await onCommit(row, patch)
      if (res.status === 'ok') {
        setFailed((m) => {
          if (!m.has(row.id)) return m
          const next = new Map(m)
          next.delete(row.id)
          return next
        })
      } else if (res.status === 'error') {
        // Keep what the user typed (marked as unsaved) so a transient error never throws their work away.
        setFailed((m) => new Map(m).set(row.id, { col, value, patch: both }))
      } else if (res.status === 'conflict') {
        setConflicts((m) => new Map(m).set(row.id, { field, mine: value, current: res.current, patch: both }))
      } else if (res.status === 'locked') {
        const owner = res.by ? people?.get(res.by) : undefined
        const entry: RowLockOwner = owner ?? {
          id: res.by ?? '',
          displayName: t('workspace.someone'),
          color: 'var(--accent)',
          avatarUrl: null,
        }
        setLocalLocks((m) => new Map(m).set(row.id, entry))
        later(
          () =>
            setLocalLocks((m) => {
              const next = new Map(m)
              next.delete(row.id)
              return next
            }),
          LOCAL_LOCK_MS,
        )
        shake(row.id)
      }
      return res
    },
    [rows, onCommit, people, later, shake, t],
  )

  const commit = useCallback(
    async (state: EditState, patchOverride?: string) => {
      const row = rows.find((r) => r.id === state.id)
      const value = patchOverride ?? state.value
      if (!row || value === state.original) return
      const field = COLUMNS[state.col] === 'phone' ? 'phone' : 'name'
      await commitPatch(row.id, { [field]: value }, state.col)
    },
    [rows, commitPatch],
  )

  const saveSheet = useCallback(
    async (id: string, patch: RowPatch): Promise<SheetSaveResult> => {
      const res = await commitPatch(id, patch, patch.name !== undefined ? 1 : 2)
      if (res.status === 'ok') return 'ok'
      if (res.status === 'error') return 'error'
      // A conflict or a lock is resolved on the card, so the sheet gets out of the way (only if still on that row).
      setSheetId((cur) => (cur === id ? null : cur))
      return 'closed'
    },
    [commitPatch],
  )

  const finishEdit = useCallback(
    (move: Move | null, refocus = true) => {
      if (!edit) return
      const state = edit
      setEdit(null)
      void commit(state)
      if (active && move) {
        const next = moveCell(active, move, visible.length)
        setActive(next)
        rowVirtualizer.scrollToIndex(next.row, { align: 'auto' })
        const id = ids[next.row]
        if (id !== undefined) onCurrentChange(id)
      }
      // The input is about to unmount; keep keyboard focus on the grid (unless the user moved elsewhere).
      if (refocus) requestAnimationFrame(focusGrid)
    },
    [edit, commit, active, visible.length, ids, onCurrentChange, rowVirtualizer, focusGrid],
  )

  const cancelEdit = useCallback(() => {
    if (edit) {
      setFailed((m) => {
        if (!m.has(edit.id)) return m
        const next = new Map(m)
        next.delete(edit.id)
        return next
      })
    }
    setEdit(null)
    requestAnimationFrame(focusGrid)
  }, [edit, focusGrid])

  const pasteRows = useCallback(
    (text: string): boolean => {
      if (!canEdit || !isTabular(text)) return false
      const items = parsePaste(text)
      if (items.length > 0) onPasteRows(items)
      return true
    },
    [canEdit, onPasteRows],
  )

  const resolveTheirs = useCallback(
    (id: string) => {
      const c = conflicts.get(id)
      if (!c) return
      onAdopt(c.current)
      setConflicts((m) => {
        const next = new Map(m)
        next.delete(id)
        return next
      })
    },
    [conflicts, onAdopt],
  )

  const resolveMine = useCallback(
    async (id: string) => {
      const c = conflicts.get(id)
      if (!c) return
      setConflicts((m) => {
        const next = new Map(m)
        next.delete(id)
        return next
      })
      // Retry on top of the server's current version; a second conflict re-opens the prompt.
      const res = await onCommit(c.current, c.patch ?? { [c.field]: c.mine })
      if (res.status === 'conflict') {
        setConflicts((m) => new Map(m).set(id, { ...c, current: res.current }))
      }
    },
    [conflicts, onCommit],
  )

  const retry = useCallback(
    (id: string) => {
      const f = failed.get(id)
      if (!f) return
      void commitPatch(id, f.patch ?? { [COLUMNS[f.col] === 'phone' ? 'phone' : 'name']: f.value }, f.col)
    },
    [failed, commitPatch],
  )

  const handlers: RowHandlers = useMemo(
    () => ({
      onRetry: retry,
      onEditChange: (value) => setEdit((e) => (e ? { ...e, value } : e)),
      onEditPaste: (text) => {
        if (!pasteRows(text)) return false
        cancelEdit()
        return true
      },
      onResolveTheirs: resolveTheirs,
      onResolveMine: (id) => void resolveMine(id),
    }),
    [retry, pasteRows, cancelEdit, resolveTheirs, resolveMine],
  )

  // ---- cards and bottom sheet

  const pickCard = useCallback(
    (id: string) => {
      const index = ids.indexOf(id)
      if (index < 0) return -1
      setActive({ row: index, col: 1 })
      setAnchor(index)
      onCurrentChange(id)
      return index
    },
    [ids, onCurrentChange],
  )

  const openCard = useCallback(
    (id: string) => {
      if (pickCard(id) < 0) return
      const owner = lockFor(id)
      if (owner) {
        // A row someone else is editing never opens; say who holds it instead of failing silently.
        shake(id)
        const row = rows.find((r) => r.id === id)
        onNotify?.(t('workspace.card.blocked', { number: row?.number ?? '', name: owner.displayName }))
        return
      }
      setSheetId(id)
    },
    [pickCard, lockFor, shake, rows, onNotify, t],
  )

  const toggleCard = useCallback(
    (id: string) => {
      if (pickCard(id) < 0) return
      const next = new Set(selected)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      onSelectedChange(next)
      // Copy and the ticket preview follow the single selected row.
      if (next.size === 1) onCurrentChange([...next][0] as string)
    },
    [pickCard, selected, onSelectedChange, onCurrentChange],
  )

  const longPressCard = useCallback(
    (id: string) => {
      if (pickCard(id) < 0) return
      setSelectMode(true)
      onSelectedChange(new Set([...selected, id]))
      navigator.vibrate?.(10)
    },
    [pickCard, selected, onSelectedChange],
  )

  const exitSelectMode = useCallback(() => {
    setSelectMode(false)
    onSelectedChange(new Set())
  }, [onSelectedChange])

  const cardHandlers: CardHandlers = useMemo(
    () => ({
      onOpen: openCard,
      onToggle: toggleCard,
      onLongPress: longPressCard,
      onRetry: retry,
      onResolveTheirs: resolveTheirs,
      onResolveMine: (id) => void resolveMine(id),
    }),
    [openCard, toggleCard, longPressCard, retry, resolveTheirs, resolveMine],
  )

  // Paging skips rows a colleague is editing.
  const sheetIndex = sheetId ? ids.indexOf(sheetId) : -1
  const stepFrom = (from: number, dir: 1 | -1): string | null => {
    for (let i = from + dir; i >= 0 && i < ids.length; i += dir) {
      const id = ids[i] as string
      if (!lockFor(id)) return id
    }
    return null
  }
  const prevId = sheetIndex >= 0 ? stepFrom(sheetIndex, -1) : null
  const nextId = sheetIndex >= 0 ? stepFrom(sheetIndex, 1) : null
  const sheetRow = sheetIndex >= 0 ? visible[sheetIndex] : undefined
  // The sheet closes when its row disappears (deleted by a colleague, filtered out).
  useEffect(() => {
    if (sheetId && !visible.some((r) => r.id === sheetId)) setSheetId(null)
  }, [sheetId, visible])

  // ---- pointer

  const cellFromEvent = (e: MouseEvent): Cell | null => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-cell]')
    if (!el) return null
    return { row: Number(el.dataset.row), col: Number(el.dataset.col) }
  }

  const onClick = (e: MouseEvent) => {
    const cell = cellFromEvent(e)
    if (!cell || (e.target as HTMLElement).closest('.pt-input, .pt-conflict')) return
    const id = ids[cell.row]
    if (id === undefined) return
    const wasActive = active?.row === cell.row && active.col === cell.col
    const toggle = hasCommandKey(e) || e.metaKey || e.ctrlKey
    const next = applyClick({ selected, anchor }, ids, cell.row, { shift: e.shiftKey, toggle })
    onSelectedChange(next.selected)
    setAnchor(next.anchor)
    setActive(cell)
    onCurrentChange(id)
    if (lockFor(id) && lastPointer.current === 'touch') setTipId((cur) => (cur === id ? null : id))
    // Touch has no double-click: a second tap on the active cell starts editing.
    if (edit && !(edit.id === id && edit.col === cell.col)) finishEdit(null, false)
    if (wasActive && lastPointer.current === 'touch' && !e.shiftKey && !toggle) startEdit(cell)
    focusGrid()
  }

  const onDoubleClick = (e: MouseEvent) => {
    const cell = cellFromEvent(e)
    if (cell) startEdit(cell)
  }

  // ---- keyboard

  const onKeyDown = (e: KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey
    if (edit) {
      if (e.key === 'Enter') {
        e.preventDefault()
        finishEdit(e.shiftKey ? 'up' : 'down')
      } else if (e.key === 'Tab') {
        e.preventDefault()
        finishEdit(e.shiftKey ? 'prev' : 'next')
      } else if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        cancelEdit()
      }
      return
    }
    if (e.target !== grid.current) return
    const cell = active ?? (visible.length > 0 ? { row: 0, col: 1 } : null)

    if (mod && e.key.toLowerCase() === 'a') {
      e.preventDefault()
      const all = selectAllVisible(ids)
      onSelectedChange(all.selected)
      setAnchor(all.anchor)
      return
    }
    if (!cell) return

    const arrows: Record<string, Move> = {
      ArrowUp: 'up',
      ArrowDown: 'down',
      ArrowLeft: 'left',
      ArrowRight: 'right',
      Home: 'home',
      End: 'end',
    }
    const move = arrows[e.key]
    if (move) {
      e.preventDefault()
      let target = moveCell(cell, move, visible.length)
      if (mod && move === 'home') target = { row: 0, col: cell.col }
      if (mod && move === 'end') target = { row: visible.length - 1, col: cell.col }
      goTo(target, { extend: e.shiftKey && (move === 'up' || move === 'down') })
      return
    }
    if (e.key === 'PageDown' || e.key === 'PageUp') {
      e.preventDefault()
      const pageSize = Math.max(
        1,
        Math.floor((scroller.current?.clientHeight || ROW_HEIGHT * 10) / ROW_HEIGHT) - 1,
      )
      const delta = e.key === 'PageDown' ? pageSize : -pageSize
      goTo({ row: Math.min(visible.length - 1, Math.max(0, cell.row + delta)), col: cell.col })
      return
    }
    if (e.key === 'Tab') {
      const target = moveCell(cell, e.shiftKey ? 'prev' : 'next', visible.length)
      // At the first/last cell Tab leaves the grid as usual.
      if (target.row === cell.row && target.col === cell.col) return
      e.preventDefault()
      goTo(target)
      return
    }
    if (e.key === 'Enter' || e.key === 'F2') {
      e.preventDefault()
      startEdit(cell)
      return
    }
    if (e.key === 'Escape') {
      if (selectedVisible.length > 1)
        onSelectedChange(new Set(ids[cell.row] ? [ids[cell.row] as string] : []))
      return
    }
    if (e.key === 'Delete' && canDelete && selectedVisible.length > 0) {
      e.preventDefault()
      onDelete(selectedVisible)
      return
    }
    if (e.key === 'Backspace') {
      e.preventDefault()
      startEdit(cell, '')
      return
    }
    if (e.key.length === 1 && !mod && !e.altKey) {
      // Type-to-edit: the first character replaces the cell content, like a spreadsheet.
      if (startEdit(cell, e.key)) e.preventDefault()
    }
  }

  const onPaste = (e: ClipboardEvent) => {
    if (e.target !== grid.current) return
    const text = e.clipboardData.getData('text/plain')
    if (!text) return
    if (pasteRows(text)) {
      e.preventDefault()
      return
    }
    // A single value goes into the active cell.
    const cell = active
    const row = cell ? visible[cell.row] : undefined
    if (cell && row && canEdit && isEditableCol(cell.col) && !lockFor(row.id)) {
      e.preventDefault()
      const original = columnValue(row, cell.col)
      void commit({ id: row.id, col: cell.col, value: text.trim(), original })
    }
  }

  const activeRow = active ? visible[active.row] : undefined
  const everySelected = allVisibleSelected(ids, selected)
  const items = rowVirtualizer.getVirtualItems()
  const activeDescendant = activeRow && active ? cellId(activeRow.id, active.col) : undefined

  // ---- realtime: row lock lifecycle, cursor and denied locks
  const { editStarted, editEnded, cursor, denied } = useRowCollab()
  // The sheet edits a whole row, so it holds the row lock for as long as it is open.
  const editRowId = edit?.id ?? (canEdit ? sheetId : null)
  useEffect(() => {
    if (!editRowId) return
    editStarted(editRowId)
    return () => editEnded(editRowId)
  }, [editRowId, editStarted, editEnded])
  const cursorRowId = activeRow?.id ?? null
  const cursorField = active ? COLUMNS[active.col] : undefined
  useEffect(() => {
    cursor(cursorRowId, cursorField)
  }, [cursor, cursorRowId, cursorField])
  useEffect(() => () => cursor(null), [cursor])
  const seenDenied = useRef(denied?.seq ?? 0)
  useEffect(() => {
    if (!denied || denied.seq <= seenDenied.current) return
    seenDenied.current = denied.seq
    // Someone else holds the row: drop the edit and show the same shake and tooltip as a locked row.
    setEdit((e) => (e && e.id === denied.rowId ? null : e))
    setSheetId((cur) => (cur === denied.rowId ? null : cur))
    shake(denied.rowId)
    requestAnimationFrame(focusGrid)
  }, [denied, shake, focusGrid])

  if (error) return <div className="pt-state">{error}</div>

  const addButton = canEdit && (
    <Button size="sm" onClick={onAddRows} aria-label={t('workspace.addRows')}>
      <Icon name="plus" size={16} />
      <span className="pt-btn-text">{t('workspace.addRows')}</span>
    </Button>
  )

  const emptyOrLoading =
    loading && rows.length === 0 ? (
      showSkeleton ? (
        <div className="pt-skeleton" role="status" aria-label={t('state.loading')}>
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} height={22} />
          ))}
        </div>
      ) : null
    ) : visible.length === 0 ? (
      <div className="pt-empty" role="status">
        <p>{rows.length === 0 ? t('workspace.empty.title') : t('workspace.search.none')}</p>
        {rows.length === 0 && canEdit && <p className="muted">{t('workspace.empty.hint')}</p>}
      </div>
    ) : null

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Esc leaves selection mode from anywhere in the list
    <div
      className="pt"
      data-cards={cards || undefined}
      onKeyDown={(e) => {
        if (cards && selectMode && e.key === 'Escape') {
          e.stopPropagation()
          exitSelectMode()
        }
      }}
    >
      <div className="pt-tools">
        <div className="input pt-search">
          <Icon name="search" />
          <input
            type="search"
            name="participant-search"
            value={query}
            placeholder={t('workspace.search.placeholder')}
            aria-label={t('workspace.search.label')}
            autoComplete="off"
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' && visible.length > 0) {
                e.preventDefault()
                focusGrid()
                goTo(active ?? { row: 0, col: 1 })
              } else if (e.key === 'Escape' && query) {
                onQueryChange('')
              }
            }}
          />
        </div>
        {cards && (
          <Button
            size="sm"
            aria-pressed={selectMode}
            aria-label={t('workspace.select.enter')}
            disabled={visible.length === 0}
            onClick={() => (selectMode ? exitSelectMode() : setSelectMode(true))}
          >
            <WsIcon name="selectMode" size={18} />
          </Button>
        )}
        {addButton}
        {/* Kept in the layout (but hidden) while nothing is selected so selecting never moves the table. */}
        {!cards && canDelete && (
          <Button
            size="sm"
            variant="danger"
            className="pt-delete"
            data-idle={selectedVisible.length === 0 || undefined}
            aria-hidden={selectedVisible.length === 0 || undefined}
            inert={selectedVisible.length === 0}
            onClick={() => onDelete(selectedVisible)}
          >
            <Icon name="trash" size={16} />
            {t('workspace.deleteSelected', { count: selectedVisible.length })}
          </Button>
        )}
      </div>

      {cards ? (
        <div className="pc">
          {/* biome-ignore lint/a11y/noNoninteractiveTabindex: the scrollable list must be reachable by keyboard */}
          <div ref={scroller} className="pt-scroll pc-scroll" tabIndex={0}>
            {emptyOrLoading ?? (
              <div
                className="pt-sizer pc-list"
                role="list"
                aria-label={t('workspace.table.label')}
                style={{ height: rowVirtualizer.getTotalSize() }}
              >
                {items.map((item) => {
                  const row = visible[item.index]
                  if (!row) return null
                  return (
                    <ParticipantCard
                      key={row.id}
                      row={row}
                      index={item.index}
                      top={item.start}
                      measure={rowVirtualizer.measureElement}
                      selected={selected.has(row.id)}
                      selectMode={selectMode}
                      current={currentId === row.id}
                      editing={sheetId === row.id}
                      lockedBy={lockFor(row.id)}
                      cursors={presence.cursors.get(row.id)}
                      leaving={leaving.has(row.id)}
                      fresh={freshIds.has(row.id)}
                      freshColor={freshColor}
                      shake={shakes.get(row.id) ?? 0}
                      tipOpen={tipId === row.id}
                      conflict={conflicts.get(row.id) ?? null}
                      failed={failed.get(row.id) ?? null}
                      unsent={unsentIds.has(row.id)}
                      handlers={cardHandlers}
                    />
                  )
                })}
              </div>
            )}
          </div>
          {selectMode && (
            <BulkBar
              count={selectedVisible.length}
              allSelected={everySelected}
              canDelete={canDelete}
              canPrint={canPrint}
              copyReady={copyReady}
              onPrint={() => onBulkPrint?.()}
              onCopy={() => onBulkCopy?.()}
              onSave={() => onBulkSave?.()}
              onDelete={() => {
                onDelete(selectedVisible)
                setSelectMode(false)
              }}
              onSelectAll={() => {
                const all = selectAllVisible(ids)
                onSelectedChange(all.selected)
                setAnchor(all.anchor)
              }}
              onDone={exitSelectMode}
            />
          )}
        </div>
      ) : (
        /* The grid is the single tab stop; cells are addressed through aria-activedescendant. */
        <div
          ref={grid}
          className="pt-grid"
          role="grid"
          tabIndex={0}
          aria-label={t('workspace.table.label')}
          aria-rowcount={visible.length + 1}
          aria-colcount={COLUMNS.length}
          aria-multiselectable="true"
          aria-activedescendant={activeDescendant}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onBlur={(e) => {
            if (edit && !e.currentTarget.contains(e.relatedTarget as Node | null)) finishEdit(null, false)
          }}
          onClick={onClick}
          onDoubleClick={onDoubleClick}
          onPointerDown={(e) => {
            lastPointer.current = e.pointerType
          }}
        >
          <div className="pt-head" role="row" aria-rowindex={1}>
            <div className="pt-hcell pt-hcell-num" role="columnheader">
              <label className="pt-check-hit">
                <input
                  type="checkbox"
                  className="pt-check"
                  checked={everySelected}
                  aria-label={t('workspace.selectVisible')}
                  title={t('workspace.selectVisible')}
                  disabled={visible.length === 0}
                  onClick={(e) => e.stopPropagation()}
                  onChange={() => {
                    if (everySelected) onSelectedChange(new Set())
                    else {
                      const all = selectAllVisible(ids)
                      onSelectedChange(all.selected)
                      setAnchor(all.anchor)
                    }
                  }}
                />
              </label>
              {t('workspace.col.number')}
            </div>
            <div className="pt-hcell" role="columnheader">
              {t('workspace.col.name')}
            </div>
            <div className="pt-hcell" role="columnheader">
              {t('workspace.col.phone')}
            </div>
          </div>

          {/* biome-ignore lint/a11y/noNoninteractiveTabindex: the scrollable list must be reachable by keyboard */}
          <div ref={scroller} className="pt-scroll" tabIndex={0}>
            {emptyOrLoading ?? (
              <div className="pt-sizer" role="rowgroup" style={{ height: rowVirtualizer.getTotalSize() }}>
                {items.map((item) => {
                  const row = visible[item.index]
                  if (!row) return null
                  return (
                    <ParticipantRow
                      key={row.id}
                      row={row}
                      index={item.index}
                      top={item.start}
                      selected={selected.has(row.id)}
                      current={currentId === row.id}
                      activeCol={active?.row === item.index ? active.col : null}
                      editing={edit?.id === row.id ? edit : null}
                      lockedBy={lockFor(row.id)}
                      cursors={presence.cursors.get(row.id)}
                      leaving={leaving.has(row.id)}
                      fresh={freshIds.has(row.id)}
                      freshColor={freshColor}
                      shake={shakes.get(row.id) ?? 0}
                      tipOpen={tipId === row.id}
                      conflict={conflicts.get(row.id) ?? null}
                      failed={failed.get(row.id) ?? null}
                      unsent={unsentIds.has(row.id)}
                      rowCount={visible.length}
                      handlers={handlers}
                    />
                  )
                })}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="pt-foot" aria-live="polite">
        {t('workspace.rowCount', { count: visible.length, total: rows.length })}
        {selectedVisible.length > 0 &&
          ` · ${t('workspace.selectedCount', { count: selectedVisible.length })}`}
      </div>

      {cards && (
        <RowSheet
          row={sheetRow ?? null}
          position={sheetIndex + 1}
          total={ids.length}
          canEdit={canEdit}
          canDelete={canDelete}
          hasPrev={prevId !== null}
          hasNext={nextId !== null}
          onPrev={() => prevId && pickCard(prevId) >= 0 && setSheetId(prevId)}
          onNext={() => nextId && pickCard(nextId) >= 0 && setSheetId(nextId)}
          onSave={saveSheet}
          onDelete={(id) => onDelete([id])}
          onClose={() => setSheetId(null)}
          retained={sheetRow ? (failed.get(sheetRow.id) ?? null) : null}
          preview={sheetPreview}
        />
      )}
    </div>
  )
}
