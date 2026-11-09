import { readStorage, writeStorage } from '../../lib/storage'

export type SaveMode = 'zip' | 'folder'
const MODE_KEY = 'tip.save.mode'

export const loadSaveMode = (): SaveMode => (readStorage(MODE_KEY) === 'folder' ? 'folder' : 'zip')
export const storeSaveMode = (m: SaveMode): void => writeStorage(MODE_KEY, m)

export type SavePlan =
  | { kind: 'single' }
  | { kind: 'zip'; note: boolean }
  | { kind: 'folder' }
  | { kind: 'downloads'; note: true }

/**
 * How `count` tickets are delivered. A folder needs the File System Access API (Chromium). Without it
 * iOS gets a ZIP (it blocks serial downloads) and other browsers get one download per file; both say so.
 */
export function planSave(count: number, mode: SaveMode, caps: { folder: boolean; ios: boolean }): SavePlan {
  if (count <= 1) return { kind: 'single' }
  if (mode === 'zip') return { kind: 'zip', note: false }
  if (caps.folder) return { kind: 'folder' }
  return caps.ios ? { kind: 'zip', note: true } : { kind: 'downloads', note: true }
}

export const folderSupported = (): boolean =>
  typeof window !== 'undefined' && typeof (window as WithPicker).showDirectoryPicker === 'function'

/** `a.png`, `a (2).png`, ... : the first name not in `taken`; the chosen name is added to the set. */
export function uniqueName(name: string, taken: Set<string>): string {
  let out = name
  if (taken.has(out.toLowerCase())) {
    const dot = name.lastIndexOf('.')
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
    let n = 2
    while (taken.has(`${stem} (${n})${ext}`.toLowerCase())) n++
    out = `${stem} (${n})${ext}`
  }
  taken.add(out.toLowerCase())
  return out
}

// Minimal shapes of the File System Access API (not in lib.dom for every TS version).
export interface WritableLike {
  write(data: Blob): Promise<void>
  close(): Promise<void>
}
export interface DirLike {
  getFileHandle(
    name: string,
    opts?: { create?: boolean },
  ): Promise<{ createWritable(): Promise<WritableLike> }>
}
type WithPicker = Window & { showDirectoryPicker?: (o?: { mode?: 'readwrite' }) => Promise<DirLike> }

/** Opens the folder picker; null when the user dismisses it. Must run inside the click handler. */
export async function pickFolder(): Promise<DirLike | null> {
  try {
    return (await (window as WithPicker).showDirectoryPicker?.({ mode: 'readwrite' })) ?? null
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return null
    throw e
  }
}

export interface BatchItem {
  /** Wanted file name, sanitized by the caller. */
  name: string
  render: () => Promise<Blob>
}

export interface BatchResult {
  saved: number
  failed: { name: string; error: unknown }[]
  cancelled: boolean
}

interface BatchOpts {
  onProgress?: (done: number, total: number) => void
  signal?: AbortSignal
  /** Lets the browser paint between files. */
  tick?: () => Promise<void>
}

async function exists(dir: DirLike, name: string): Promise<boolean> {
  try {
    await dir.getFileHandle(name)
    return true
  } catch {
    return false
  }
}

/** Writes the files one after another into the chosen folder; a failing file does not stop the rest. */
export async function writeToFolder(
  dir: DirLike,
  items: readonly BatchItem[],
  o: BatchOpts = {},
): Promise<BatchResult> {
  const taken = new Set<string>()
  const res: BatchResult = { saved: 0, failed: [], cancelled: false }
  for (const [i, item] of items.entries()) {
    if (o.signal?.aborted) {
      res.cancelled = true
      break
    }
    let name = uniqueName(item.name, taken)
    try {
      // Never overwrite a file that was already in the folder.
      while (await exists(dir, name)) {
        taken.add(name.toLowerCase())
        name = uniqueName(item.name, taken)
      }
      const blob = await item.render()
      const handle = await dir.getFileHandle(name, { create: true })
      const w = await handle.createWritable()
      await w.write(blob)
      await w.close()
      res.saved++
    } catch (error) {
      res.failed.push({ name, error })
    }
    o.onProgress?.(i + 1, items.length)
    await o.tick?.()
  }
  return res
}

/** One download per file for browsers without folder access; the gap keeps Chromium from blocking them. */
export async function downloadEach(
  items: readonly BatchItem[],
  download: (blob: Blob, name: string) => void,
  o: BatchOpts & { gapMs?: number; wait?: (ms: number) => Promise<void> } = {},
): Promise<BatchResult> {
  const taken = new Set<string>()
  const wait = o.wait ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)))
  const res: BatchResult = { saved: 0, failed: [], cancelled: false }
  for (const [i, item] of items.entries()) {
    if (o.signal?.aborted) {
      res.cancelled = true
      break
    }
    const name = uniqueName(item.name, taken)
    try {
      download(await item.render(), name)
      res.saved++
    } catch (error) {
      res.failed.push({ name, error })
    }
    o.onProgress?.(i + 1, items.length)
    await wait(o.gapMs ?? 350)
  }
  return res
}
