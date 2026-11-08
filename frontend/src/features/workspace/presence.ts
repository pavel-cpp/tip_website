/**
 * Seam for realtime presence. The workspace table only consumes this shape; the realtime stream
 * replaces the body of `useRowPresence` with data from the WebSocket hub and nothing else changes.
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
  /** Colleagues merely looking at a row, by participant id. */
  cursors: ReadonlyMap<string, readonly RowCursor[]>
}

const EMPTY: RowPresence = { locks: new Map(), cursors: new Map() }

export function useRowPresence(_projectId: string): RowPresence {
  return EMPTY
}
