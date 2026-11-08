import { useCallback, useEffect, useRef, useState } from 'react'

/** Undo window: the toast lasts 5 s, the request waits a little longer so a last-moment Undo still wins. */
export const UNDO_MS = 5000
export const DELETE_DELAY_MS = UNDO_MS + 200
/** How long a row plays its collapse animation before it leaves the list. */
export const COLLAPSE_MS = 200

interface Options {
  /** Performs the real deletion; rejecting restores the rows. */
  commit: (ids: string[]) => Promise<unknown>
  onFailed?: (ids: string[], error: unknown) => void
}

interface Batch {
  ids: string[]
  timer: ReturnType<typeof setTimeout>
  collapse: ReturnType<typeof setTimeout>
}

/**
 * Deferred deletion with Undo. `request` hides rows at once (collapse animation, then removed from the
 * visible list) and sends the server request only after DELETE_DELAY_MS; `undo` cancels it.
 * Pending batches are flushed on unmount so leaving the page never silently drops a deletion.
 */
export function useUndoableDelete({ commit, onFailed }: Options) {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set())
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(new Set())
  const batches = useRef(new Map<number, Batch>())
  const seq = useRef(0)
  const latest = useRef({ commit, onFailed })
  latest.current = { commit, onFailed }

  const release = useCallback((ids: string[]) => {
    const drop = (s: ReadonlySet<string>) => {
      const next = new Set(s)
      for (const id of ids) next.delete(id)
      return next
    }
    setHidden(drop)
    setLeaving(drop)
  }, [])

  const send = useCallback(
    async (ids: string[]) => {
      try {
        await latest.current.commit(ids)
        // The cache no longer has the rows; stop hiding them.
        release(ids)
      } catch (e) {
        release(ids)
        latest.current.onFailed?.(ids, e)
      }
    },
    [release],
  )

  const request = useCallback(
    (ids: string[]): number => {
      const token = ++seq.current
      setLeaving((s) => new Set([...s, ...ids]))
      const collapse = setTimeout(() => {
        setLeaving((s) => {
          const next = new Set(s)
          for (const id of ids) next.delete(id)
          return next
        })
        setHidden((s) => new Set([...s, ...ids]))
      }, COLLAPSE_MS)
      const timer = setTimeout(() => {
        batches.current.delete(token)
        void send(ids)
      }, DELETE_DELAY_MS)
      batches.current.set(token, { ids, timer, collapse })
      return token
    },
    [send],
  )

  const undo = useCallback(
    (token: number) => {
      const batch = batches.current.get(token)
      if (!batch) return
      clearTimeout(batch.timer)
      clearTimeout(batch.collapse)
      batches.current.delete(token)
      release(batch.ids)
    },
    [release],
  )

  useEffect(() => {
    const pending = batches.current
    return () => {
      for (const batch of pending.values()) {
        clearTimeout(batch.timer)
        clearTimeout(batch.collapse)
        void latest.current.commit(batch.ids).catch(() => undefined)
      }
      pending.clear()
    }
  }, [])

  return { hidden, leaving, request, undo }
}
