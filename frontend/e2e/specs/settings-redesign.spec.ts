/// <reference types="node" />
import { readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { adminCreds, uniq } from '../support/api'
import { tr } from '../support/pages'
import { makePng } from '../support/png'
import { expect, test } from '../support/test'

const t = tr('ru')

// Real woff2 files shipped with the bundled families; they open as fonts in every browser.
const fontFile = (name: string) => readFileSync(`node_modules/@fontsource/${name}`)
const ROBOTO = fontFile('roboto/files/roboto-latin-700-normal.woff2')
const INTER = fontFile('inter/files/inter-latin-400-normal.woff2')

/** Fires the drag sequence of a real file drop (with a genuine DataTransfer) onto the element. */
async function dropFile(page: Page, selector: string, name: string, type: string, bytes: Buffer) {
  const dt = await page.evaluateHandle(
    ({ n, ty, b64 }) => {
      const data = new DataTransfer()
      const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      data.items.add(new File([raw], n, { type: ty }))
      return data
    },
    { n: name, ty: type, b64: bytes.toString('base64') },
  )
  for (const kind of ['dragenter', 'dragover', 'drop']) {
    await page.dispatchEvent(selector, kind, { dataTransfer: dt })
  }
}

async function openSettings(page: Page, projectId: string) {
  await page.goto(`/projects/${projectId}/settings`)
  await expect(page.getByLabel(t('settings.name'), { exact: true })).toBeVisible()
}

test('dropping a picture onto the empty preview uploads it and shows the drop state', async ({
  admin,
  signedIn,
}) => {
  const project = await admin.createProject(uniq('Drop '))
  const page = await signedIn(adminCreds())
  await openSettings(page, project.id)
  await expect(page.getByText(t('settings.preview.empty'))).toBeVisible()

  const dt = await page.evaluateHandle(() => {
    const data = new DataTransfer()
    data.items.add(new File(['x'], 'a.png', { type: 'image/png' }))
    return data
  })
  await page.dispatchEvent('.st-drop', 'dragenter', { dataTransfer: dt })
  await expect(page.getByText(t('settings.drop.release'))).toBeVisible()
  await page.dispatchEvent('.st-drop', 'dragleave', { dataTransfer: dt })
  await expect(page.getByText(t('settings.drop.release'))).toBeHidden()

  await dropFile(page, '.st-drop', 'dropped.png', 'image/png', makePng(700, 400))
  await expect(page.getByRole('img', { name: t('settings.preview.label') })).toBeVisible()
  await expect(page.getByText(/dropped\.png/)).toBeVisible()
  const stored = await admin.call<{ project: { image: { name: string; w: number } } }>(
    'GET',
    `/projects/${project.id}`,
  )
  expect(stored.project.image.name).toBe('dropped.png')
})

test('replace a picture with the button, and a wrong file is explained', async ({ admin, signedIn }) => {
  const project = await admin.uploadImage((await admin.createProject(uniq('Replace '))).id)
  const page = await signedIn(adminCreds())
  await openSettings(page, project.id)
  const input = page.locator('input[type="file"][accept="image/png,image/jpeg"]')

  await input.setInputFiles({ name: 'notes.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1') })
  await expect(page.getByRole('alert').filter({ hasText: t('settings.image.badType') })).toBeVisible()

  await input.setInputFiles({
    name: 'huge.png',
    mimeType: 'image/png',
    buffer: Buffer.alloc(11 * 1024 * 1024),
  })
  await expect(page.getByRole('alert').filter({ hasText: /10/ })).toBeVisible()

  await page.getByRole('button', { name: t('settings.image.replace') }).click()
  await input.setInputFiles({ name: 'second.png', mimeType: 'image/png', buffer: makePng(1400, 800) })
  await expect(page.getByText(/second\.png/)).toBeVisible()
  // A good file clears the earlier complaint.
  await expect(page.getByRole('alert').filter({ hasText: t('settings.image.badType') })).toBeHidden()
  const stored = await admin.call<{ project: { image: { name: string; w: number } } }>(
    'GET',
    `/projects/${project.id}`,
  )
  expect(stored.project.image).toMatchObject({ name: 'second.png', w: 1400 })
})

test('the aspect-ratio recommendation is gone', async ({ admin, signedIn }) => {
  const project = await admin.uploadImage((await admin.createProject(uniq('Ratio '))).id, 1024, 768)
  const page = await signedIn(adminCreds())
  await openSettings(page, project.id)
  await expect(page.getByText(/7:4/)).toHaveCount(0)
})

test('unsaved state, discard and save', async ({ admin, signedIn }) => {
  const project = await admin.uploadImage((await admin.createProject(uniq('Unsaved '))).id)
  const page = await signedIn(adminCreds())
  await openSettings(page, project.id)
  const save = page.getByRole('button', { name: t('action.save') })
  await expect(page.getByText(t('settings.status.saved'))).toBeVisible()
  await expect(save).toBeDisabled()

  const title = page.getByLabel(t('settings.name'), { exact: true })
  const before = await title.inputValue()
  await title.fill(`${before} edited`)
  await expect(page.getByText(t('settings.status.unsaved'))).toBeVisible()
  await expect(save).toBeEnabled()

  await page.getByRole('button', { name: t('settings.discard') }).click()
  await expect(title).toHaveValue(before)
  await expect(page.getByText(t('settings.status.saved'))).toBeVisible()

  await title.fill(`${before} v2`)
  await save.click()
  await expect(page.getByText(t('settings.status.saved'))).toBeVisible()
  const stored = await admin.call<{ project: { title: string } }>('GET', `/projects/${project.id}`)
  expect(stored.project.title).toBe(`${before} v2`)
})

test('arrow keys nudge the focused handle by one pixel, ten with Shift', async ({ admin, signedIn }) => {
  const project = await admin.uploadImage((await admin.createProject(uniq('Nudge '))).id)
  const page = await signedIn(adminCreds())
  await openSettings(page, project.id)
  const chip = page.getByRole('button', {
    name: t('settings.drag', { label: `${t('settings.ph.number')} 1` }),
  })
  const x = page.getByLabel('X', { exact: true })
  const x0 = Number(await x.inputValue())
  await chip.focus()
  await page.keyboard.press('ArrowRight')
  await expect(x).toHaveValue(String(x0 + 1))
  await page.keyboard.press('Shift+ArrowLeft')
  await expect(x).toHaveValue(String(x0 - 9))
})

test('the font picker searches, filters by category and previews each font in its own face', async ({
  admin,
  signedIn,
}) => {
  const project = await admin.uploadImage((await admin.createProject(uniq('Fonts '))).id)
  const page = await signedIn(adminCreds())
  await openSettings(page, project.id)

  await page.getByRole('button', { name: t('settings.font'), exact: true }).click()
  const search = page.getByRole('combobox', { name: t('fonts.search') })
  await expect(search).toBeFocused()
  const options = page.getByRole('option')
  expect(await options.count()).toBeGreaterThanOrEqual(30)

  await search.fill('slab')
  await expect(options).toHaveCount(1)
  await expect(options.first()).toHaveText('Roboto Slab')
  // Each entry carries its own family once it is shown.
  await expect(options.first().locator('.fp-name')).toHaveCSS('font-family', /Roboto Slab/)

  await search.fill('')
  await page.getByRole('button', { name: t('fonts.cat.mono') }).click()
  await expect(options.first()).toBeVisible()
  expect(await options.allTextContents()).toEqual(expect.arrayContaining(['JetBrains Mono']))
  await page.getByRole('button', { name: t('fonts.cat.all'), exact: true }).click()

  await search.fill('rale')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  const trigger = page.getByRole('button', { name: t('settings.font'), exact: true })
  await expect(trigger).toContainText('Raleway')
  await page.getByRole('button', { name: t('action.save') }).click()
  await expect(page.getByText(t('settings.status.saved'))).toBeVisible()
  const stored = await admin.call<{ project: { placeholders: { number: { font: string } } } }>(
    'GET',
    `/projects/${project.id}`,
  )
  expect(stored.project.placeholders.number.font).toBe('Raleway')
})

test('upload a custom font, use it, and it survives a reload and a delete attempt', async ({
  admin,
  signedIn,
}) => {
  const project = await admin.uploadImage((await admin.createProject(uniq('Custom '))).id)
  const page = await signedIn(adminCreds())
  await openSettings(page, project.id)

  await page.getByRole('button', { name: t('settings.font'), exact: true }).click()
  await page.getByRole('button', { name: t('fonts.upload') }).click()
  const dialog = page.getByRole('dialog', { name: t('fonts.upload.title') })

  // Submitting an empty form explains each problem.
  await dialog.getByRole('button', { name: t('fonts.upload.submit') }).click()
  await expect(dialog.getByText(t('fonts.upload.noFile'))).toBeVisible()
  await expect(dialog.getByText(t('fonts.upload.licenseRequired'))).toBeVisible()

  // A wrong type is refused before any upload.
  await dialog.locator('input[type="file"]').setInputFiles({
    name: 'logo.png',
    mimeType: 'image/png',
    buffer: makePng(8, 8),
  })
  await expect(dialog.getByText(t('fonts.upload.badType'))).toBeVisible()

  // A file with the right extension that is not a font is refused by the browser check.
  await dialog.locator('input[type="file"]').setInputFiles({
    name: 'fake.ttf',
    mimeType: 'font/ttf',
    buffer: Buffer.from('this is not a font at all'),
  })
  await expect(dialog.getByText(t('fonts.upload.unreadable'))).toBeVisible()

  await dialog
    .locator('input[type="file"]')
    .setInputFiles({ name: 'Brand_Sans.woff2', mimeType: 'font/woff2', buffer: INTER })
  await expect(dialog.getByLabel(t('fonts.upload.name'))).toHaveValue('Brand Sans')
  await dialog.getByLabel(t('fonts.upload.license')).check()
  await dialog.getByRole('button', { name: t('fonts.upload.submit') }).click()
  await expect(dialog).toBeHidden()

  // The new font is selected in the field and drawn in the trigger with its own face.
  const trigger = page.getByRole('button', { name: t('settings.font'), exact: true })
  await expect(trigger).toContainText('Brand Sans')
  await expect(trigger.locator('.fp-name')).toHaveCSS('font-family', /custom:/)
  await expect
    .poll(() =>
      page.evaluate(() =>
        [...document.fonts].some((f) => f.family.includes('custom:') && f.status === 'loaded'),
      ),
    )
    .toBe(true)

  await page.getByRole('button', { name: t('action.save') }).click()
  await expect(page.getByText(t('settings.status.saved'))).toBeVisible()
  const stored = await admin.call<{ project: { placeholders: { number: { font: string } } } }>(
    'GET',
    `/projects/${project.id}`,
  )
  expect(stored.project.placeholders.number.font).toMatch(/^custom:[0-9a-f-]{36}$/)

  // After a reload the font is fetched again (authorised) and registered before the canvas is drawn.
  await page.reload()
  await expect(page.getByRole('button', { name: t('settings.font'), exact: true })).toContainText(
    'Brand Sans',
  )
  await expect
    .poll(() =>
      page.evaluate(() =>
        [...document.fonts].some((f) => f.family.includes('custom:') && f.status === 'loaded'),
      ),
    )
    .toBe(true)

  // A font in use cannot be deleted.
  await page.getByRole('button', { name: t('settings.font'), exact: true }).click()
  await page.getByRole('button', { name: t('fonts.delete', { name: 'Brand Sans' }) }).click()
  await page
    .getByRole('dialog', { name: t('fonts.delete.title') })
    .getByRole('button', { name: t('fonts.delete.confirm') })
    .click()
  await expect(page.getByText(t('fonts.inUse'))).toBeVisible()
})

test('an unused custom font can be deleted', async ({ admin, signedIn }) => {
  const project = await admin.createProject(uniq('Delete font '))
  const page = await signedIn(adminCreds())
  await openSettings(page, project.id)
  await page.getByRole('button', { name: t('settings.font'), exact: true }).click()
  await page.getByRole('button', { name: t('fonts.upload') }).click()
  const dialog = page.getByRole('dialog', { name: t('fonts.upload.title') })
  await dialog
    .locator('input[type="file"]')
    .setInputFiles({ name: 'Throwaway.woff2', mimeType: 'font/woff2', buffer: ROBOTO })
  await dialog.getByLabel(t('fonts.upload.license')).check()
  await dialog.getByRole('button', { name: t('fonts.upload.submit') }).click()
  await expect(dialog).toBeHidden()

  // Switch away from it (the draft is unsaved, so the font is not used by any stored project).
  await page.getByRole('button', { name: t('settings.font'), exact: true }).click()
  await page.getByRole('combobox', { name: t('fonts.search') }).fill('Throwaway')
  await page.getByRole('button', { name: t('fonts.delete', { name: 'Throwaway' }) }).click()
  await page
    .getByRole('dialog', { name: t('fonts.delete.title') })
    .getByRole('button', { name: t('fonts.delete.confirm') })
    .click()
  await expect(page.getByText(t('fonts.deleted'))).toBeVisible()
})

test('dragging a handle snaps to the centre line and draws a guide; Alt turns snapping off', async ({
  admin,
  signedIn,
  isMobile,
}) => {
  test.skip(isMobile, 'pointer dragging with a mouse is covered on the desktop profile')
  const project = await admin.uploadImage((await admin.createProject(uniq('Snap '))).id, 1400, 800)
  const page = await signedIn(adminCreds())
  await openSettings(page, project.id)
  await page.getByRole('tab', { name: t('settings.ph.name') }).click()
  const chip = page.getByRole('button', { name: t('settings.drag', { label: `${t('settings.ph.name')} 2` }) })
  const chipBox = await chip.boundingBox()
  if (!chipBox) throw new Error('no chip box')
  const grabX = chipBox.x + chipBox.width / 2
  const grabY = chipBox.y + chipBox.height / 2
  const x = page.getByLabel('X', { exact: true })

  await page.mouse.move(grabX, grabY)
  await page.mouse.down()
  // The Name field starts on the vertical centre line; a 3 px nudge must snap back onto it with a guide.
  const dx = 3
  await page.mouse.move(grabX + dx, grabY + 20, { steps: 6 })
  await expect(page.locator('.ph-guide-v')).toBeVisible()
  await page.mouse.up()
  await expect(page.locator('.ph-guide-v')).toHaveCount(0)
  await expect(x).toHaveValue('700')

  // Holding Alt turns snapping off for pixel-precise placement.
  await page.mouse.move(grabX + dx, grabY + 20)
  await page.mouse.down()
  await page.keyboard.down('Alt')
  await page.mouse.move(grabX + dx + 40, grabY + 20, { steps: 4 })
  await page.keyboard.up('Alt')
  await page.mouse.up()
  expect(Number(await x.inputValue())).not.toBe(700)
})
