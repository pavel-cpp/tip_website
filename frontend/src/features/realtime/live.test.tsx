import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '../../components/Toast'
import { ru } from '../../i18n/ru'
import { uz } from '../../i18n/uz'
import { projectKeys } from '../projects/api'
import { type Participant, participantKeys } from '../workspace/api'
import { buildRowPresence } from '../workspace/presence'
import { applyDelete, applyUpsert } from './cache'
import { FakeSocket } from './fakeSocket'
import { realtimeRu } from './messages.ru'
import { realtimeUz } from './messages.uz'
import type { ProjectRealtime } from './useProjectRealtime'
import { useProjectRealtime } from './useProjectRealtime'

const row = (n: number, version = 1, name = `P${n}`): Participant => ({
  id: `r${n}`,
  projectId: 'p1',
  number: n,
  name,
  phone: '1',
  version,
  updatedAt: '2026-11-07T10:00:00Z',
})

describe('applyUpsert / applyDelete', () => {
  const list = { items: [row(1), row(3, 2)], rev: 1 }

  it('replaces only rows with a greater version', () => {
    const stale = applyUpsert(list, [row(3, 2, 'same'), row(1, 0, 'older')])
    expect(stale.list).toBe(list)
    const fresh = applyUpsert(list, [row(3, 3, 'newer')])
    expect(fresh.list?.items[1]?.name).toBe('newer')
    expect(fresh.inserted).toEqual([])
  })

  it('inserts unknown rows in number order', () => {
    const res = applyUpsert(list, [row(2)])
    expect(res.list?.items.map((r) => r.number)).toEqual([1, 2, 3])
    expect(res.inserted).toEqual(['r2'])
  })

  it('leaves a missing list alone and deletes by id', () => {
    expect(applyUpsert(undefined, [row(1)]).list).toBeUndefined()
    expect(applyDelete(list, ['r1'])?.items.map((r) => r.id)).toEqual(['r3'])
    expect(applyDelete(list, ['zzz'])).toBe(list)
  })
})

describe('buildRowPresence', () => {
  const peers = [
    { id: 'me', displayName: 'Me', color: '#111', avatarUrl: null },
    { id: 'u2', displayName: 'Azam', color: '#f00', avatarUrl: null },
  ]

  it('excludes the own lock and own cursor', () => {
    const p = buildRowPresence(
      'me',
      peers,
      { r1: { by: 'me' }, r2: { by: 'u2' } },
      { me: { rowId: 'r1' }, u2: { rowId: 'r2' } },
      'Someone',
    )
    expect([...p.locks.keys()]).toEqual(['r2'])
    expect(p.locks.get('r2')?.displayName).toBe('Azam')
    expect(p.cursors.get('r1')).toBeUndefined()
    expect(p.cursors.get('r2')?.[0]?.color).toBe('#f00')
  })

  it('names an unknown lock holder generically', () => {
    const p = buildRowPresence('me', peers, { r9: { by: 'ghost' } }, {}, 'Someone')
    expect(p.locks.get('r9')?.displayName).toBe('Someone')
  })
})

describe('i18n parity', () => {
  it('has the same keys in ru and uz', () => {
    expect(Object.keys(realtimeUz).sort()).toEqual(Object.keys(realtimeRu).sort())
    for (const k of Object.keys(realtimeRu)) {
      expect(k in ru && k in uz, k).toBe(true)
    }
  })
})

describe('useProjectRealtime', () => {
  let rt: ProjectRealtime | undefined
  let qc: QueryClient

  function Probe() {
    rt = useProjectRealtime('p1')
    return null
  }

  beforeEach(() => {
    vi.useFakeTimers()
    FakeSocket.reset()
    vi.stubGlobal('WebSocket', FakeSocket)
    qc = new QueryClient()
    qc.setQueryData(participantKeys.list('p1'), { items: [row(1), row(2)], rev: 1 })
    qc.setQueryData(projectKeys.detail('p1'), { id: 'p1', title: 'T', status: 'active', version: 1 })
    render(
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <Probe />
        </ToastProvider>
      </QueryClientProvider>,
    )
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const server = () => FakeSocket.last
  const goOnline = () => {
    act(() => {
      server().open()
      server().receive({ t: 'hello', you: 'me', peers: [], cursors: {}, locks: {}, serverTime: '' })
    })
  }
  const items = () => qc.getQueryData<{ items: Participant[] }>(participantKeys.list('p1'))?.items

  it('goes online and applies version-guarded upserts and inserts', () => {
    goOnline()
    expect(rt?.state).toBe('online')
    act(() => server().receive({ t: 'rows.upsert', items: [row(1, 5, 'Fresh'), row(2, 1, 'Stale'), row(3)] }))
    expect(items()?.map((r) => r.name)).toEqual(['Fresh', 'P2', 'P3'])
    expect(rt?.remoteFresh.has('r3')).toBe(true)
  })

  it('collapses deleted rows before removing them', () => {
    goOnline()
    act(() => server().receive({ t: 'rows.delete', ids: ['r1'] }))
    expect(rt?.leaving.has('r1')).toBe(true)
    expect(items()).toHaveLength(2)
    act(() => {
      vi.advanceTimersByTime(250)
    })
    expect(items()?.map((r) => r.id)).toEqual(['r2'])
    expect(rt?.leaving.size).toBe(0)
  })

  it('switches the project to finished', () => {
    goOnline()
    act(() =>
      server().receive({
        t: 'project.updated',
        project: { id: 'p1', title: 'T', status: 'finished', version: 2 },
      }),
    )
    expect(qc.getQueryData<{ status: string }>(projectKeys.detail('p1'))?.status).toBe('finished')
  })

  it('surfaces lock.denied to the table', () => {
    goOnline()
    act(() => rt?.lease.acquire('r1'))
    act(() => server().receive({ t: 'lock.denied', rowId: 'r1', by: 'u2' }))
    expect(rt?.denied).toMatchObject({ rowId: 'r1', by: 'u2' })
  })
})
