import type { ProjectCardData, ProjectStatus } from './api'
import type { ProjectSections } from './logic'

/** The ids of both sections in display order: active first, then finished (the server's global order). */
export function orderedIds(s: ProjectSections): string[] {
  return [...s.active, ...s.finished].map((p) => p.id)
}

/**
 * Moves a project to `index` of the target section (index counts the section without the moved
 * card). The status of the moved card follows the section. Returns null when nothing changes.
 */
export function moveProject(
  s: ProjectSections,
  id: string,
  to: ProjectStatus,
  index: number,
): ProjectSections | null {
  const moved = [...s.active, ...s.finished].find((p) => p.id === id)
  if (!moved) return null
  const without = (list: ProjectCardData[]) => list.filter((p) => p.id !== id)
  const next: ProjectSections = { active: without(s.active), finished: without(s.finished) }
  const target = to === 'active' ? next.active : next.finished
  const at = Math.max(0, Math.min(index, target.length))
  target.splice(at, 0, to === moved.status ? moved : { ...moved, status: to })
  const same =
    moved.status === to &&
    next.active.length === s.active.length &&
    next.active.every((p, i) => p.id === s.active[i]?.id) &&
    next.finished.every((p, i) => p.id === s.finished[i]?.id)
  return same ? null : next
}

export interface CardRect {
  left: number
  top: number
  width: number
  height: number
}

/**
 * Where a card dropped at `point` lands among the cards of a section (rects in display order,
 * without the dragged card): the nearest card decides, before it when the pointer is in its left
 * half and after it otherwise.
 */
export function insertionIndex(rects: readonly CardRect[], point: { x: number; y: number }): number {
  if (rects.length === 0) return 0
  let best = 0
  let bestDist = Number.POSITIVE_INFINITY
  rects.forEach((r, i) => {
    const dx = Math.max(r.left - point.x, 0, point.x - (r.left + r.width))
    const dy = Math.max(r.top - point.y, 0, point.y - (r.top + r.height))
    const d = dx * dx + dy * dy
    if (d < bestDist) {
      best = i
      bestDist = d
    }
  })
  const r = rects[best] as CardRect
  return point.x < r.left + r.width / 2 ? best : best + 1
}
