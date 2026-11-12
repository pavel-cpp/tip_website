import { useMemo } from 'react'
import { useI18n } from '../../i18n'
import type { Peer } from '../realtime/protocol'
import { useRealtime } from '../realtime/RealtimeProvider'

/**
 * Bridge between the workspace table and the realtime stream: the table consumes only the shapes below
 * and the hooks at the bottom, and knows nothing about sockets.
 */
export interface RowLockOwner {
  id: string
  displayName: string
  color: string
  avatarUrl: string | null
}

export interface RowCursor {
  id: string
  displayName: string
  color: string
}

export interface RowPresence {
  /** Rows being edited by someone else, by participant id. */
  locks: ReadonlyMap<string, RowLockOwner>
  /** The colleague who pointed at a row last (one per row), by participant id. */
  cursors: ReadonlyMap<string, RowCursor>
}

const EMPTY: RowPresence = { locks: new Map(), cursors: new Map() }

/** Locks and cursors of OTHER users; the user's own lock is never shown as "locked by someone else". */
export function buildRowPresence(
  you: string | null,
  peers: readonly Peer[],
  locks: Readonly<Record<string, { by: string }>>,
  cursors: Readonly<Record<string, { rowId: string | null }>>,
  someone: string,
): RowPresence {
  const byId = new Map(peers.map((p) => [p.id, p]))
  const lockMap = new Map<string, RowLockOwner>()
  for (const [rowId, lock] of Object.entries(locks)) {
    if (lock.by === you) continue
    const p = byId.get(lock.by)
    lockMap.set(
      rowId,
      p
        ? { id: p.id, displayName: p.displayName, color: p.color, avatarUrl: p.avatarUrl }
        : { id: lock.by, displayName: someone, color: 'var(--accent)', avatarUrl: null },
    )
  }
  // The snapshot lists a colleague's cursor after every move, so the last entry for a row is the latest click.
  const cursorMap = new Map<string, RowCursor>()
  for (const [userId, c] of Object.entries(cursors)) {
    const p = byId.get(userId)
    if (userId === you || !c.rowId || !p) continue
    cursorMap.set(c.rowId, { id: p.id, displayName: p.displayName, color: p.color })
  }
  return { locks: lockMap, cursors: cursorMap }
}

export function useRowPresence(_projectId: string): RowPresence {
  const rt = useRealtime()
  const { t } = useI18n()
  const snap = rt?.snapshot
  const someone = t('realtime.someone')
  return useMemo(
    () => (snap ? buildRowPresence(snap.you, snap.peers, snap.locks, snap.cursors, someone) : EMPTY),
    [snap, someone],
  )
}

export interface RowCollab {
  /** A cell edit began: take the row lock. */
  editStarted: (rowId: string) => void
  /** The edit ended (commit, cancel or blur): give the lock back. */
  editEnded: (rowId: string) => void
  /** The selected row/cell changed; null clears the cursor. */
  cursor: (rowId: string | null, field?: string) => void
  /** Set when the server refused a lock.acquire because someone else holds the row. */
  denied: { rowId: string; seq: number } | null
}

const NOOP_COLLAB: RowCollab = { editStarted() {}, editEnded() {}, cursor() {}, denied: null }

export function useRowCollab(): RowCollab {
  const rt = useRealtime()
  const lease = rt?.lease
  const client = rt?.client
  const denied = rt?.denied ?? null
  // The actions stay referentially stable so effects keyed on them do not re-run when `denied` changes.
  const actions = useMemo<Omit<RowCollab, 'denied'>>(
    () =>
      lease && client
        ? {
            editStarted: (rowId) => lease.acquire(rowId),
            editEnded: (rowId) => lease.release(rowId),
            cursor: (rowId, field) => client.setCursor(rowId, field),
          }
        : NOOP_COLLAB,
    [lease, client],
  )
  return useMemo(() => ({ ...actions, denied }), [actions, denied])
}
