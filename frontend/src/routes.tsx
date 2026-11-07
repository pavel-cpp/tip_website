import { lazy } from 'react'

// One lazy chunk per screen. The importers are also used to prefetch a chunk on link hover/focus.
const importers = {
  login: () => import('./pages/Login'),
  projects: () => import('./pages/Projects'),
  workspace: () => import('./pages/Workspace'),
  projectSettings: () => import('./pages/ProjectSettings'),
  profile: () => import('./pages/Profile'),
  adminUsers: () => import('./pages/admin/Users'),
  adminRoles: () => import('./pages/admin/Roles'),
  adminSystem: () => import('./pages/admin/System'),
  design: () => import('./pages/Design'),
  notFound: () => import('./pages/NotFound'),
}

export const pages = {
  Login: lazy(importers.login),
  Projects: lazy(importers.projects),
  Workspace: lazy(importers.workspace),
  ProjectSettings: lazy(importers.projectSettings),
  Profile: lazy(importers.profile),
  AdminUsers: lazy(importers.adminUsers),
  AdminRoles: lazy(importers.adminRoles),
  AdminSystem: lazy(importers.adminSystem),
  Design: lazy(importers.design),
  NotFound: lazy(importers.notFound),
}

const byPath: Record<string, () => Promise<unknown>> = {
  '/': importers.projects,
  '/login': importers.login,
  '/profile': importers.profile,
  '/admin/users': importers.adminUsers,
  '/admin/roles': importers.adminRoles,
  '/admin/system': importers.adminSystem,
  '/design': importers.design,
}

/** Starts loading the chunk for a static path; harmless to call repeatedly (the module is cached). */
export function prefetchRoute(path: string): void {
  void byPath[path]?.()
}
