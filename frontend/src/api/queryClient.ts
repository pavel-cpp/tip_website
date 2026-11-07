import { QueryClient } from '@tanstack/react-query'
import { isApiError } from './errors'

/** Retries only transient failures (network, 5xx, rate limit); client errors will not fix themselves. */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= 2) return false
  if (!isApiError(error)) return true
  return error.status === 0 || error.status >= 500 || error.code === 'RATE_LIMITED'
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: 30_000, gcTime: 5 * 60_000, retry: shouldRetry, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  })
}
