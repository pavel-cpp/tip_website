import type { ApiErrorCode, ApiErrorEnvelope } from './types'

export class ApiError extends Error {
  override readonly name = 'ApiError'

  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError
}

/** Maps a failed response to ApiError using the {"error":{"code","message","details"}} envelope. */
export async function readApiError(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as Partial<ApiErrorEnvelope>
    if (body.error && typeof body.error.code === 'string') {
      return new ApiError(res.status, body.error.code, body.error.message ?? '', body.error.details)
    }
  } catch {
    // Not JSON (proxy error page, empty body): fall through to the generic error.
  }
  return new ApiError(res.status, 'UNKNOWN', res.statusText)
}

export function networkError(cause: unknown): ApiError {
  return new ApiError(0, 'NETWORK', cause instanceof Error ? cause.message : 'network error')
}
