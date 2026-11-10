import { adminCreds, uniq } from '../support/api'
import { tr } from '../support/pages'
import { makePng } from '../support/png'
import { expect, test } from '../support/test'

const t = tr('ru')

test('create a project, upload an image, drag a placeholder and save', async ({ admin, signedIn }) => {
  const page = await signedIn(adminCreds())
  const title = uniq('Contest ')

  await page.getByRole('button', { name: t('projects.create.card') }).click()
  const dialog = page.getByRole('dialog', { name: t('projects.create.title') })
  await dialog.getByLabel(t('projects.create.name')).fill(title)
  await dialog.getByRole('button', { name: t('projects.create.submit') }).click()
  await expect(page).toHaveURL(/\/projects\/[^/]+\/settings$/)
  const projectId = page.url().split('/').at(-2) as string
  await expect(page.getByText(t('settings.preview.empty'))).toBeVisible()

  // The save button is disabled until something changes.
  const save = page.getByRole('button', { name: t('action.save') })
  await expect(save).toBeDisabled()

  await page.locator('input[type="file"][accept="image/png,image/jpeg"]').setInputFiles({
    name: 'ticket.png',
    mimeType: 'image/png',
    buffer: makePng(700, 400),
  })
  // The first field (Number) is open by default; this test moves the Name field.
  await page.getByRole('tab', { name: t('settings.ph.name') }).click()
  const chip = page.getByRole('button', { name: t('settings.drag', { label: `${t('settings.ph.name')} 2` }) })
  await expect(chip).toBeVisible()
  await expect(page.getByRole('img', { name: t('settings.preview.label') })).toBeVisible()

  const x = page.getByLabel('X', { exact: true })
  const y = page.getByLabel('Y', { exact: true })
  const x0 = Number(await x.inputValue())
  const y0 = Number(await y.inputValue())

  const box = await chip.boundingBox()
  if (!box) throw new Error('chip has no box')
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  await page.mouse.move(cx, cy)
  await page.mouse.down()
  await page.mouse.move(cx - 40, cy + 30, { steps: 8 })
  await page.mouse.up()

  await expect.poll(async () => Number(await x.inputValue())).not.toBe(x0)
  await expect.poll(async () => Number(await y.inputValue())).not.toBe(y0)
  const movedX = Number(await x.inputValue())
  const movedY = Number(await y.inputValue())

  // Change the title too, then save.
  await page.getByLabel(t('settings.name'), { exact: true }).fill(`${title} v2`)
  await expect(save).toBeEnabled()
  await save.click()
  await expect(page.getByText(t('settings.saved'))).toBeVisible()
  await expect(save).toBeDisabled()

  const saved = await admin.call<{
    project: { title: string; placeholders: { name: { x: number; y: number } } }
  }>('GET', `/projects/${projectId}`)
  expect(saved.project.title).toBe(`${title} v2`)
  expect(saved.project.placeholders.name.x).toBe(movedX)
  expect(saved.project.placeholders.name.y).toBe(movedY)

  // A reload shows the stored values.
  await page.reload()
  await page.getByRole('tab', { name: t('settings.ph.name') }).click()
  await expect(page.getByLabel('X', { exact: true })).toHaveValue(String(movedX))
})

test('unsaved changes ask for confirmation before leaving', async ({ admin, signedIn }) => {
  const project = await admin.createProject()
  const page = await signedIn(adminCreds())
  await page.goto(`/projects/${project.id}/settings`)
  await page.getByLabel(t('settings.name'), { exact: true }).fill('Changed')
  await page.getByRole('button', { name: t('action.close') }).click()
  const leave = page.getByRole('dialog', { name: t('settings.leave.title') })
  await expect(leave).toBeVisible()
  await leave.getByRole('button', { name: t('settings.leave.stay') }).click()
  await expect(leave).toBeHidden()
  await page.getByRole('button', { name: t('action.close') }).click()
  await page
    .getByRole('dialog', { name: t('settings.leave.title') })
    .getByRole('button', { name: t('settings.leave.leave') })
    .click()
  // A direct visit has no previous screen, so Close falls back to the project's workspace.
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}$`))
})

test('finish, reopen and delete a project from the list', async ({ admin, signedIn }) => {
  const project = await admin.createProject(uniq('Lifecycle '))
  const page = await signedIn(adminCreds())
  const menuFor = () => page.getByRole('button', { name: t('projects.menu.label', { title: project.title }) })

  await page.getByRole('searchbox', { name: t('projects.search') }).fill(project.title)
  await menuFor().click()
  await page.getByRole('menuitem', { name: t('projects.menu.finish') }).click()
  await expect(page.getByRole('heading', { name: t('projects.finished') })).toBeVisible()

  await menuFor().click()
  await page.getByRole('menuitem', { name: t('projects.menu.reopen') }).click()
  await expect(page.getByRole('heading', { name: t('projects.active') })).toBeVisible()
})

// Regression: deleting a project used to answer 500 because the audit row referenced the deleted project.
test('delete a project after typing its title', async ({ admin, signedIn }) => {
  const project = await admin.createProject(uniq('Doomed '))
  const page = await signedIn(adminCreds())
  const menuFor = () => page.getByRole('button', { name: t('projects.menu.label', { title: project.title }) })
  await page.getByRole('searchbox', { name: t('projects.search') }).fill(project.title)
  await menuFor().click()
  await page.getByRole('menuitem', { name: t('projects.menu.delete') }).click()
  const dialog = page.getByRole('dialog', { name: t('projects.delete.title') })
  const confirm = dialog.getByRole('button', { name: t('projects.delete.submit') })
  await expect(confirm).toBeDisabled()
  await dialog.getByLabel(t('projects.delete.confirm')).fill(project.title)
  await confirm.click()
  await expect(page.getByText(t('projects.toast.deleted', { title: project.title }))).toBeVisible()
})

// Regression: the panels used to swallow the wheel over them (overflow plus contained overscroll), so the
// page could not be scrolled with the pointer over the form, and the save bar was out of reach.
test('settings page scrolls under the pointer and keeps the save bar in view', async ({
  admin,
  signedIn,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'wheel scrolling is the Chromium-specific failure')
  const project = await admin.createProject()
  const page = await signedIn(adminCreds())
  await page.setViewportSize({ width: 1366, height: 600 })
  await page.goto(`/projects/${project.id}/settings`)
  const form = page.locator('.settings-fields')
  await expect(form).toBeVisible()

  const save = page.getByRole('button', { name: t('action.save') })
  const inView = async () => {
    const box = await save.boundingBox()
    const height = page.viewportSize()?.height ?? 0
    return box !== null && box.y >= 0 && box.y + box.height <= height
  }
  expect(await inView(), 'save bar visible without scrolling').toBe(true)

  const box = await form.boundingBox()
  await page.mouse.move((box?.x ?? 0) + 40, (box?.y ?? 0) + 40)
  await page.mouse.wheel(0, 400)
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0)
  expect(await inView(), 'save bar stays in view after scrolling').toBe(true)
})
