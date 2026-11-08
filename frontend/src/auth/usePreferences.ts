import { useCallback } from 'react'
import { useToast } from '../components/Toast'
import { updateMe } from '../features/profile/api'
import { errorText } from '../i18n/apiError'
import { useOptionalAuth } from './AuthProvider'
import type { Locale, ThemePref } from './types'

/**
 * Stores a language or theme choice on the server for a signed-in user (the caller applies it locally
 * first). Anonymous visitors keep localStorage only, so this is a no-op for them. Shared by the top bar
 * menus and the profile page so both behave the same.
 */
export function usePersistPreference(): (patch: { locale: Locale } | { theme: ThemePref }) => Promise<void> {
  const auth = useOptionalAuth()
  const toast = useToast()
  const signedIn = auth?.status === 'authenticated'
  const setUser = auth?.setUser
  return useCallback(
    async (patch) => {
      if (!signedIn || !setUser) return
      try {
        // Adopting the response only refreshes the cached user; it never re-applies preferences locally,
        // so a newer local choice cannot be undone by a slower reply.
        setUser(await updateMe(patch))
      } catch (err) {
        toast.show({ message: errorText(err), tone: 'error' })
      }
    },
    [signedIn, setUser, toast],
  )
}
