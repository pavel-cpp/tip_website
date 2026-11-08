import type { Page } from '@playwright/test'
import { type Api, adminCreds, type Creds } from './api'
import { LoginPage, settle } from './pages'
import { seedPrefs } from './test'
import { WorkspacePage } from './workspace'

export type Theme = 'dark' | 'light'
export type Locale = 'ru' | 'uz'

export interface Screen {
  id: string
  /** Opens the screen and returns once it is fully rendered. */
  open: (page: Page, env: Env) => Promise<void>
  /** Regions masked in screenshots because their numbers change from run to run. */
  volatile?: string[]
  /** Needs the administrator account. */
  admin?: boolean
}

export interface Env {
  api: Api
  projectId: string
  locale: Locale
}

export const SNAPSHOT_PEOPLE = [
  { name: 'Alisher Karimov', phone: '+998 90 111-22-33' },
  { name: 'Dilnoza Yusupova', phone: '+998 91 222-33-44' },
  { name: 'Sharafutdin Azimov', phone: '+998 93 333-44-55' },
]

/** Creates the fixed project every visual and accessibility run looks at. */
export async function snapshotProject(api: Api): Promise<string> {
  const project = await api.createProject('Snapshot ticket')
  await api.uploadImage(project.id)
  await api.addParticipants(project.id, SNAPSHOT_PEOPLE)
  return project.id
}

const go = (path: string | ((e: Env) => string), ready: string) => async (page: Page, env: Env) => {
  await page.goto(typeof path === 'function' ? path(env) : path)
  await page.locator(ready).first().waitFor()
  await settle(page)
}

export const SCREENS: Screen[] = [
  { id: 'projects', open: go('/', '.projects-head') },
  {
    id: 'settings',
    open: async (page, env) => {
      await go((e) => `/projects/${e.projectId}/settings`, '.settings-grid')(page, env)
      await page.locator('.ph-chip').first().waitFor()
    },
  },
  {
    id: 'workspace',
    open: async (page, env) => {
      await page.goto(`/projects/${env.projectId}`)
      const ws = new WorkspacePage(page, env.locale)
      await ws.showTable()
      await ws.rows.first().waitFor()
      await settle(page)
    },
  },
  { id: 'profile', open: go('/profile', '.profile') },
  {
    id: 'admin-users',
    open: go('/admin/users', '.admin-page'),
    admin: true,
  },
  {
    id: 'admin-roles',
    open: go('/admin/roles', '.admin-page'),
    admin: true,
  },
  { id: 'admin-system', open: go('/admin/system', '.admin-page'), volatile: ['.admin-page'], admin: true },
]

/** Signs in with the given account after seeding the device preferences. */
export async function enter(page: Page, creds: Creds, locale: Locale, theme: Theme): Promise<void> {
  await seedPrefs(page.context(), locale, theme)
  await new LoginPage(page).signIn(creds)
}

export { adminCreds }
