import type { Page } from '@playwright/test'
import { type Api, adminCreds, type Creds } from './api'
import { LoginPage, settle, tr } from './pages'
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

/**
 * Extra states the axe run covers on top of {@link SCREENS}: dialogs, menus, and on phones
 * the bottom sheet and the selection mode. Kept apart so the visual baselines are not affected.
 */
export const A11Y_STATES: Screen[] = [
  {
    id: 'projects-create-dialog',
    open: async (page, env) => {
      await go('/', '.projects-head')(page, env)
      await page
        .getByRole('button', { name: tr(env.locale)('projects.create.card') })
        .first()
        .click()
      await page.getByRole('dialog').waitFor()
      await settle(page)
    },
  },
  {
    id: 'user-menu',
    open: async (page, env) => {
      await go('/', '.projects-head')(page, env)
      await page.getByRole('button', { name: tr(env.locale)('nav.userMenu') }).click()
      await page.getByRole('menuitem').first().waitFor()
      await settle(page)
    },
  },
  {
    id: 'admin-user-dialog',
    admin: true,
    open: async (page, env) => {
      await go('/admin/users', '.admin-page')(page, env)
      await page.getByRole('button', { name: tr(env.locale)('admin.users.create') }).click()
      await page.getByRole('dialog').waitFor()
      await settle(page)
    },
  },
  {
    id: 'workspace-selected',
    open: async (page, env) => {
      await page.goto(`/projects/${env.projectId}`)
      const ws = new WorkspacePage(page, env.locale)
      await ws.showTable()
      await ws.rows.first().waitFor()
      if (await ws.isCards()) {
        await page.getByRole('button', { name: tr(env.locale)('workspace.select.enter') }).click()
        await ws.bulkBar.waitFor()
      } else {
        await ws.selectRow(ws.row(0))
      }
      await settle(page)
    },
  },
  {
    id: 'workspace-sheet',
    open: async (page, env) => {
      await page.goto(`/projects/${env.projectId}`)
      const ws = new WorkspacePage(page, env.locale)
      await ws.showTable()
      await ws.rows.first().waitFor()
      if (await ws.isCards()) {
        await ws.openCard(ws.rows.first(), false)
        await ws.sheet.waitFor()
      } else {
        await ws.cell(ws.row(0), 'name').click()
      }
      await settle(page)
    },
  },
]

/**
 * Collapses the lists that other tests fill in parallel (project cards, user rows, role cards) to a fixed
 * height and hides them. Done through the style property, because the server CSP blocks injected
 * style sheets.
 */
export async function hideVolatile(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const el of document.querySelectorAll<HTMLElement>(
      '.project-grid, .role-list, .table-wrap, .state-box',
    )) {
      el.style.setProperty('max-height', '120px', 'important')
      el.style.setProperty('overflow', 'hidden', 'important')
      el.style.setProperty('visibility', 'hidden', 'important')
    }
    for (const el of document.querySelectorAll<HTMLElement>('.project-section ~ .project-section')) {
      el.style.setProperty('display', 'none', 'important')
    }
  })
}
