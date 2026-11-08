// Wire types of the project WebSocket (docs/04-api.md, section 7).
import type { Participant } from '../workspace/api'

export interface Peer {
  id: string
  displayName: string
  color: string
  avatarUrl: string | null
}

export interface CursorPos {
  rowId: string | null
  field?: string
}

export interface LockEntry {
  by: string
  expiresAt: string
}

/** Subset of the project the server pushes with project.updated (no contributors or counts). */
export interface ProjectUpdate {
  id: string
  title: string
  status: 'active' | 'finished'
  version: number
}

export type ServerFrame =
  | {
      t: 'hello'
      you: string
      peers: Peer[]
      cursors: Record<string, CursorPos>
      locks: Record<string, LockEntry>
      serverTime: string
    }
  | { t: 'reauth' }
  | { t: 'presence'; peers: Peer[] }
  | ({ t: 'cursor'; userId: string } & CursorPos)
  | { t: 'lock' | 'unlock'; rowId: string; by: string; expiresAt: string }
  | { t: 'lock.denied'; rowId: string; by: string }
  | { t: 'rows.upsert'; items: Participant[] }
  | { t: 'rows.delete'; ids: string[] }
  | { t: 'project.updated'; project: ProjectUpdate }
  | { t: 'error'; code: string; message: string }

export type ClientFrame =
  | { t: 'auth'; token: string }
  | { t: 'ping' }
  | { t: 'cursor'; rowId: string | null; field?: string }
  | { t: 'lock.acquire'; rowId: string }
  | { t: 'lock.release'; rowId: string }

/** Close codes the server uses (docs/04-api.md, section 7, lifecycle). */
export const CLOSE_POLICY = 1008
export const CLOSE_GOING_AWAY = 1001
export const CLOSE_TRY_AGAIN = 1013
