import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { COLLAPSE_MS, DELETE_DELAY_MS, useUndoableDelete } from './useUndoableDelete'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function setup(commit = vi.fn(async () => ({ deleted: 2 })), onFailed = vi.fn()) {
  const hook = renderHook(() => useUndoableDelete({ commit, onFailed }))
  return { ...hook, commit, onFailed }
}

describe('useUndoableDelete', () => {
  it('hides rows right away but sends the request only after the undo window', async () => {
    const { result, commit } = setup()
    act(() => void result.current.request(['a', 'b']))
    expect(result.current.leaving.has('a')).toBe(true)

    act(() => vi.advanceTimersByTime(COLLAPSE_MS))
    expect(result.current.leaving.size).toBe(0)
    expect(result.current.hidden.has('a') && result.current.hidden.has('b')).toBe(true)
    expect(commit).not.toHaveBeenCalled()

    await act(async () => {
      vi.advanceTimersByTime(DELETE_DELAY_MS)
    })
    expect(commit).toHaveBeenCalledExactlyOnceWith(['a', 'b'])
  })

  it('never sends the request when Undo is pressed inside the window and shows the rows again', () => {
    const { result, commit } = setup()
    let token = 0
    act(() => {
      token = result.current.request(['a'])
    })
    act(() => vi.advanceTimersByTime(4900))
    expect(result.current.hidden.has('a')).toBe(true)

    act(() => result.current.undo(token))
    expect(result.current.hidden.size).toBe(0)
    act(() => vi.advanceTimersByTime(60_000))
    expect(commit).not.toHaveBeenCalled()
  })

  it('keeps batches independent: undoing one does not cancel another', async () => {
    const { result, commit } = setup()
    let first = 0
    act(() => {
      first = result.current.request(['a'])
      result.current.request(['b'])
    })
    act(() => result.current.undo(first))
    await act(async () => {
      vi.advanceTimersByTime(DELETE_DELAY_MS)
    })
    expect(commit).toHaveBeenCalledExactlyOnceWith(['b'])
  })

  it('restores the rows and reports the error when the request fails', async () => {
    const boom = new Error('boom')
    const { result, onFailed } = setup(vi.fn().mockRejectedValue(boom))
    act(() => void result.current.request(['a']))
    await act(async () => {
      vi.advanceTimersByTime(DELETE_DELAY_MS)
    })
    expect(onFailed).toHaveBeenCalledWith(['a'], boom)
    expect(result.current.hidden.size).toBe(0)
  })

  it('flushes pending deletions on unmount instead of dropping them', () => {
    const { result, unmount, commit } = setup()
    act(() => void result.current.request(['a']))
    unmount()
    expect(commit).toHaveBeenCalledExactlyOnceWith(['a'])
  })
})
