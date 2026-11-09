import { useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { useToast } from '../../components/Toast'
import { useI18n } from '../../i18n'
import { errorText } from '../../i18n/apiError'
import {
  type BatchItem,
  batchUpdateParticipants,
  clearParticipantRows,
  createParticipantRows,
  MAX_ADD_ROWS_PER_REQUEST,
  mergeRows,
  type Participant,
  participantKeys,
  putRows,
} from './api'
import type { PastePlan } from './tableLogic'

const UNDO_TOAST_MS = 8000

interface Options {
  projectId: string
  /** Moves the ticket, the selection and the table cursor to a row ("Show" in a toast). */
  follow: (id: string) => void
}

/**
 * Bulk data operations of the participants table: clearing rows and pasting a block of text. Both apply
 * to the cached list at once, send ONE batched request, and offer one Undo that restores the previous
 * values through the batch endpoint. Rows are never deleted, so undoing a paste that created rows
 * empties them instead.
 */
export function useParticipantOps({ projectId, follow }: Options) {
  const { t } = useI18n()
  const toast = useToast()
  const qc = useQueryClient()
  const key = participantKeys.list(projectId)

  const cached = useCallback(
    () => new Map((qc.getQueryData<{ items: Participant[] }>(key)?.items ?? []).map((r) => [r.id, r])),
    [qc, key],
  )

  /** Puts earlier values back; rows a colleague changed since are left alone and reported. */
  const restore = useCallback(
    async (prev: BatchItem[]) => {
      const rows = cached()
      const before = prev.flatMap((p) => {
        const r = rows.get(p.id)
        return r ? [r] : []
      })
      putRows(
        qc,
        projectId,
        prev.flatMap((p) => {
          const r = rows.get(p.id)
          return r
            ? [
                {
                  ...r,
                  ...(p.name !== undefined && { name: p.name }),
                  ...(p.phone !== undefined && { phone: p.phone }),
                },
              ]
            : []
        }),
      )
      try {
        const res = await batchUpdateParticipants(projectId, prev)
        putRows(qc, projectId, [...res.items, ...res.conflicts])
        if (res.conflicts.length > 0) {
          toast.show({ message: t('workspace.toast.restoreSkipped', { count: res.conflicts.length }) })
        }
      } catch (e) {
        putRows(qc, projectId, before)
        toast.show({ message: errorText(e), tone: 'error' })
      }
    },
    [cached, qc, projectId, toast, t],
  )

  const clear = useCallback(
    async (ids: readonly string[]) => {
      const rows = cached()
      const before = ids.flatMap((id) => {
        const r = rows.get(id)
        return r && (r.name !== '' || r.phone !== '') ? [r] : []
      })
      if (before.length === 0) {
        toast.show({ message: t('workspace.toast.nothingToClear') })
        return
      }
      putRows(
        qc,
        projectId,
        before.map((r) => ({ ...r, name: '', phone: '' })),
      )
      try {
        const res = await clearParticipantRows(
          projectId,
          before.map((r) => r.id),
        )
        putRows(qc, projectId, res.items)
        // Rows the server left alone (a colleague is editing them) keep their text on screen.
        const done = new Set(res.items.map((r) => r.id))
        putRows(
          qc,
          projectId,
          before.filter((r) => !done.has(r.id)),
        )
        if (res.items.length === 0) {
          toast.show({ message: t('workspace.toast.nothingToClear') })
          return
        }
        const old = new Map(before.map((r) => [r.id, r]))
        const prev: BatchItem[] = res.items.map((r) => ({
          id: r.id,
          version: r.version,
          name: old.get(r.id)?.name ?? '',
          phone: old.get(r.id)?.phone ?? '',
        }))
        toast.show({
          message: t('workspace.toast.cleared', { count: res.items.length }),
          action: { label: t('action.undo'), onAction: () => void restore(prev) },
          duration: UNDO_TOAST_MS,
        })
      } catch (e) {
        putRows(qc, projectId, before)
        toast.show({ message: errorText(e), tone: 'error' })
      }
    },
    [cached, qc, projectId, toast, t, restore],
  )

  const paste = useCallback(
    async (plan: PastePlan) => {
      const rows = cached()
      const items: BatchItem[] = plan.updates.map((u) => ({
        id: u.row.id,
        version: rows.get(u.row.id)?.version ?? u.row.version,
        ...(u.name !== undefined && { name: u.name }),
        ...(u.phone !== undefined && { phone: u.phone }),
      }))
      putRows(
        qc,
        projectId,
        plan.updates.map((u) => ({
          ...(rows.get(u.row.id) ?? u.row),
          ...(u.name !== undefined && { name: u.name }),
          ...(u.phone !== undefined && { phone: u.phone }),
        })),
      )
      const original = new Map(plan.updates.map((u) => [u.row.id, u.row]))

      const created: Participant[] = []
      const createAll = async () => {
        for (let i = 0; i < plan.creates.length; i += MAX_ADD_ROWS_PER_REQUEST) {
          const chunk = plan.creates.slice(i, i + MAX_ADD_ROWS_PER_REQUEST)
          const res = await createParticipantRows(projectId, chunk)
          created.push(...res)
          qc.setQueryData<{ items: Participant[] }>(key, (l) =>
            l ? { ...l, items: mergeRows(l.items, res) } : l,
          )
        }
      }

      const [batch, creation] = await Promise.allSettled([
        items.length > 0 ? batchUpdateParticipants(projectId, items) : Promise.resolve(null),
        createAll(),
      ])
      const written = batch.status === 'fulfilled' && batch.value ? batch.value.items : []
      const conflicts = batch.status === 'fulfilled' && batch.value ? batch.value.conflicts : []
      if (batch.status === 'rejected') {
        putRows(qc, projectId, [...original.values()])
      } else if (batch.value) {
        putRows(qc, projectId, [...written, ...conflicts])
      }
      void qc.invalidateQueries({ queryKey: ['projects', 'detail', projectId] })

      const failure =
        batch.status === 'rejected' ? batch.reason : creation.status === 'rejected' ? creation.reason : null
      if (failure) toast.show({ message: errorText(failure), tone: 'error' })
      if (written.length + created.length === 0) return

      const prev: BatchItem[] = [
        ...written.map((r) => {
          const o = original.get(r.id)
          const u = plan.updates.find((x) => x.row.id === r.id)
          return {
            id: r.id,
            version: r.version,
            ...(u?.name !== undefined && { name: o?.name ?? '' }),
            ...(u?.phone !== undefined && { phone: o?.phone ?? '' }),
          }
        }),
        ...created.map((r) => ({ id: r.id, version: r.version, name: '', phone: '' })),
      ]
      const firstId = plan.first?.id ?? created[0]?.id
      toast.show({
        message: t('workspace.toast.pasted', {
          count: written.length + created.length,
          number: plan.first?.number ?? created[0]?.number ?? '',
        }),
        action: { label: t('action.undo'), onAction: () => void restore(prev) },
        secondaryAction: firstId
          ? { label: t('workspace.toast.show'), onAction: () => follow(firstId) }
          : undefined,
        duration: UNDO_TOAST_MS,
      })
      if (conflicts.length > 0) {
        toast.show({ message: t('workspace.toast.pasteConflicts', { count: conflicts.length }) })
      }
    },
    [cached, qc, projectId, key, toast, t, restore, follow],
  )

  return { clear, paste }
}
