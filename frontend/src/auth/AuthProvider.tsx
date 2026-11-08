import { useQueryClient } from '@tanstack/react-query'
import {
  createContext,
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'
import { isApiError } from '../api/errors'
import { getLocale, setLocale } from '../i18n'
import { getThemeMode, setThemeMode } from '../theme/theme'
import { onLogout } from './events'
import { cancelRefresh, watchRefresh } from './proactiveRefresh'
import {
  broadcastLogout,
  fetchMe,
  loginRequest,
  logoutRequest,
  onRemoteLogout,
  restoreSession,
} from './session'
import { clearAccessToken } from './tokenStore'
import type { AuthUser } from './types'

// Loaded on demand: most sessions never need the password prompt.
const PasswordPrompt = lazy(() => import('../features/auth/PasswordPrompt'))

export type AuthStatus = 'loading' | 'authenticated' | 'anonymous' | 'unavailable'

export interface AuthContextValue {
  status: AuthStatus
  user: AuthUser | null
  login: (login: string, password: string) => Promise<AuthUser>
  logout: () => Promise<void>
  /** Replaces the cached user, e.g. with the response of PATCH /me. */
  setUser: (user: AuthUser) => void
  /** Re-reads /me (after a password change the flag passwordTemporary flips). */
  reloadUser: () => Promise<void>
  /** Retries the startup session restore after a network failure. */
  retry: () => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

/** Server-stored language and theme win over this device's local choice once we know who signed in. */
function applyUserPreferences(user: AuthUser): void {
  if (user.locale !== getLocale()) void setLocale(user.locale)
  if (user.theme !== getThemeMode()) setThemeMode(user.theme)
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const [status, setStatus] = useState<AuthStatus>('loading')
  const [user, setUserState] = useState<AuthUser | null>(null)
  const [snoozed, setSnoozed] = useState(false)
  const [forced, setForced] = useState(false)
  const [attempt, setAttempt] = useState(0)

  const adopt = useCallback((u: AuthUser) => {
    setUserState(u)
    setStatus('authenticated')
    applyUserPreferences(u)
  }, [])

  const forget = useCallback(() => {
    clearAccessToken()
    cancelRefresh()
    setUserState(null)
    setStatus('anonymous')
    setSnoozed(false)
    setForced(false)
  }, [])

  // Startup: restore the session from the refresh cookie.
  useEffect(() => {
    let cancelled = false
    setStatus('loading')
    restoreSession().then(
      (u) => !cancelled && adopt(u),
      (e: unknown) => {
        if (cancelled) return
        // 401 already emitted logout; a dead network or backend is not "signed out".
        setStatus(isApiError(e) && e.status === 401 ? 'anonymous' : 'unavailable')
      },
    )
    return () => {
      cancelled = true
    }
  }, [adopt, attempt])

  useEffect(() => watchRefresh(), [])
  useEffect(() => onLogout(forget), [forget])
  useEffect(() => onRemoteLogout(forget), [forget])

  // Any failed call may carry PASSWORD_CHANGE_REQUIRED (server runs with FORCE_PASSWORD_CHANGE=true).
  useEffect(() => {
    const watch = (event: { type: string; action?: { type: string; error?: unknown } }) => {
      const err = event.action?.error
      if (event.type === 'updated' && event.action?.type === 'error') {
        if (isApiError(err) && err.code === 'PASSWORD_CHANGE_REQUIRED') setForced(true)
      }
    }
    const offQ = queryClient.getQueryCache().subscribe(watch)
    const offM = queryClient.getMutationCache().subscribe(watch)
    return () => {
      offQ()
      offM()
    }
  }, [queryClient])

  const login = useCallback(
    async (loginName: string, password: string) => {
      const u = await loginRequest(loginName, password)
      adopt(u)
      return u
    },
    [adopt],
  )

  const logout = useCallback(async () => {
    await logoutRequest()
    broadcastLogout()
    queryClient.clear()
    forget()
  }, [forget, queryClient])

  const reloadUser = useCallback(async () => {
    adopt(await fetchMe())
  }, [adopt])

  const retry = useCallback(() => setAttempt((n) => n + 1), [])

  const value = useMemo<AuthContextValue>(
    () => ({ status, user, login, logout, setUser: adopt, reloadUser, retry }),
    [status, user, login, logout, adopt, reloadUser, retry],
  )

  const promptOpen = status === 'authenticated' && (forced || (user?.passwordTemporary === true && !snoozed))

  return (
    <AuthContext.Provider value={value}>
      {children}
      {promptOpen && (
        <Suspense fallback={null}>
          <PasswordPrompt
            required={forced}
            onLater={() => setSnoozed(true)}
            onChanged={() => setForced(false)}
          />
        </Suspense>
      )}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}

/** For shared chrome (topbar) that also renders without a provider, e.g. in isolated tests. */
export function useOptionalAuth(): AuthContextValue | null {
  return useContext(AuthContext)
}
