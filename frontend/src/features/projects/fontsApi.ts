import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../api/http'
import type { components } from '../../api/schema.gen'

export type CustomFont = components['schemas']['Font']

/** Client-side mirror of the server limits (domain.MaxFontBytes and friends); the server stays the authority. */
export const FONT_LIMITS = { maxBytes: 2 << 20, maxNameLength: 60 } as const

export const fontKeys = { list: ['fonts'] as const }

export function useFonts() {
  return useQuery({
    queryKey: fontKeys.list,
    queryFn: ({ signal }) => api.get<CustomFont[]>('/fonts', { signal }),
    staleTime: 60_000,
  })
}

export interface FontUploadInput {
  file: File
  name: string
  licenseConfirmed: boolean
}

export function useUploadFont() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ file, name, licenseConfirmed }: FontUploadInput) => {
      const form = new FormData()
      form.set('name', name)
      form.set('licenseConfirmed', String(licenseConfirmed))
      form.set('file', file)
      return api.post<CustomFont>('/fonts', form)
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: fontKeys.list }),
  })
}

export function useDeleteFont() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/fonts/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: fontKeys.list }),
  })
}

const FONT_EXT = /\.(ttf|otf|woff2)$/i

/** Why a chosen file cannot be uploaded as a font, or null when it looks fine (the server re-checks the content). */
export function fontFileProblem(file: { name: string; size: number }): 'type' | 'size' | null {
  if (!FONT_EXT.test(file.name)) return 'type'
  if (file.size > FONT_LIMITS.maxBytes) return 'size'
  return null
}

/** A readable default display name from a file name: extension dropped, separators turned into spaces. */
export function fontNameFromFile(fileName: string): string {
  return fileName.replace(FONT_EXT, '').replace(/[_-]+/g, ' ').trim().slice(0, FONT_LIMITS.maxNameLength)
}
