import type { Locator } from '@playwright/test'
import { type Api, adminCreds, uniq } from '../support/api'
import { tr } from '../support/pages'
import { expect, test } from '../support/test'
import { WorkspacePage } from '../support/workspace'

// UX audit round 2, stream V1 (workspace and realtime): N6, N7, N8, N9, m14, toast placement, large print.
// Desktop and tablet flows; phone flows live in workspace-phone.spec.ts.

const people = [
  { name: 'Alisher Karimov', phone: '+998901112233' },
  { name: 'Bobur Rahimov', phone: '+998902223344' },
  { name: 'Dilnoza Yusupova', phone: '+998903334455' },
]

async function seeded(admin: Api, rows = people) {
  const project = await admin.createProject(uniq('R3 '))
  await admin.uploadImage(project.id)
  const created = await admin.addParticipants(project.id, rows)
  return { project, created }
}

const box = async (l: Locator) => {
  const b = await l.boundingBox()
  if (!b) throw new Error('element is not visible')
  return b
}

test.beforeEach(({ viewport }) => {
  test.skip(!viewport || viewport.width < 700, 'table flows: phones are covered in workspace-phone.spec.ts')
})

test('N7: the search field keeps its width and the placeholder is not cut', async ({ admin, signedIn }) => {
  const { project } = await seeded(admin)
  const page = await signedIn(adminCreds())
  await page.setViewportSize({ width: 1180, height: 820 })
  const ws = new WorkspacePage(page)
  await ws.open(project.id)
  expect((await box(ws.search)).width).toBeGreaterThanOrEqual(180)
  expect(await ws.search.evaluate((el: HTMLInputElement) => el.scrollWidth <= el.clientWidth)).toBe(true)
  // Selecting a row brings the delete button without squeezing the field below a usable width.
  await ws.cell(ws.rows.first(), 'name').click()
  await ws.cell(ws.rows.nth(1), 'name').click({ modifiers: ['Shift'] })
  await expect(ws.button('workspace.deleteSelected', { count: 2 })).toBeVisible()
  expect((await box(ws.search)).width).toBeGreaterThanOrEqual(150)
  await page.setViewportSize({ width: 1440, height: 900 })
  await ws.cell(ws.rows.first(), 'name').click()
  expect(await ws.search.evaluate((el: HTMLInputElement) => el.scrollWidth <= el.clientWidth)).toBe(true)
})

test('N8: the failure toast goes away when Retry succeeds', async ({ admin, signedIn }) => {
  const { project } = await seeded(admin)
  const page = await signedIn(adminCreds())
  const ws = new WorkspacePage(page)
  await ws.open(project.id)
  let fail = true
  await page.route('**/api/v1/participants/*', (route) => {
    if (fail && route.request().method() === 'PATCH') return route.fulfill({ status: 500, body: '{}' })
    return route.continue()
  })
  await ws.editCell(ws.rowByText('Bobur'), 'name', 'Bobur Retried')
  const toast = page.getByText(/Строка № 2 не сохранена/)
  await expect(toast).toBeVisible()
  fail = false
  await page.getByRole('button', { name: ws.t('workspace.row.retryLabel', { number: 2 }) }).click()
  await expect(toast).toBeHidden({ timeout: 2000 })
  await expect
    .poll(async () => (await admin.participants(project.id)).some((p) => p.name === 'Bobur Retried'))
    .toBe(true)
})

test('N9: pasting from a filled row says which row was filled and follows it', async ({
  admin,
  signedIn,
}) => {
  const { project } = await seeded(admin, [...people, { name: '', phone: '' }])
  const page = await signedIn(adminCreds())
  const ws = new WorkspacePage(page)
  await ws.open(project.id)
  await ws.cell(ws.rows.first(), 'name').click()
  await ws.paste('Pasted One\t+998905550001\nPasted Two\t+998905550002')
  await expect(page.getByText(ws.t('workspace.toast.pasted', { count: 2, number: 4 }))).toBeVisible()
  const filled = ws.rowByText('Pasted One')
  await expect(filled).toHaveAttribute('data-current', 'true')
  await expect(filled).toHaveAttribute('data-selected', 'true')
  await expect(ws.rows.first()).not.toHaveAttribute('data-selected', 'true')
  await page.getByRole('button', { name: ws.t('workspace.toast.show') }).click()
  await expect(filled).toHaveAttribute('data-current', 'true')
})

test('m14: a failing participant list shows an error with Retry within 3 s', async ({ admin, signedIn }) => {
  const { project } = await seeded(admin)
  const page = await signedIn(adminCreds())
  let fail = true
  await page.route('**/api/v1/projects/*/participants', (route) => {
    if (fail && route.request().method() === 'GET') return route.fulfill({ status: 500, body: '{}' })
    return route.continue()
  })
  const started = Date.now()
  await page.goto(`/projects/${project.id}`)
  const retry = page.getByRole('button', { name: tr('ru')('action.retry') })
  await expect(retry.first()).toBeVisible({ timeout: 3000 })
  expect(Date.now() - started).toBeLessThan(4500)
  fail = false
  await retry.first().click()
  await expect(page.locator('.pt-grid, .pc-scroll')).toBeVisible()
})

test('toasts stay clear of the table footer', async ({ admin, signedIn }) => {
  const { project } = await seeded(admin)
  const page = await signedIn(adminCreds())
  const ws = new WorkspacePage(page)
  await ws.open(project.id)
  await ws.button('workspace.addRows').click()
  await page
    .getByRole('dialog')
    .getByRole('button', { name: ws.t('workspace.add.submit') })
    .click()
  const toast = page.locator('.toast').first()
  await expect(toast).toBeVisible()
  const foot = await box(page.locator('.pt-foot'))
  const t = await box(toast)
  expect(t.y + t.height).toBeLessThanOrEqual(foot.y + 1)
})

test('N6: going offline shows the banner at once, without moving the page', async ({ admin, signedIn }) => {
  const { project } = await seeded(admin)
  const page = await signedIn(adminCreds())
  const ws = new WorkspacePage(page)
  await ws.open(project.id)
  // Wait until the live connection is up before pulling the plug.
  await page.waitForTimeout(500)
  const rowBefore = await box(ws.rows.first())
  const toolbarBefore = await box(page.getByRole('toolbar', { name: ws.t('workspace.toolbar') }))
  await page.context().setOffline(true)
  const banner = page.getByText(ws.t('workspace.offline.banner'))
  await expect(banner).toBeVisible({ timeout: 3000 })
  expect(await box(ws.rows.first())).toEqual(rowBefore)
  expect(await box(page.getByRole('toolbar', { name: ws.t('workspace.toolbar') }))).toEqual(toolbarBefore)
  await page.context().setOffline(false)
  await expect(banner).toBeHidden({ timeout: 15_000 })
})

test('large print: more than 500 tickets ask for confirmation with a time estimate', async ({
  admin,
  signedIn,
}) => {
  test.setTimeout(120_000)
  const project = await admin.createProject(uniq('Big '))
  await admin.uploadImage(project.id)
  await admin.addParticipants(
    project.id,
    Array.from({ length: 501 }, (_, i) => ({ name: `Guest ${i + 1}`, phone: `+9989000${10000 + i}` })),
  )
  const page = await signedIn(adminCreds())
  const ws = new WorkspacePage(page)
  await ws.open(project.id)
  await ws.selectAllAndPrint()
  const dialog = page.getByRole('dialog', { name: ws.t('workspace.printBig.title') })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('501')
  await expect(dialog).toContainText(/\d+\s*(мин|с)/)
  await dialog.getByRole('button', { name: ws.t('workspace.printBig.cancel') }).click()
  await expect(page).not.toHaveURL(/\/print$/)
})
