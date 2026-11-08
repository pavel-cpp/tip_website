import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n } from '../../i18n'
import type { TicketPlaceholders } from '../../lib/ticket'
import type { Participant } from './api'
import { TicketPanel } from './TicketPanel'

const lib = vi.hoisted(() => ({ loadFonts: vi.fn(), renderTicket: vi.fn() }))
vi.mock('../../lib/ticket', async (orig) => ({
  ...(await orig<typeof import('../../lib/ticket')>()),
  loadFonts: lib.loadFonts,
  renderTicket: lib.renderTicket,
}))

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
const placeholders: TicketPlaceholders = { number: ph, name: ph, phone: ph }
const image = { width: 700, height: 400 } as unknown as HTMLImageElement
const person = (n: number): Participant => ({
  id: `id${n}`,
  projectId: 'p',
  number: n,
  name: `Name ${n}`,
  phone: '+1',
  version: 1,
  updatedAt: '2026-11-07T10:00:00Z',
})

beforeAll(() => initI18n())
beforeEach(() => {
  lib.loadFonts.mockReset().mockResolvedValue(undefined)
  lib.renderTicket.mockReset()
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0)
    return 0
  })
})

const front = () => document.querySelector('canvas[data-front]') as HTMLCanvasElement | null
const mount = (p: Participant | null, over: Partial<Parameters<typeof TicketPanel>[0]> = {}) => (
  <TicketPanel
    image={image}
    imageLoading={false}
    hasProjectImage
    placeholders={placeholders}
    participant={p}
    {...over}
  />
)

describe('ticket panel', () => {
  it('awaits fonts before drawing and shows the first ticket when it is ready', async () => {
    let fontsReady: () => void = () => undefined
    lib.loadFonts.mockReturnValue(new Promise<void>((r) => (fontsReady = r)))
    render(mount(person(1)))
    expect(lib.renderTicket).not.toHaveBeenCalled()
    await act(async () => fontsReady())
    expect(lib.renderTicket).toHaveBeenCalledTimes(1)
    expect(lib.renderTicket.mock.calls[0]?.[3]).toEqual({ number: '1', name: 'Name 1', phone: '+1' })
    expect(front()).not.toBeNull()
  })

  it('keeps the old canvas in front until the new ticket is drawn, then swaps (crossfade)', async () => {
    const { rerender } = render(mount(person(1)))
    await act(async () => undefined)
    const first = front()
    expect(first).not.toBeNull()

    let fontsReady: () => void = () => undefined
    lib.loadFonts.mockReturnValue(new Promise<void>((r) => (fontsReady = r)))
    rerender(mount(person(2)))
    // New ticket pending: the previous one is still the visible one.
    expect(front()).toBe(first)

    await act(async () => fontsReady())
    expect(front()).not.toBe(first)
    expect(lib.renderTicket).toHaveBeenCalledTimes(2)
    // It drew into the hidden canvas, not the visible one.
    expect(lib.renderTicket.mock.calls[1]?.[0]).toBe(front())
  })

  it('zooms with +/- and resets', async () => {
    render(mount(person(1)))
    await act(async () => undefined)
    const user = userEvent.setup()
    expect(screen.getByRole('button', { name: 'Сбросить масштаб' })).toHaveTextContent('100%')
    await user.click(screen.getByRole('button', { name: 'Увеличить' }))
    expect(screen.getByRole('button', { name: 'Сбросить масштаб' })).toHaveTextContent('150%')
    await user.click(screen.getByRole('button', { name: 'Уменьшить' }))
    await user.click(screen.getByRole('button', { name: 'Уменьшить' }))
    expect(screen.getByRole('button', { name: 'Сбросить масштаб' })).toHaveTextContent('75%')
    await user.click(screen.getByRole('button', { name: 'Сбросить масштаб' }))
    expect(screen.getByRole('button', { name: 'Сбросить масштаб' })).toHaveTextContent('100%')
  })

  it('shows empty states for no image and for no rows', async () => {
    const { rerender } = render(mount(null, { hasProjectImage: false, image: null, placeholders: null }))
    expect(screen.getByText('У проекта ещё нет картинки')).toBeInTheDocument()
    rerender(mount(null))
    expect(screen.getByText('Выберите участника, чтобы увидеть билет')).toBeInTheDocument()
    expect(lib.renderTicket).not.toHaveBeenCalled()
  })
})
