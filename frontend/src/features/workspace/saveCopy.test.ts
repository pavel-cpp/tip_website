import { describe, expect, it, vi } from 'vitest'
import { buildHtml, buildTextList, COPY_CAP, capRows } from './clipboardPayload'
import {
  type BatchItem,
  chunkFiles,
  type DirLike,
  downloadEach,
  FOLDER_CONCURRENCY,
  loadSaveMode,
  planSave,
  storeSaveMode,
  uniqueName,
  writeToFolder,
} from './folderSave'

describe('clipboard payload', () => {
  it('lists "number name" lines in order', () => {
    expect(
      buildTextList([
        { number: 3, name: 'Aziza' },
        { number: 12, name: '' },
      ]),
    ).toBe('3 Aziza\n12')
  })

  it('puts every image into one HTML document in order and escapes the alt text', () => {
    const html = buildHtml([
      { number: 1, name: 'A<b>', dataUri: 'data:image/png;base64,AAA' },
      { number: 2, name: 'B', dataUri: 'data:image/png;base64,BBB' },
    ])
    expect(html.indexOf('AAA')).toBeLessThan(html.indexOf('BBB'))
    expect(html.match(/<img /g)).toHaveLength(2)
    expect(html).toContain('alt="1 A&lt;b&gt;"')
  })

  it('caps big selections and reports what was left out', () => {
    const rows = Array.from({ length: COPY_CAP + 7 }, (_, i) => i)
    const { rows: kept, skipped } = capRows(rows)
    expect(kept).toHaveLength(COPY_CAP)
    expect(skipped).toBe(7)
    expect(capRows([1, 2]).skipped).toBe(0)
  })
})

describe('save planning', () => {
  it('saves one ticket as a plain file whatever the mode', () => {
    expect(planSave(1, 'folder', { folder: true, ios: false })).toEqual({ kind: 'single' })
  })
  it('uses a ZIP when that is the remembered choice', () => {
    expect(planSave(5, 'zip', { folder: true, ios: false })).toEqual({ kind: 'zip', note: false })
  })
  it('writes into a folder when the browser can', () => {
    expect(planSave(5, 'folder', { folder: true, ios: false })).toEqual({ kind: 'folder' })
  })
  it('falls back to a ZIP on iOS and to serial downloads elsewhere, both with a note', () => {
    expect(planSave(5, 'folder', { folder: false, ios: true })).toEqual({ kind: 'zip', note: true })
    expect(planSave(5, 'folder', { folder: false, ios: false })).toEqual({ kind: 'downloads', note: true })
  })
  it('gives phones image files through the share sheet, never a ZIP, whatever the saved mode', () => {
    expect(planSave(5, 'zip', { folder: false, ios: true, phone: true })).toEqual({ kind: 'share' })
    expect(planSave(5, 'folder', { folder: true, ios: false, phone: true })).toEqual({ kind: 'share' })
    expect(planSave(1, 'zip', { folder: false, ios: true, phone: true })).toEqual({ kind: 'single' })
  })
  it('splits files into share chunks that keep their order', () => {
    const files = Array.from({ length: 45 }, (_, i) => i)
    const chunks = chunkFiles(files)
    expect(chunks.map((c) => c.length)).toEqual([20, 20, 5])
    expect(chunks.flat()).toEqual(files)
    expect(chunkFiles([])).toEqual([])
  })
  it('remembers the choice', () => {
    storeSaveMode('folder')
    expect(loadSaveMode()).toBe('folder')
    storeSaveMode('zip')
    expect(loadSaveMode()).toBe('zip')
  })
})

describe('uniqueName', () => {
  it('numbers collisions case-insensitively', () => {
    const taken = new Set<string>()
    expect(uniqueName('a.png', taken)).toBe('a.png')
    expect(uniqueName('A.png', taken)).toBe('A (2).png')
    expect(uniqueName('a.png', taken)).toBe('a (3).png')
  })
})

const items = (n: number, fail = -1): BatchItem[] =>
  Array.from({ length: n }, (_, i) => ({
    name: i === 1 ? 'same.png' : i === 2 ? 'same.png' : `f${i}.png`,
    render: async () => {
      if (i === fail) throw new Error('render failed')
      return new Blob([`x${i}`])
    },
  }))

function fakeDir(existing: string[] = []) {
  const files = new Map<string, string>(existing.map((n) => [n, 'old']))
  const dir: DirLike = {
    async getFileHandle(name, opts) {
      if (!files.has(name) && !opts?.create) throw new DOMException('nf', 'NotFoundError')
      return {
        async createWritable() {
          return {
            async write(b: Blob) {
              files.set(name, await b.text())
            },
            async close() {},
          }
        },
      }
    },
  }
  return { dir, files }
}

describe('folder writing', () => {
  it('writes every file, renames collisions and reports progress', async () => {
    const { dir, files } = fakeDir()
    const progress = vi.fn()
    const res = await writeToFolder(dir, items(4), { onProgress: progress })
    expect(res).toEqual({ saved: 4, failed: [], cancelled: false })
    expect([...files.keys()].sort()).toEqual(['f0.png', 'f3.png', 'same (2).png', 'same.png'])
    expect(progress).toHaveBeenLastCalledWith(4, 4)
  })

  it('never overwrites a file that already sits in the folder', async () => {
    const { dir, files } = fakeDir(['f0.png'])
    await writeToFolder(dir, items(1))
    expect(files.get('f0.png')).toBe('old')
    expect(files.get('f0 (2).png')).toBe('x0')
  })

  it('keeps going after a failing file and lists it', async () => {
    const { dir } = fakeDir()
    const res = await writeToFolder(dir, items(4, 3))
    expect(res.saved).toBe(3)
    expect(res.failed.map((f) => f.name)).toEqual(['f3.png'])
  })

  it('stops when cancelled', async () => {
    const { dir, files } = fakeDir()
    const ctl = new AbortController()
    const res = await writeToFolder(dir, items(4), {
      concurrency: 1,
      signal: ctl.signal,
      onProgress: (done) => {
        if (done === 2) ctl.abort()
      },
    })
    expect(res.cancelled).toBe(true)
    expect(res.saved).toBe(2)
    expect(files.size).toBe(2)
  })

  it('renders several files at once but never more than the limit, with unique names', async () => {
    const { dir, files } = fakeDir()
    let active = 0
    let peak = 0
    const many: BatchItem[] = Array.from({ length: 12 }, (_, i) => ({
      name: 'same.png',
      render: async () => {
        peak = Math.max(peak, ++active)
        await new Promise((r) => setTimeout(r, 5))
        active--
        return new Blob([`x${i}`])
      },
    }))
    const res = await writeToFolder(dir, many)
    expect(res.saved).toBe(12)
    expect(peak).toBe(FOLDER_CONCURRENCY)
    expect(files.size).toBe(12)
  })
})

describe('serial downloads', () => {
  it('downloads each file under a unique name with a pause in between', async () => {
    const names: string[] = []
    const wait = vi.fn(async () => undefined)
    const res = await downloadEach(items(3), (_b, n) => names.push(n), { wait })
    expect(names).toEqual(['f0.png', 'same.png', 'same (2).png'])
    expect(res.saved).toBe(3)
    expect(wait).toHaveBeenCalledTimes(3)
  })
})
