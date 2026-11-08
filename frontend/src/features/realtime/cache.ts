import type { Participant } from '../workspace/api'

interface ListShape {
  items: Participant[]
  rev?: number
}

/**
 * Applies pushed rows to a cached list: a row replaces the cached one only when its version is greater
 * (stale pushes and echoes of our own optimistic edits are dropped); unknown rows are inserted in
 * number order. Returns the same object when nothing changed so React Query skips a re-render.
 */
export function applyUpsert<T extends ListShape>(
  list: T | undefined,
  incoming: readonly Participant[],
): { list: T | undefined; inserted: string[] } {
  if (!list) return { list, inserted: [] }
  const byId = new Map(list.items.map((r, i) => [r.id, i]))
  let items = list.items
  let changed = false
  const added: Participant[] = []
  for (const row of incoming) {
    const at = byId.get(row.id)
    if (at === undefined) {
      added.push(row)
    } else if (row.version > (items[at] as Participant).version) {
      if (!changed) items = items.slice()
      changed = true
      items[at] = row
    }
  }
  if (added.length > 0) {
    // One merge for the whole batch keeps a 5000-row import linear.
    items = [...items, ...added].sort((a, b) => a.number - b.number)
    changed = true
  }
  return { list: changed ? { ...list, items } : list, inserted: added.map((r) => r.id) }
}

export function applyDelete<T extends ListShape>(list: T | undefined, ids: readonly string[]): T | undefined {
  if (!list || ids.length === 0) return list
  const gone = new Set(ids)
  if (!list.items.some((r) => gone.has(r.id))) return list
  return { ...list, items: list.items.filter((r) => !gone.has(r.id)) }
}
