import { api } from '../api/http'
import type { components } from '../api/schema.gen'
import { cancelRefresh, scheduleRefresh } from './proactiveRefresh'
import { refreshAccessToken } from './refresh'
import { clearAccessToken, setAccessToken } from './tokenStore'
import type { AuthUser, LoginResponse, TokenResponse } from './types'

type UserResponse = components['schemas']['UserResponse']

export async function loginRequest(login: string, password: string): Promise<AuthUser> {
  const res = await api.post<LoginResponse>('/auth/login', { login, password }, { skipAuthRetry: true })
  setAccessToken(res.accessToken)
  scheduleRefresh(res.expiresIn)
  return res.user
}

export async function fetchMe(): Promise<AuthUser> {
  return (await api.get<UserResponse>('/me')).user
}

/** Page load: the in-memory token is gone, the httpOnly cookie can still mint a new one. */
export async function restoreSession(): Promise<AuthUser> {
  await refreshAccessToken() // schedules the proactive refresh through the token event
  return fetchMe()
}

/** Always tells the server (it blacklists the token and revokes the chain), then forgets everything locally. */
export async function logoutRequest(): Promise<void> {
  try {
    await api.post('/auth/logout', undefined, { skipAuthRetry: true })
  } catch {
    // Offline or already expired: the local session still has to end.
  } finally {
    clearAccessToken()
    cancelRefresh()
  }
}

export async function changePasswordRequest(current: string, next: string): Promise<void> {
  const res = await api.post<TokenResponse>('/me/password', { current, new: next })
  // The server invalidates every older token and hands this client a fresh pair.
  setAccessToken(res.accessToken)
  scheduleRefresh(res.expiresIn)
}

const CHANNEL = 'tip-auth'

/** Tells other tabs that the user signed out here (their tokens are revoked server-side anyway). */
export function broadcastLogout(): void {
  if (typeof BroadcastChannel === 'undefined') return
  const ch = new BroadcastChannel(CHANNEL)
  ch.postMessage('logout')
  ch.close()
}

export function onRemoteLogout(cb: () => void): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => {}
  const ch = new BroadcastChannel(CHANNEL)
  ch.onmessage = (e: MessageEvent) => {
    if (e.data === 'logout') cb()
  }
  return () => ch.close()
}
