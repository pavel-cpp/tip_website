import { unzipSync } from 'fflate'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TicketPlaceholders } from '../../lib/ticket'
import type { Participant } from './api'
import {
  copyTicket,
  PRINT_MAX_WIDTH,
  renderPrintBatch,
  saveTickets,
  type TicketSource,
} from './ticketActions'

const rendered = vi.hoisted(() => ({ blob: vi.fn() }))
vi.mock('../../lib/ticket', async (orig) => ({
  ...(await orig<typeof import('../../lib/ticket')>()),
  renderTicketBlob: rendered.blob,
  loadFonts: vi.fn(async () => undefined),
}))

const ph = {
  font: 'Inter',
  size: 10,
  stroke: 0,
  color: '#fff',
  strokeColor: '#000',
  bold: false,
  italic: false,
  underline: false,
  x: 1,
  y: 1,
}
const placeholders: TicketPlaceholders = { number: ph, name: ph, phone: ph }
const image = {
  width: 3000,
  height: 1714,
  naturalWidth: 3000,
  naturalHeight: 1714,
} as unknown as HTMLImageElement
const source: TicketSource = { image, placeholders }
const person = (n: number): Participant => ({
  id: `id${n}`,
  projectId: 'p',
  number: n,
  name: `Name ${n}`,
  phone: '+1',
  version: 1,
  updatedAt: '2026-11-07T10:00:00Z',
})

const png = (text: string) => new Blob([text], { type: 'image/png' })

beforeEach(() => {
  rendered.blob.mockImplementation(async () => png('PNGDATA'))
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  rendered.blob.mockReset()
})

describe('copyTicket', () => {
  class FakeClipboardItem {
    constructor(readonly items: Record<string, unknown>) {}
  }

  it('hands a Promise to ClipboardItem and writes before the render finishes (Safari user-gesture rule)', async () => {
    let finish: (b: Blob) => void = () => undefined
    rendered.blob.mockReturnValue(new Promise<Blob>((r) => (finish = r)))
    const write = vi.fn(async () => undefined)
    vi.stubGlobal('ClipboardItem', FakeClipboardItem)
    vi.stubGlobal('navigator', { clipboard: { write } })

    const pending = copyTicket(source, person(5))
    // The write was issued synchronously, while the PNG is still being drawn.
    expect(write).toHaveBeenCalledTimes(1)
    const [[[item]]] = write.mock.calls as unknown as [[[FakeClipboardItem]]]
    expect(item.items['image/png']).toBeInstanceOf(Promise)

    finish(png('x'))
    await expect(pending).resolves.toEqual({ ok: true })
  })

  it('returns the image for the "long-press to copy" dialog when the clipboard refuses', async () => {
    vi.stubGlobal('ClipboardItem', FakeClipboardItem)
    vi.stubGlobal('navigator', {
      clipboard: { write: vi.fn().mockRejectedValue(new DOMException('no', 'NotAllowedError')) },
    })
    const res = await copyTicket(source, person(5))
    expect(res.ok).toBe(false)
    if (!res.ok) await expect(res.blob).resolves.toBeInstanceOf(Blob)
  })

  it('falls back when ClipboardItem is not available at all', async () => {
    vi.stubGlobal('ClipboardItem', undefined)
    vi.stubGlobal('navigator', { clipboard: undefined })
    expect((await copyTicket(source, person(5))).ok).toBe(false)
  })

  it('renders the participant values onto the ticket', async () => {
    vi.stubGlobal('ClipboardItem', FakeClipboardItem)
    vi.stubGlobal('navigator', { clipboard: { write: vi.fn(async () => undefined) } })
    await copyTicket(source, person(7))
    expect(rendered.blob).toHaveBeenCalledWith(image, placeholders, {
      number: '7',
      name: 'Name 7',
      phone: '+1',
    })
  })
})

describe('saveTickets', () => {
  let downloads: Array<{ name: string; blob: Blob }>
  beforeEach(() => {
    downloads = []
    let last: Blob | null = null
    vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => {
      last = b as Blob
      return 'blob:x'
    })
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push({ name: this.download, blob: last as Blob })
    })
  })

  it('saves one row as image_<number>.png', async () => {
    await saveTickets(source, [person(12)], 'tickets.zip')
    expect(downloads.map((d) => d.name)).toEqual(['image_12.png'])
    expect(downloads[0]?.blob.type).toBe('image/png')
  })

  it('packs several rows into one ZIP with progress', async () => {
    const progress = vi.fn()
    await saveTickets(source, [person(1), person(2), person(3)], 'tickets.zip', progress)
    expect(downloads).toHaveLength(1)
    expect(downloads[0]?.name).toBe('tickets.zip')
    expect(progress.mock.calls).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ])
    const files = unzipSync(new Uint8Array(await (downloads[0] as { blob: Blob }).blob.arrayBuffer()))
    expect(Object.keys(files).sort()).toEqual(['image_1.png', 'image_2.png', 'image_3.png'])
    expect(new TextDecoder().decode(files['image_2.png'])).toBe('PNGDATA')
  })

  it('does nothing for an empty selection', async () => {
    await saveTickets(source, [], 'tickets.zip')
    expect(downloads).toHaveLength(0)
  })

  it('uses the share sheet on iOS when files can be shared', async () => {
    const share = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
      canShare: () => true,
      share,
    })
    await saveTickets(source, [person(1)], 'tickets.zip')
    expect(share).toHaveBeenCalledTimes(1)
    expect(downloads).toHaveLength(0)
  })

  it('falls back to a download when the iOS share sheet is dismissed', async () => {
    vi.stubGlobal('navigator', {
      userAgent: 'iPhone',
      canShare: () => true,
      share: vi.fn().mockRejectedValue(new DOMException('cancel', 'AbortError')),
    })
    await saveTickets(source, [person(1)], 'tickets.zip')
    expect(downloads).toHaveLength(1)
  })
})

describe('renderPrintBatch', () => {
  let widths: number[]
  let alive: number
  let maxAlive: number
  beforeEach(() => {
    widths = []
    alive = 0
    maxAlive = 0
    const ctx = {
      scale: vi.fn(),
      drawImage: vi.fn(),
      fillText: vi.fn(),
      strokeText: vi.fn(),
      fillRect: vi.fn(),
      measureText: () => ({ width: 10 }),
    }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
      this: HTMLCanvasElement,
    ) {
      alive++
      maxAlive = Math.max(maxAlive, alive)
      return ctx as unknown as CanvasRenderingContext2D
    })
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
      this: HTMLCanvasElement,
      cb: BlobCallback,
    ) {
      widths.push(this.width)
      alive--
      cb(new Blob(['j'], { type: 'image/jpeg' }))
    })
  })

  it('renders rows one by one at a capped print resolution and reports progress', async () => {
    const progress = vi.fn()
    const blobs = await renderPrintBatch(source, [person(1), person(2), person(3)], progress)
    expect(blobs).toHaveLength(3)
    expect(progress.mock.calls.map((c) => c[0])).toEqual([1, 2, 3])
    expect(widths.every((w) => w === PRINT_MAX_WIDTH)).toBe(true)
    // Only one canvas is alive at a time, so memory stays flat for big batches.
    expect(maxAlive).toBe(1)
  })

  it('stops early when cancelled', async () => {
    let calls = 0
    const blobs = await renderPrintBatch(
      source,
      [person(1), person(2), person(3)],
      () => undefined,
      () => calls++ >= 1,
    )
    expect(blobs).toHaveLength(1)
  })
})
