// The access token lives in module memory only: never localStorage/sessionStorage/cookies.
// After a page reload the SPA gets a fresh one through POST /api/v1/auth/refresh (httpOnly cookie).
let accessToken: string | null = null

export function getAccessToken(): string | null {
  return accessToken
}

export function setAccessToken(token: string): void {
  accessToken = token
}

export function clearAccessToken(): void {
  accessToken = null
}
