import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, apiRequest } from '../../api/http'
import type { components } from '../../api/schema.gen'

export type Participant = components['schemas']['Participant']
export type ParticipantInput = components['schemas']['ParticipantInput']
export type ImportResult = components['schemas']['ImportResult']
export type ImportMode = ImportResult['mode']
type ParticipantList = components['schemas']['ParticipantList']

export const participantKeys = {
  list: (projectId: string) => ['projects', projectId, 'participants'] as const,
}

// The last 200 response per project with its ETag. A 304 answer means "unchanged since this one",
// so it is served from here rather than from the query cache, which may hold optimistic edits.
const lastSeen = new Map<string, { etag: string; data: ParticipantList }>()

export function clearParticipantEtags(): void {
  lastSeen.clear()
}

export async function fetchParticipants(projectId: string, signal?: AbortSignal): Promise<ParticipantList> {
  const seen = lastSeen.get(projectId)
  const res = await apiRequest(`/projects/${projectId}/participants`, {
    signal,
    headers: seen ? { 'If-None-Match': seen.etag } : undefined,
  })
  if (res.status === 304 && seen) return seen.data
  const data = (await res.json()) as ParticipantList
  const etag = res.headers.get('ETag')
  if (etag) lastSeen.set(projectId, { etag, data })
  return data
}

export function useParticipants(projectId: string, enabled = true) {
  return useQuery({
    queryKey: participantKeys.list(projectId),
    queryFn: ({ signal }) => fetchParticipants(projectId, signal),
    enabled,
    // One quick retry: a failing list must show its error with "Retry" within about 3 s, not skeletons for 10.
    retry: 1,
    retryDelay: 600,
  })
}

function patchList(
  list: ParticipantList | undefined,
  fn: (items: Participant[]) => Participant[],
): ParticipantList | undefined {
  return list ? { ...list, items: fn(list.items) } : list
}

/**
 * Merges rows into a cached list by id. A realtime push can deliver our own new rows before the
 * HTTP response is handled, so appending blindly would show every created row twice.
 */
export function mergeRows(current: readonly Participant[], incoming: readonly Participant[]): Participant[] {
  const byId = new Map(current.map((r) => [r.id, r]))
  for (const row of incoming) {
    const have = byId.get(row.id)
    if (!have || row.version > have.version) byId.set(row.id, row)
  }
  return [...byId.values()].sort((a, b) => a.number - b.number)
}

export interface UpdateVars {
  id: string
  version: number
  name?: string
  phone?: string
}

/** PATCH with an optimistic cache update that is rolled back on any failure. */
export function useUpdateParticipant(projectId: string) {
  const qc = useQueryClient()
  const key = participantKeys.list(projectId)
  return useMutation({
    mutationFn: async ({ id, ...body }: UpdateVars) =>
      (await api.patch<{ item: Participant }>(`/participants/${id}`, body)).item,
    onMutate: async ({ id, name, phone }) => {
      await qc.cancelQueries({ queryKey: key })
      const previous = qc.getQueryData<ParticipantList>(key)
      qc.setQueryData<ParticipantList>(key, (list) =>
        patchList(list, (items) =>
          items.map((p) =>
            p.id === id
              ? { ...p, ...(name !== undefined && { name }), ...(phone !== undefined && { phone }) }
              : p,
          ),
        ),
      )
      return { previous }
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.previous) qc.setQueryData(key, ctx.previous)
    },
    onSuccess: (item) => {
      qc.setQueryData<ParticipantList>(key, (list) =>
        patchList(list, (items) => items.map((p) => (p.id === item.id ? item : p))),
      )
    },
  })
}

export type CreateVars = { count: number } | { items: ParticipantInput[] }

export function useCreateParticipants(projectId: string) {
  const qc = useQueryClient()
  const key = participantKeys.list(projectId)
  return useMutation({
    mutationFn: async (vars: CreateVars) =>
      (await api.post<{ items: Participant[] }>(`/projects/${projectId}/participants`, vars)).items,
    onSuccess: (items) => {
      qc.setQueryData<ParticipantList>(key, (list) => patchList(list, (cur) => mergeRows(cur, items)))
      void qc.invalidateQueries({ queryKey: ['projects', 'detail', projectId] })
    },
  })
}

/** The request itself; hiding rows and the undo window live in useUndoableDelete. */
export function useDeleteParticipants(projectId: string) {
  const qc = useQueryClient()
  const key = participantKeys.list(projectId)
  return useMutation({
    mutationFn: (ids: string[]) =>
      api.post<{ deleted: number }>(`/projects/${projectId}/participants/delete`, { ids }),
    onSuccess: (_r, ids) => {
      const gone = new Set(ids)
      qc.setQueryData<ParticipantList>(key, (list) =>
        patchList(list, (items) => items.filter((p) => !gone.has(p.id))),
      )
      void qc.invalidateQueries({ queryKey: ['projects', 'detail', projectId] })
    },
  })
}

export function logPrinted(projectId: string, ids: string[]): Promise<void> {
  return api.post<void>(`/projects/${projectId}/participants/printed`, { ids })
}

/** Uploads a file for import; with `dryRun` nothing is written and the result lists row errors. */
export function importParticipants(
  projectId: string,
  file: File,
  mode: ImportMode,
  dryRun: boolean,
): Promise<ImportResult> {
  const form = new FormData()
  form.set('file', file)
  form.set('mode', mode)
  return api.post<ImportResult>(`/projects/${projectId}/participants/import`, form, {
    query: dryRun ? { dryRun: 1 } : undefined,
  })
}

export type ExportFormat = 'xlsx' | 'csv'

export async function downloadExport(projectId: string, format: ExportFormat): Promise<Blob> {
  const res = await apiRequest(`/projects/${projectId}/export.${format}`, { headers: { Accept: '*/*' } })
  return res.blob()
}
