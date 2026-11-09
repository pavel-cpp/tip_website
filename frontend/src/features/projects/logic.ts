import type { ProjectCardData, ProjectStatus } from './api'

export interface ProjectSections {
  active: ProjectCardData[]
  finished: ProjectCardData[]
}

/** Case-insensitive title match; an empty query matches everything. */
export function matchesQuery(title: string, query: string): boolean {
  const q = query.trim().toLocaleLowerCase()
  return q === '' || title.toLocaleLowerCase().includes(q)
}

/**
 * Splits the list into sections. Finished projects are dropped entirely without project.view_finished
 * (the server filters too; this keeps the UI consistent while a cache is stale).
 */
export function splitProjects(
  list: readonly ProjectCardData[],
  query: string,
  canViewFinished: boolean,
): ProjectSections {
  const out: ProjectSections = { active: [], finished: [] }
  for (const p of list) {
    if (!matchesQuery(p.title, query)) continue
    if (p.status === 'active') out.active.push(p)
    else if (canViewFinished) out.finished.push(p)
  }
  return out
}

export type ProjectAction = 'settings' | 'moveUp' | 'moveDown' | 'finish' | 'reopen' | 'delete'

/** Where a card stands in its section; enables the keyboard move entries when set. */
export interface CardPosition {
  index: number
  count: number
}

/**
 * Card menu entries for a project, filtered by the user's permissions. Order matches the mockup.
 * Moving within the section needs project.update (the shared order) and a position; moving to the
 * other section is the finish / reopen entry (project.finish).
 */
export function projectActions(
  can: (perm: string) => boolean,
  status: ProjectStatus,
  position?: CardPosition,
): ProjectAction[] {
  const actions: ProjectAction[] = []
  if (can('project.update') && status === 'active') actions.push('settings')
  if (can('project.update') && position) {
    if (position.index > 0) actions.push('moveUp')
    if (position.index < position.count - 1) actions.push('moveDown')
  }
  if (can('project.finish')) actions.push(status === 'active' ? 'finish' : 'reopen')
  if (can('project.delete')) actions.push('delete')
  return actions
}

/** The destructive confirmation passes only when the typed text equals the project title. */
export function deleteConfirmed(typed: string, title: string): boolean {
  return typed.trim() === title.trim() && title.trim() !== ''
}

/** Deterministic hue 0..359 from an id (FNV-1a), so a project keeps its colour between visits. */
export function hueFor(id: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0) % 360
}

/** Dark, low-chroma gradient from the project id; same look as the muted cards in the mockup. */
export function gradientFor(id: string): string {
  const hue = hueFor(id)
  return `linear-gradient(160deg, hsl(${hue} 38% 24%) 0%, hsl(${(hue + 40) % 360} 30% 12%) 100%)`
}

export interface Rect {
  left: number
  top: number
}

/** FLIP: the inverse translation that makes an element appear at its previous position. */
export function flipDelta(prev: Rect, next: Rect): { dx: number; dy: number } | null {
  const dx = prev.left - next.left
  const dy = prev.top - next.top
  return Math.abs(dx) < 1 && Math.abs(dy) < 1 ? null : { dx, dy }
}
