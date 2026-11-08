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
import {
  type ConflictState,
  cellId,
  type EditState,
  ParticipantRow,
  ROW_HEIGHT,
  type RowHandlers,
} from './ParticipantRow'
import { hasCommandKey } from './platform'
import type { RowLockOwner, RowPresence } from './presence'
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
  query: string
  onQueryChange: (q: string) => void
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
    query,
    onQueryChange,
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
  const [shakes, setShakes] = useState<ReadonlyMap<string, number>>(new Map())
  const [tipId, setTipId] = useState<string | null>(null)
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
    const pruned = pruneSelection(
      selected,
      rows.map((r) => r.id),
    )
    if (pruned !== selected) onSelectedChange(pruned)
  }, [rows, selected, onSelectedChange])

  const rowVirtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
    getItemKey: (i) => visible[i]?.id ?? i,
  })

  useEffect(() => {
    if (!revealId) return
    const index = visible.findIndex((r) => r.id === revealId)
    if (index >= 0) rowVirtualizer.scrollToIndex(index, { align: 'start' })
    // Only a new reveal request should scroll, not every row change.
  }, [revealId])

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

  const focusGrid = useCallback(() => grid.current?.focus({ preventScroll: true }), [])

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
      setEdit({ id: row.id, col: cell.col, value: replaceWith ?? original, original })
      return true
    },
    [visible, canEdit, lockFor, shake],
  )

  const commit = useCallback(
    async (state: EditState, patchOverride?: string) => {
      const row = rows.find((r) => r.id === state.id)
      const value = patchOverride ?? state.value
      if (!row || value === state.original) return
      const field = COLUMNS[state.col] === 'phone' ? 'phone' : 'name'
      const res = await onCommit(row, { [field]: value })
      if (res.status === 'conflict') {
        setConflicts((m) => new Map(m).set(row.id, { field, mine: value, current: res.current }))
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
    },
    [rows, onCommit, people, later, shake, t],
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
    setEdit(null)
    requestAnimationFrame(focusGrid)
  }, [focusGrid])

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
      const res = await onCommit(c.current, { [c.field]: c.mine })
      if (res.status === 'conflict') {
        setConflicts((m) => new Map(m).set(id, { ...c, current: res.current }))
      }
    },
    [conflicts, onCommit],
  )

  const handlers: RowHandlers = useMemo(
    () => ({
      onEditChange: (value) => setEdit((e) => (e ? { ...e, value } : e)),
      onEditPaste: (text) => {
        if (!pasteRows(text)) return false
        cancelEdit()
        return true
      },
      onResolveTheirs: resolveTheirs,
      onResolveMine: (id) => void resolveMine(id),
    }),
    [pasteRows, cancelEdit, resolveTheirs, resolveMine],
  )

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
      if (selected.size > 1) onSelectedChange(new Set(ids[cell.row] ? [ids[cell.row] as string] : []))
      return
    }
    if (e.key === 'Delete' && canDelete && selected.size > 0) {
      e.preventDefault()
      onDelete([...selected])
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

  if (error) return <div className="pt-state">{error}</div>

  return (
    <div className="pt">
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
        {canEdit && (
          <Button size="sm" onClick={onAddRows}>
            <Icon name="plus" size={16} />
            {t('workspace.addRows')}
          </Button>
        )}
        {canDelete && selected.size > 0 && (
          <Button size="sm" variant="danger" onClick={() => onDelete([...selected])}>
            <Icon name="trash" size={16} />
            {t('workspace.deleteSelected', { count: selected.size })}
          </Button>
        )}
      </div>

      {/* The grid is the single tab stop; cells are addressed through aria-activedescendant. */}
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
            {t('workspace.col.number')}
          </div>
          <div className="pt-hcell" role="columnheader">
            {t('workspace.col.name')}
          </div>
          <div className="pt-hcell" role="columnheader">
            {t('workspace.col.phone')}
          </div>
        </div>

        <div ref={scroller} className="pt-scroll">
          {loading && rows.length === 0 ? (
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
          ) : (
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
                    rowCount={visible.length}
                    handlers={handlers}
                  />
                )
              })}
            </div>
          )}
        </div>
      </div>

      <div className="pt-foot" aria-live="polite">
        {t('workspace.rowCount', { count: visible.length, total: rows.length })}
        {selected.size > 0 && ` · ${t('workspace.selectedCount', { count: selected.size })}`}
      </div>
    </div>
  )
}
