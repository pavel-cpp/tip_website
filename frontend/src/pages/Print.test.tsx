import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearAccessToken } from '../auth/tokenStore'
import { clearParticipantEtags, type Participant } from '../features/workspace/api'
import { clearPrintJob, setPrintJob } from '../features/workspace/printJob'
import { initI18n } from '../i18n'
import { TICKETS_PER_PAGE } from '../lib/ticket'
import { callLog, jsonRes, stubFetch } from '../test/mockApi'
import Print from './Print'

const rendered = vi.hoisted(() => ({ batch: vi.fn() }))
vi.mock('../features/workspace/ticketActions', async (orig) => ({
  ...(await orig<typeof import('../features/workspace/ticketActions')>()),
  renderPrintBatch: rendered.batch,
}))
// jsdom never decodes images, so the ticket image element is faked.
vi.mock('../lib/ticket', async (orig) => ({
  ...(await orig<typeof import('../lib/ticket')>()),
  useImageElement: (src: string | null) => (src ? ({ width: 700, height: 400 } as HTMLImageElement) : null),
}))

const bodyOf = (call: readonly unknown[] | undefined): string =>
  String((call?.[1] as RequestInit | undefined)?.body)

const ph = {
  font: 'Inter',
  size: 30,
  stroke: 0,
  color: '#fff',
  strokeColor: '#000',
  bold: false,
  italic: false,
  underline: false,
  x: 10,
  y: 10,
}
const people: Participant[] = Array.from({ length: 25 }, (_, i) => ({
  id: `id${i + 1}`,
  projectId: 'p1',
  number: i + 1,
  name: `Name ${i + 1}`,
  phone: '+1',
  version: 1,
  updatedAt: '2026-11-07T10:00:00Z',
}))

beforeAll(() => initI18n())
beforeEach(() => {
  clearParticipantEtags()
  let n = 0
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:t${n++}`)
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
  window.print = vi.fn()
  rendered.batch.mockImplementation(
    async (_s: unknown, rows: Participant[], onProgress: (d: number, t: number) => void) => {
      for (const [i] of rows.entries()) onProgress(i + 1, rows.length)
      return rows.map(() => new Blob(['j'], { type: 'image/jpeg' }))
    },
  )
})
afterEach(() => {
  clearAccessToken()
  clearPrintJob()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function mount() {
  const mock = stubFetch(({ method, path }) => {
    if (path === '/projects/p1') {
      return jsonRes(200, {
        project: {
          id: 'p1',
          title: 'T',
          status: 'active',
          version: 1,
          image: { url: '/api/v1/projects/p1/image?v=1', name: 'a.png', w: 700, h: 400, bytes: 1 },
          placeholders: { number: ph, name: ph, phone: ph },
          contributors: [],
          participantCount: people.length,
          createdAt: '2026-11-01T09:00:00Z',
        },
      })
    }
    if (path === '/projects/p1/participants' && method === 'GET')
      return jsonRes(200, { items: people, rev: 1 })
    if (path === '/projects/p1/image?v=1') return new Response(new Blob(['png']), { status: 200 })
    if (path === '/projects/p1/participants/printed') return new Response(null, { status: 204 })
    return undefined
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/projects/p1/print']}>
        <Routes>
          <Route path="/projects/:id/print" element={<Print />} />
          <Route path="/projects/:id" element={<p>workspace</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return mock
}

describe('print page', () => {
  it('returns to the workspace when there is nothing to print', () => {
    mount()
    expect(screen.getByText('workspace')).toBeInTheDocument()
  })

  it('lays tickets out as A4 sheets of 21, with the print CSS, then prints and records only ids', async () => {
    setPrintJob({ projectId: 'p1', ids: people.map((p) => p.id) })
    const mock = mount()

    await waitFor(() => expect(screen.getAllByRole('region')).toHaveLength(2))
    const pages = screen.getAllByRole('region')
    expect(pages[0]?.querySelectorAll('img.print-ticket')).toHaveLength(TICKETS_PER_PAGE)
    expect(pages[1]?.querySelectorAll('img.print-ticket')).toHaveLength(25 - TICKETS_PER_PAGE)
    expect(TICKETS_PER_PAGE).toBe(21)

    const css = document.querySelector('style')?.textContent ?? ''
    expect(css).toContain('@page { size: A4; margin: 0mm }')
    expect(css).toContain('width: 70mm')
    expect(css).toContain('height: 40mm')
    expect(css).toContain('object-fit: fill')

    expect(screen.getByRole('status')).toHaveTextContent('Билетов: 25, листов A4: 2')
    await waitFor(() => expect(window.print).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(callLog(mock)).toContain('POST /projects/p1/participants/printed'))
    const call = mock.mock.calls.find(([url]) => String(url).endsWith('/printed'))
    expect(JSON.parse(bodyOf(call))).toEqual({ ids: people.map((p) => p.id) })
  })

  it('skips ids that no longer exist and reports render failures', async () => {
    setPrintJob({ projectId: 'p1', ids: ['id1', 'gone'] })
    rendered.batch.mockRejectedValueOnce(new Error('canvas'))
    mount()
    await act(async () => undefined)
    expect(await screen.findByText('Что-то пошло не так')).toBeInTheDocument()
    expect(rendered.batch.mock.calls[0]?.[1]).toHaveLength(1)
    expect(window.print).not.toHaveBeenCalled()
  })
})
