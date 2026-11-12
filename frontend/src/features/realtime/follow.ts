import type { CursorPos, LockEntry } from './protocol'

export interface PeerStatus {
  rowId: string | null
  /** Column the peer is on ("name" or "phone"), when known. */
  field?: string
  editing: boolean
}

/** What a colleague is doing right now: a held row lock means editing, otherwise the cursor means looking. */
export function peerStatus(
  userId: string,
  cursors: Readonly<Record<string, CursorPos>>,
  locks: Readonly<Record<string, LockEntry>>,
): PeerStatus {
  const cursor = cursors[userId]
  const lockedRow = Object.entries(locks).find(([, l]) => l.by === userId)?.[0]
  if (lockedRow) {
    const field = cursor?.rowId === lockedRow ? cursor.field : undefined
    return { rowId: lockedRow, ...(field ? { field } : {}), editing: true }
  }
  if (cursor?.rowId) {
    return { rowId: cursor.rowId, ...(cursor.field ? { field: cursor.field } : {}), editing: false }
  }
  return { rowId: null, editing: false }
}

/** Row to jump to while following: only when the peer moved and the row still exists. */
export function followJump(
  rowId: string | null,
  lastJumped: string | null,
  exists: (id: string) => boolean,
): string | null {
  if (!rowId || rowId === lastJumped || !exists(rowId)) return null
  return rowId
}
