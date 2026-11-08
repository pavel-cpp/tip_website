import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { isApiError } from '../../api/errors'
import { emitLogout, onTokenRefreshed } from '../../auth/events'
import { refreshAccessToken } from '../../auth/refresh'
import { getAccessToken } from '../../auth/tokenStore'
import { useToast } from '../../components/Toast'
import { useI18n } from '../../i18n'
import { type Project, projectKeys } from '../projects/api'
import { type Participant, participantKeys } from '../workspace/api'
import { applyDelete, applyUpsert } from './cache'
import { type ConnectionState, projectSocketUrl, RealtimeClient, type RealtimeSnapshot } from './client'
import { LockLease } from './lease'

/** Matches the collapse animation of the workspace table (useUndoableDelete). */
const COLLAPSE_MS = 200
const FRESH_MS = 1400

export interface DeniedLock {
  rowId: string
  by: string
  /** Increments per denial so the same row can be denied twice in a row. */
  seq: number
}

export interface ProjectRealtime {
  client: RealtimeClient
  lease: LockLease
  snapshot: RealtimeSnapshot
  state: ConnectionState
  denied: DeniedLock | null
  /** Rows deleted by a colleague that are playing their collapse animation. */
  leaving: ReadonlySet<string>
  /** Rows inserted by a colleague (brief highlight). */
  remoteFresh: ReadonlySet<string>
}

type ListData = { items: Participant[]; rev: number }

/**
 * Owns the realtime connection of one project page: starts the client, keeps the participants cache and
 * the project in sync with pushed frames, and exposes presence, locks and connection state.
 */
export function useProjectRealtime(projectId: string, enabled = true): ProjectRealtime {
  const qc = useQueryClient()
  const toast = useToast()
  const { t } = useI18n()
  const [denied, setDenied] = useState<DeniedLock | null>(null)
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(new Set())
  const [remoteFresh, setRemoteFresh] = useState<ReadonlySet<string>>(new Set())
  const deniedSeq = useRef(0)
  const notify = useRef({ toast, t })
  notify.current = { toast, t }

  const { client, lease } = useMemo(() => {
    const c = new RealtimeClient({
      url: projectSocketUrl(projectId),
      getToken: getAccessToken,
      refresh: refreshAccessToken,
      onTokenRefreshed: (cb) => onTokenRefreshed(() => cb()),
      isFatalAuthError: (e) => isApiError(e) && e.status === 401,
      onAuthLost: emitLogout,
    })
    const l = new LockLease(c, (rowId, by) => setDenied({ rowId, by, seq: ++deniedSeq.current }))
    return { client: c, lease: l }
  }, [projectId])

  useEffect(() => {
    if (!enabled) return
    const timers = new Set<ReturnType<typeof setTimeout>>()
    const later = (fn: () => void, ms: number) => {
      const id = setTimeout(() => {
        timers.delete(id)
        fn()
      }, ms)
      timers.add(id)
    }
    const listKey = participantKeys.list(projectId)
    const detailKey = projectKeys.detail(projectId)
    let first = true

    const off = client.onEvent((e) => {
      switch (e.type) {
        case 'hello':
          // Resync after every (re)connect; the ETag makes an unchanged table a cheap 304.
          void qc.refetchQueries({ queryKey: listKey }, { cancelRefetch: false })
          if (!first) void qc.invalidateQueries({ queryKey: detailKey })
          first = false
          break
        case 'rows.upsert': {
          const before = qc.getQueryData<ListData>(listKey)
          const res = applyUpsert(before, e.items)
          if (res.list !== before) qc.setQueryData<ListData>(listKey, res.list)
          if (res.inserted.length > 0) {
            const ids = res.inserted
            setRemoteFresh((s) => new Set([...s, ...ids]))
            later(
              () =>
                setRemoteFresh((s) => {
                  const next = new Set(s)
                  for (const id of ids) next.delete(id)
                  return next
                }),
              FRESH_MS,
            )
          }
          break
        }
        case 'rows.delete': {
          const ids = e.ids
          setLeaving((s) => new Set([...s, ...ids]))
          later(() => {
            qc.setQueryData<ListData>(listKey, (l) => applyDelete(l, ids))
            setLeaving((s) => {
              const next = new Set(s)
              for (const id of ids) next.delete(id)
              return next
            })
          }, COLLAPSE_MS)
          break
        }
        case 'project.updated': {
          const before = qc.getQueryData<Project>(detailKey)
          const { project } = e
          if (before) {
            qc.setQueryData<Project>(detailKey, {
              ...before,
              title: project.title,
              status: project.status,
              version: project.version,
            })
            if (project.status === 'finished' && before.status !== 'finished') {
              notify.current.toast.show({ message: notify.current.t('realtime.toast.finished') })
            }
          }
          void qc.invalidateQueries({ queryKey: detailKey })
          break
        }
        case 'lock.denied':
        case 'error':
        case 'hidden':
        case 'authLost':
          break
      }
    })

    client.start()
    return () => {
      off()
      for (const id of timers) clearTimeout(id)
      lease.releaseAll()
      client.stop()
    }
  }, [client, lease, qc, projectId, enabled])

  const snapshot = useSyncExternalStore(client.subscribe, client.getSnapshot)
  return { client, lease, snapshot, state: snapshot.state, denied, leaving, remoteFresh }
}
