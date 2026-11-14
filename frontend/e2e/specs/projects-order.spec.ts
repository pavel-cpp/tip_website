import type { Locator, Page } from '@playwright/test'
import { adminCreds, uniq } from '../support/api'
import { Topbar, tr } from '../support/pages'
import { settledBox } from '../support/settle'
import { expect, test } from '../support/test'

const t = tr('ru')

// Mouse drag works on the desktop profiles; phones use the long-press path, which Playwright cannot
// synthesise reliably, and the card menu (covered below) on every profile.
const desktopOnly = (viewport: { width: number } | null) => (viewport?.width ?? 0) >= 700

function card(page: Page, title: string): Locator {
  return page.locator('.project-card', { hasText: title })
}

async function titles(page: Page, prefix: string): Promise<string[]> {
  const all = await page.locator('.project-card-title').allTextContents()
  return all.filter((x) => x.startsWith(prefix))
}

/**
 * Other tests add projects to the same list at the same time, which pushes the cards this test drags around (or
 * below the fold). The page therefore only gets this test's own projects; saving the order still goes to the server.
 */
async function onlyMine(page: Page, prefix: string) {
  await page.route(/\/api\/v1\/projects(\?.*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    const res = await route.fetch()
    const all = (await res.json()) as Array<{ title: string }>
    return route.fulfill({ response: res, json: all.filter((p) => p.title.startsWith(prefix)) })
  })
  await page.reload()
}

async function drag(page: Page, from: Locator, to: Locator, where: 'left' | 'right' | 'center' = 'left') {
  // Other tests add projects to the same list, which pushes cards around; aim again until the pointer is on the card.
  let a = await settledBox(from)
  for (let attempt = 0; attempt < 8; attempt++) {
    a = await settledBox(from)
    await page.mouse.move(a.x + a.width / 2, a.y + 40)
    const onCard = await from.evaluate(
      (el, [x, y]) => el.contains(document.elementFromPoint(x as number, y as number)),
      [a.x + a.width / 2, a.y + 40],
    )
    if (onCard) break
  }
  await page.mouse.down()
  await page.mouse.move(a.x + a.width / 2 + 12, a.y + 52, { steps: 3 })
  // The target is measured once the drag has started, so a list that moved in the meantime is accounted for.
  const b = await settledBox(to)
  const x = where === 'left' ? b.x + 12 : where === 'right' ? b.x + b.width - 12 : b.x + b.width / 2
  await page.mouse.move(x, b.y + 60, { steps: 12 })
  // The drop target is worked out on animation frames; releasing before the page has shown it (a busy machine)
  // drops nowhere.
  await expect(page.locator('.drop-line, .project-section.is-drop-target').first()).toBeAttached()
  await page.mouse.up()
}

test('drag a card to a new place; the team order survives a reload', async ({
  admin,
  signedIn,
  viewport,
}) => {
  test.skip(!desktopOnly(viewport), 'mouse drag')
  const prefix = uniq('Ord')
  const a = await admin.createProject(`${prefix} A`)
  await admin.createProject(`${prefix} B`)
  const c = await admin.createProject(`${prefix} C`)
  const page = await signedIn(adminCreds())
  await onlyMine(page, prefix)
  await expect(card(page, `${prefix} A`)).toBeVisible()
  // Newest first: C, B, A.
  await expect.poll(() => titles(page, prefix)).toEqual([`${prefix} C`, `${prefix} B`, `${prefix} A`])
  await drag(page, card(page, `${prefix} A`), card(page, `${prefix} C`), 'left')
  await expect.poll(() => titles(page, prefix)).toEqual([`${prefix} A`, `${prefix} C`, `${prefix} B`])

  await page.reload()
  await expect(card(page, `${prefix} A`)).toBeVisible()
  await expect.poll(() => titles(page, prefix)).toEqual([`${prefix} A`, `${prefix} C`, `${prefix} B`])
  const api = await admin.call<{ id: string }[]>('GET', '/projects')
  const mine = api.map((p) => p.id).filter((id) => id === a.id || id === c.id)
  expect(mine).toEqual([a.id, c.id])
  await page.unrouteAll({ behavior: 'ignoreErrors' })
})

test('drag a card to the other section to finish it and back to reopen it', async ({
  admin,
  signedIn,
  viewport,
}) => {
  test.skip(!desktopOnly(viewport), 'mouse drag')
  const prefix = uniq('Mov')
  const p = await admin.createProject(`${prefix} P`)
  const done = await admin.createProject(`${prefix} Done`)
  await admin.finishProject(done.id)
  // Something stays in the active section to drop the card back onto once P has left it.
  await admin.createProject(`${prefix} Q`)
  const page = await signedIn(adminCreds())
  await onlyMine(page, prefix)
  const finishedSection = page.locator('[data-drop-section="finished"]')
  await expect(card(page, `${prefix} Done`)).toBeVisible()

  await drag(page, card(page, `${prefix} P`), card(page, `${prefix} Done`), 'right')
  await expect(finishedSection.locator('.project-card', { hasText: `${prefix} P` })).toBeVisible()
  await expect
    .poll(
      async () =>
        (await admin.call<{ id: string; status: string }[]>('GET', '/projects')).find((x) => x.id === p.id)
          ?.status,
    )
    .toBe('finished')

  const active = page.locator('[data-drop-section="active"]')
  await drag(page, card(page, `${prefix} P`), active.locator('.project-card').first(), 'left')
  await expect(active.locator('.project-card', { hasText: `${prefix} P` })).toBeVisible()
  await expect
    .poll(
      async () =>
        (await admin.call<{ id: string; status: string }[]>('GET', '/projects')).find((x) => x.id === p.id)
          ?.status,
    )
    .toBe('active')
  await page.unrouteAll({ behavior: 'ignoreErrors' })
})

test('the card menu moves a project up and down (keyboard path) on every device', async ({
  admin,
  signedIn,
}) => {
  const prefix = uniq('Key')
  await admin.createProject(`${prefix} A`)
  await admin.createProject(`${prefix} B`)
  const page = await signedIn(adminCreds())
  await onlyMine(page, prefix)
  await expect(card(page, `${prefix} A`)).toBeVisible()
  await expect.poll(() => titles(page, prefix)).toEqual([`${prefix} B`, `${prefix} A`])

  await page.getByRole('button', { name: t('projects.menu.label', { title: `${prefix} A` }) }).click()
  await page.getByRole('menuitem', { name: t('projects.menu.moveUp') }).click()
  await expect.poll(() => titles(page, prefix)).toEqual([`${prefix} A`, `${prefix} B`])
  await page.unrouteAll({ behavior: 'ignoreErrors' })
})

test('a worker sees no drag affordance and no move entries', async ({ admin, signedIn }) => {
  const prefix = uniq('Wrk')
  await admin.createProject(`${prefix} A`)
  const worker = await admin.createReadyUser({ roleIds: [await admin.roleId('worker')] })
  const page = await signedIn(worker)
  await expect(card(page, `${prefix} A`)).toBeVisible()
  await expect(page.locator('.project-card.is-draggable')).toHaveCount(0)
  await expect(page.locator('.project-card-menu')).toHaveCount(0)
})

test('a card shows who is online now, live, and not past contributors', async ({
  admin,
  signedIn,
  viewport,
}) => {
  test.skip(!desktopOnly(viewport), 'two workspaces side by side')
  test.setTimeout(90_000)
  const project = await admin.createProject(uniq('Live '))
  const viewer = await signedIn(adminCreds())
  await expect(card(viewer, project.title)).toBeVisible()
  await expect(card(viewer, project.title).getByRole('img', { name: /Сейчас в проекте/ })).toHaveCount(0)

  // A second user opens the project workspace: their room connection makes them "online" for the card.
  const other = await admin.createReadyUser({ displayName: 'Bobur Online' })
  const otherPage = await signedIn(other)
  await otherPage.goto(`/projects/${project.id}`)
  const online = card(viewer, project.title).getByRole('img', { name: /Сейчас в проекте: Bobur Online/ })
  await expect(online).toBeVisible({ timeout: 40_000 })
  await expect(online).toHaveAttribute('title', t('projects.card.online', { names: 'Bobur Online' }))

  // Leaving the project removes the avatar on the next refresh.
  await otherPage.goto('/projects')
  await expect(online).toHaveCount(0, { timeout: 40_000 })
})

test('the tab icon follows the app theme and falls back to the OS-adaptive file for system', async ({
  admin,
  signedIn,
}) => {
  const user = await admin.createReadyUser({ theme: 'dark' })
  const page = await signedIn(user, { theme: 'dark' })
  const href = () => page.locator('link[rel="icon"]').getAttribute('href')
  await expect.poll(href).toBe('/favicon-dark.svg')

  const bar = new Topbar(page)
  await bar.chooseTheme('light')
  await expect.poll(href).toBe('/favicon-light.svg')
  // The pre-paint script sets it again after a reload, before the app code runs.
  await page.reload()
  await expect.poll(href).toBe('/favicon-light.svg')

  await bar.chooseTheme('system')
  await expect.poll(href).toBe('/favicon.svg')
})

test('the create-project card steps aside while a card is dragged and comes back after the drop', async ({
  admin,
  signedIn,
  viewport,
}) => {
  test.skip(!desktopOnly(viewport), 'mouse drag')
  const prefix = uniq('Crt')
  await admin.createProject(`${prefix} A`)
  await admin.createProject(`${prefix} B`)
  const page = await signedIn(adminCreds())
  const create = page.locator('.project-create')
  await expect(create).toBeVisible()
  const a = await card(page, `${prefix} A`).boundingBox()
  const b = await card(page, `${prefix} B`).boundingBox()
  if (!a || !b) throw new Error('missing box')
  await page.mouse.move(a.x + a.width / 2, a.y + 40)
  await page.mouse.down()
  await page.mouse.move(a.x + a.width / 2 + 12, a.y + 52, { steps: 3 })
  await page.mouse.move(b.x + 12, b.y + 60, { steps: 8 })
  await expect(create).toHaveCount(0)
  await page.mouse.up()
  await expect(create).toBeVisible()
})
