import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, readApiError } from '../../api/errors'
import { api } from '../../api/http'
import type { components } from '../../api/schema.gen'
import { getAccessToken } from '../../auth/tokenStore'

export type ProjectCardData = components['schemas']['ProjectCard']
export type Project = components['schemas']['Project']
export type ProjectStatus = components['schemas']['ProjectStatus']
export type UpdateProjectRequest = components['schemas']['UpdateProjectRequest']
type ProjectResponse = components['schemas']['ProjectResponse']

export const projectKeys = {
  list: ['projects', 'list'] as const,
  detail: (id: string) => ['projects', 'detail', id] as const,
}

/** How often the list is refetched to keep the "online now" avatars fresh (only while the tab is visible). */
export const PRESENCE_REFETCH_MS = 12_000

/**
 * One list request: the server already hides finished projects without project.view_finished.
 * It refetches on an interval for presence; `paused` stops that during a drag so cards do not jump.
 */
export function useProjects(paused = false) {
  return useQuery({
    queryKey: projectKeys.list,
    refetchInterval: paused ? false : PRESENCE_REFETCH_MS,
    queryFn: ({ signal }) => api.get<ProjectCardData[]>('/projects', { signal }),
  })
}

export function useProject(id: string) {
  return useQuery({
    queryKey: projectKeys.detail(id),
    queryFn: async ({ signal }) => (await api.get<ProjectResponse>(`/projects/${id}`, { signal })).project,
  })
}

export function useCreateProject() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (title: string) => (await api.post<ProjectResponse>('/projects', { title })).project,
    onSuccess: () => qc.invalidateQueries({ queryKey: projectKeys.list }),
  })
}

/** Finish / reopen with an optimistic status flip so the card moves between sections at once. */
export function useSetProjectStatus() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: ProjectStatus }) =>
      api.post<ProjectResponse>(`/projects/${id}/${status === 'finished' ? 'finish' : 'reopen'}`),
    onMutate: async ({ id, status }) => {
      await qc.cancelQueries({ queryKey: projectKeys.list })
      const previous = qc.getQueryData<ProjectCardData[]>(projectKeys.list)
      qc.setQueryData<ProjectCardData[]>(projectKeys.list, (list) =>
        list?.map((p) => (p.id === id ? { ...p, status } : p)),
      )
      return { previous }
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.previous) qc.setQueryData(projectKeys.list, ctx.previous)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: projectKeys.list }),
  })
}

export interface MoveProjectInput {
  /** Every visible project id in the wanted order, or null when only the status changes. */
  ids: string[] | null
  /** The project that crosses to the other section, if any. */
  status?: { id: string; status: ProjectStatus }
}

/**
 * Drag and drop result: optionally finish/reopen one project, then save the team order. The page
 * shows the new arrangement from its own state while this runs and drops it afterwards, so a failure
 * simply falls back to the server list.
 */
export function useMoveProject() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ ids, status }: MoveProjectInput) => {
      if (status)
        await api.post<ProjectResponse>(
          `/projects/${status.id}/${status.status === 'finished' ? 'finish' : 'reopen'}`,
        )
      if (ids) await api.put<void>('/projects/order', { ids })
    },
    onSettled: () => qc.invalidateQueries({ queryKey: projectKeys.list }),
  })
}

export function useDeleteProject() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/projects/${id}`),
    onSuccess: (_d, id) => {
      qc.setQueryData<ProjectCardData[]>(projectKeys.list, (list) => list?.filter((p) => p.id !== id))
      void qc.invalidateQueries({ queryKey: projectKeys.list })
    },
  })
}

export function useUpdateProject(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (body: UpdateProjectRequest) =>
      (await api.patch<ProjectResponse>(`/projects/${id}`, body)).project,
    onSuccess: (project) => {
      qc.setQueryData(projectKeys.detail(id), project)
      void qc.invalidateQueries({ queryKey: projectKeys.list })
    },
  })
}

/** Replaces the ticket image, reporting upload progress as a 0..1 fraction. */
export function useReplaceImage(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ file, onProgress }: { file: File; onProgress?: (fraction: number) => void }) =>
      uploadProjectImage(id, file, onProgress),
    onSuccess: (project) => {
      qc.setQueryData(projectKeys.detail(id), project)
      void qc.invalidateQueries({ queryKey: projectKeys.list })
    },
  })
}

/**
 * Multipart upload with progress. fetch has no upload progress events, so XHR is used, with the same
 * bearer token as api/http.ts. A 401 here is not retried: the settings screen refetches and the
 * next request goes through the shared refresh.
 */
export async function uploadProjectImage(
  id: string,
  file: File,
  onProgress?: (fraction: number) => void,
): Promise<Project> {
  const form = new FormData()
  form.set('file', file)
  return new Promise<Project>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', `/api/v1/projects/${id}/image`)
    const token = getAccessToken()
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)
    xhr.setRequestHeader('Accept', 'application/json')
    xhr.withCredentials = true
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded / e.total)
    }
    xhr.onerror = () => reject(new ApiError(0, 'NETWORK', 'network error'))
    xhr.onload = async () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve((JSON.parse(xhr.responseText) as ProjectResponse).project)
        } catch {
          reject(new ApiError(xhr.status, 'UNKNOWN', 'bad response'))
        }
        return
      }
      reject(
        await readApiError(
          new Response(xhr.responseText, { status: xhr.status, statusText: xhr.statusText }),
        ),
      )
    }
    xhr.send(form)
  })
}
