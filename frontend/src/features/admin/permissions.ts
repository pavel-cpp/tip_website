import type { PermissionCode } from './api'

/**
 * Direct dependencies between permissions. The API catalog does not carry them, so this mirrors
 * `requires` in backend/internal/domain/permission.go; the server re-normalises on save anyway,
 * which keeps a stale copy here harmless (the matrix would only differ until the role is saved).
 */
export const REQUIRES: Readonly<Partial<Record<PermissionCode, readonly PermissionCode[]>>> = {
  'project.view_finished': ['project.view'],
  'project.create': ['project.view'],
  'project.update': ['project.view'],
  'project.finish': ['project.view'],
  'project.delete': ['project.view'],
  'participant.view': ['project.view'],
  'participant.edit': ['participant.view'],
  'participant.print': ['participant.view'],
  'participant.export': ['participant.view'],
  'participant.import': ['participant.view'],
  'participant.delete': ['participant.view'],
  'participant.clear': ['participant.view'],
  'user.manage': ['user.view'],
  'role.manage': ['user.view'],
}

/** All permissions `code` needs, transitively, excluding itself. */
export function dependenciesOf(code: PermissionCode): PermissionCode[] {
  const out = new Set<PermissionCode>()
  const visit = (c: PermissionCode) => {
    for (const dep of REQUIRES[c] ?? []) {
      if (!out.has(dep)) {
        out.add(dep)
        visit(dep)
      }
    }
  }
  visit(code)
  return [...out]
}

/** All permissions that (transitively) need `code`. */
export function dependentsOf(code: PermissionCode): PermissionCode[] {
  return (Object.keys(REQUIRES) as PermissionCode[]).filter((c) => dependenciesOf(c).includes(code))
}

export interface ToggleResult {
  next: Set<PermissionCode>
  /** Dependencies switched on (or dependents switched off) as a side effect, for the highlight. */
  added: PermissionCode[]
  removed: PermissionCode[]
}

/** Turning a permission on pulls its dependencies in; turning one off also drops what depends on it. */
export function togglePermission(current: ReadonlySet<PermissionCode>, code: PermissionCode): ToggleResult {
  const next = new Set(current)
  const added: PermissionCode[] = []
  const removed: PermissionCode[] = []
  if (current.has(code)) {
    next.delete(code)
    for (const d of dependentsOf(code)) if (next.delete(d)) removed.push(d)
  } else {
    next.add(code)
    for (const d of dependenciesOf(code)) {
      if (!next.has(d)) {
        next.add(d)
        added.push(d)
      }
    }
  }
  return { next, added, removed }
}
