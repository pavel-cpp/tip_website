import type { Locator, Page } from '@playwright/test'
import { type Api, adminCreds, uniq } from '../support/api'
import { expect, test } from '../support/test'
import { WorkspacePage } from '../support/workspace'

// Stream B: selection with a real mouse, clear with Undo, search by row number, bulk paste and the cell editor.
// Desktop flows; the phone equivalents (long press, bulk bar, sheet) live in workspace-phone.spec.ts.

const ROW_H = 44

async function seeded(admin: Api, count: number, filled = true) {
  const project = await admin.createProject(uniq('Ops '))
  await admin.uploadImage(project.id)
  const items = Array.from({ length: count }, (_, i) =>
    filled ? { name: `Person ${i + 1}`, phone: `+99890${String(1000000 + i)}` } : { name: '', phone: '' },
  )
  for (let i = 0; i < count; i += 5000) await admin.addParticipants(project.id, items.slice(i, i + 5000))
  return project
}

const box = async (l: Locator) => {
  const b = await l.boundingBox()
  if (!b) throw new Error('element is not visible')
  return b
}

/** Number of selected rows as the footer reports it (rows outside the viewport are not in the DOM). */
async function selectedCount(page: Page): Promise<number> {
  const text = (await page.locator('.pt-foot').textContent()) ?? ''
  // Numbers are grouped ("5 000"), so keep digits only.
  const part = text.split('·')[1]
  return part ? Number(part.replace(/\D/g, '')) : 0
}

async function scrollToRow(page: Page, n: number) {
  await page.locator('.pt-scroll').evaluate(
    (el, top) => {
      el.scrollTop = top
    },
    (n - 1) * ROW_H,
  )
}

/** Clicks the name cell of the row with this number (it must be rendered). */
const nameCell = (ws: WorkspacePage, n: number) =>
  ws.rows
    .filter({ has: ws.page.locator(`[data-col-name="number"] .pt-text:text-is("${n}")`) })
    .locator('[data-col-name="name"]')

test.beforeEach(({ viewport }) => {
  test.skip(!viewport || viewport.width < 700, 'table flows: phones are covered in workspace-phone.spec.ts')
})

test('mouse selection on 5000 rows: click, Shift, Ctrl, drag with auto-scroll, Ctrl+A', async ({
  admin,
  signedIn,
}) => {
  const project = await seeded(admin, 5000)
  const page = await signedIn(adminCreds())
  const ws = new WorkspacePage(page)
  await ws.open(project.id)
  await expect(ws.rows.first()).toBeVisible()

  await nameCell(ws, 3).click()
  expect(await selectedCount(page)).toBe(1)
  await nameCell(ws, 6).click({ modifiers: ['Shift'] })
  expect(await selectedCount(page)).toBe(4)
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
  await nameCell(ws, 9).click({ modifiers: [modifier] })
  expect(await selectedCount(page)).toBe(5)
  await nameCell(ws, 4).click({ modifiers: [modifier] })
  expect(await selectedCount(page)).toBe(4)
  await nameCell(ws, 1).click()
  expect(await selectedCount(page)).toBe(1)

  // Drag over the cells of one column selects the block between the press and the release.
  const from = await box(nameCell(ws, 2))
  const to = await box(nameCell(ws, 7))
  await page.mouse.move(from.x + 40, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(to.x + 40, to.y + to.height / 2, { steps: 8 })
  await page.mouse.up()
  expect(await selectedCount(page)).toBe(6)
  await expect(ws.rows.filter({ hasText: 'Person 4' })).toHaveAttribute('data-selected', 'true')

  // Holding the pointer near the bottom edge scrolls the list and keeps extending the selection.
  const scroller = await box(page.locator('.pt-scroll'))
  await nameCell(ws, 1).click()
  const start = await box(nameCell(ws, 1))
  await page.mouse.move(start.x + 40, start.y + start.height / 2)
  await page.mouse.down()
  await page.mouse.move(start.x + 40, scroller.y + scroller.height - 6, { steps: 6 })
  await expect
    .poll(() => page.locator('.pt-scroll').evaluate((el) => el.scrollTop), { timeout: 15_000 })
    .toBeGreaterThan(1500)
  await page.mouse.up()
  // The scroll speed depends on how fast the browser draws frames (WebKit is the slowest); a few dozen rows
  // past the first screen prove that the selection keeps growing while the list scrolls.
  expect(await selectedCount(page)).toBeGreaterThan(40)

  // Ctrl+A selects every row of the virtualized list, not only the rendered ones.
  await scrollToRow(page, 1)
  await nameCell(ws, 1).click()
  await page.keyboard.press(`${modifier}+a`)
  expect(await selectedCount(page)).toBe(5000)
})

test('search finds a row by its number on 5000 rows', async ({ admin, signedIn }) => {
  const project = await seeded(admin, 5000)
  const page = await signedIn(adminCreds())
  const ws = new WorkspacePage(page)
  await ws.open(project.id)
  await ws.search.fill('4321')
  // Row 4322 matches too: its phone contains 4321, a text match.
  await expect(
    ws.rows.filter({ has: page.locator('[data-col-name="number"] .pt-text:text-is("4321")') }),
  ).toHaveCount(1)
  await ws.search.fill('12')
  await expect(
    ws.rows.filter({ has: page.locator('[data-col-name="number"] .pt-text:text-is("12")') }),
  ).toHaveCount(1)
  // Still a text search too: "Person 99" is a name.
  await ws.search.fill('Person 99')
  await expect(ws.rows.first()).toContainText('Person 99')
})

test('Delete key and the toolbar clear rows, keep them, and Undo restores the text', async ({
  admin,
  signedIn,
}) => {
  const project = await seeded(admin, 8)
  const page = await signedIn(adminCreds())
  const ws = new WorkspacePage(page)
  await ws.open(project.id)

  await nameCell(ws, 2).click()
  await nameCell(ws, 4).click({ modifiers: ['Shift'] })
  await page.keyboard.press('Delete')
  await expect(page.getByText(ws.t('workspace.toast.cleared', { count: 3 }))).toBeVisible()
  await expect(ws.rows).toHaveCount(8)
  await expect(ws.rows.filter({ hasText: 'Person 3' })).toHaveCount(0)
  await expect
    .poll(async () => (await admin.participants(project.id)).filter((p) => p.name === '').length)
    .toBe(3)
  // The numbers survive, only the text goes.
  expect((await admin.participants(project.id)).map((p) => p.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])

  await page.getByRole('button', { name: ws.t('action.undo') }).click()
  await expect(ws.rows.filter({ hasText: 'Person 3' })).toHaveCount(1)
  await expect
    .poll(async () => (await admin.participants(project.id)).filter((p) => p.name === '').length)
    .toBe(0)

  // The toolbar button does the same and there is no delete anywhere.
  await nameCell(ws, 6).click()
  await expect(page.getByRole('button', { name: /Удалить/ })).toHaveCount(0)
  await ws.clearSelected(1)
  await expect(ws.rows.filter({ hasText: 'Person 6' })).toHaveCount(0)
  await expect(ws.rows).toHaveCount(8)
})

test('bulk paste: lines fill the selected cells, extra lines continue below, one value fills all, one Undo', async ({
  admin,
  signedIn,
}) => {
  const project = await seeded(admin, 6, false)
  const page = await signedIn(adminCreds())
  const ws = new WorkspacePage(page)
  await ws.open(project.id)
  const names = async () => (await admin.participants(project.id)).map((p) => p.name)

  // Three selected cells, two lines: only the first two cells are filled.
  await nameCell(ws, 2).click()
  await nameCell(ws, 4).click({ modifiers: ['Shift'] })
  await ws.paste('Anna\nBella')
  await expect.poll(names).toEqual(['', 'Anna', 'Bella', '', '', ''])

  // One value fills every selected cell.
  await ws.paste('Same')
  await expect.poll(names).toEqual(['', 'Same', 'Same', 'Same', '', ''])

  // More lines than selected cells continue below the selection and add rows only at the end of the table.
  await nameCell(ws, 5).click()
  await nameCell(ws, 6).click({ modifiers: ['Shift'] })
  await ws.paste('L1\nL2\nL3\nL4')
  await expect.poll(async () => (await names()).length).toBe(8)
  expect(await names()).toEqual(['', 'Same', 'Same', 'Same', 'L1', 'L2', 'L3', 'L4'])
  await expect(page.getByText(ws.t('workspace.toast.pasted', { count: 4, number: 5 }))).toBeVisible()
  await expect(page.getByRole('button', { name: ws.t('workspace.toast.show') }).last()).toBeVisible()

  // Two-column data fills name and phone; a single Undo reverts the whole paste (new rows are emptied, not deleted).
  await nameCell(ws, 1).click()
  await ws.paste('A1\t+1\nA2\t+2')
  await expect
    .poll(async () => (await admin.participants(project.id)).slice(0, 2).map((p) => p.phone))
    .toEqual(['+1', '+2'])
  await page
    .getByRole('button', { name: ws.t('action.undo') })
    .last()
    .click()
  await expect
    .poll(async () => (await admin.participants(project.id)).slice(0, 2).map((p) => p.phone))
    .toEqual(['', ''])
  expect((await names()).slice(0, 2)).toEqual(['', 'Same'])
  expect(await admin.participants(project.id)).toHaveLength(8)
})

test('bulk paste of 5000 lines is one batched request', async ({ admin, signedIn }) => {
  test.setTimeout(120_000)
  const project = await seeded(admin, 5000, false)
  const page = await signedIn(adminCreds())
  const ws = new WorkspacePage(page)
  await ws.open(project.id)
  const writes: string[] = []
  page.on('request', (r) => {
    if (r.method() !== 'GET') writes.push(`${r.method()} ${new URL(r.url()).pathname}`)
  })

  await nameCell(ws, 1).click()
  const text = Array.from({ length: 5000 }, (_, i) => `Pasted ${i + 1}\t+99890${String(2000000 + i)}`).join(
    '\n',
  )
  const started = Date.now()
  await ws.paste(text)
  await expect(page.getByText(/Вставлено\s+5\s000\s+строк, начиная с № 1/)).toBeVisible({ timeout: 30_000 })
  // The UI is optimistic: the first rows already show the text.
  await expect(ws.rows.first()).toContainText('Pasted 1')
  expect(Date.now() - started).toBeLessThan(30_000)
  expect(writes.filter((w) => w.includes('/participants/batch'))).toHaveLength(1)
  expect(writes.filter((w) => w.startsWith('PATCH'))).toHaveLength(0)
  expect(writes.filter((w) => w === `POST /api/v1/projects/${project.id}/participants`)).toHaveLength(0)

  const rows = await admin.participants(project.id)
  expect(rows).toHaveLength(5000)
  expect(rows[0]?.name).toBe('Pasted 1')
  expect(rows[4999]?.name).toBe('Pasted 5000')
  expect(rows[4999]?.phone).toBe('+998902004999')

  await page.getByRole('button', { name: ws.t('action.undo') }).click()
  await expect
    .poll(async () => (await admin.participants(project.id)).filter((p) => p.name !== '').length, {
      timeout: 30_000,
    })
    .toBe(0)
})

test('the cell editor fills the whole cell and nothing shifts while editing', async ({ admin, signedIn }) => {
  const project = await seeded(admin, 3)
  const long = 'A very long participant name that does not fit into the cell by any means, '.repeat(2)
  const page = await signedIn(adminCreds())
  const ws = new WorkspacePage(page)
  await ws.open(project.id)
  await admin.updateParticipant((await admin.participants(project.id))[0]?.id as string, 1, {
    name: long.slice(0, 150),
  })
  await page.reload()
  await ws.showTable()

  const row = ws.rows.first()
  const cell = ws.cell(row, 'name')
  const textBefore = await box(cell.locator('.pt-text'))
  const cellBox = await box(cell)
  const rowBox = await box(row)
  await cell.click()
  await page.keyboard.press('Enter')
  const input = cell.locator('input.pt-input')
  await expect(input).toBeFocused()

  const inputBox = await box(input)
  expect(Math.abs(inputBox.x - cellBox.x)).toBeLessThanOrEqual(1)
  expect(Math.abs(inputBox.y - cellBox.y)).toBeLessThanOrEqual(1)
  expect(Math.abs(inputBox.width - cellBox.width)).toBeLessThanOrEqual(1)
  expect(Math.abs(inputBox.height - cellBox.height)).toBeLessThanOrEqual(1)
  expect(Math.abs((await box(cell)).width - cellBox.width)).toBeLessThanOrEqual(1)
  expect(Math.abs((await box(row)).height - rowBox.height)).toBeLessThanOrEqual(1)

  // Same font, and the text starts where it started before editing.
  const fonts = await input.evaluate((el) => {
    const t = getComputedStyle(el.closest('[data-cell]')?.parentElement as Element)
    const i = getComputedStyle(el)
    return { same: t.fontFamily === i.fontFamily && t.fontSize === i.fontSize, pad: i.paddingLeft }
  })
  expect(fonts).toEqual({ same: true, pad: '12px' })
  expect(Math.abs(inputBox.x + 12 - textBefore.x)).toBeLessThanOrEqual(1)

  // Typing long text keeps the box; leaving edit mode restores the same geometry.
  await input.press('End')
  await page.keyboard.type(' and then some more text that makes it even longer, ok')
  expect(Math.abs((await box(input)).width - cellBox.width)).toBeLessThanOrEqual(1)
  await page.keyboard.press('Escape')
  await expect(input).toHaveCount(0)
  const after = await box(cell)
  expect(Math.abs(after.width - cellBox.width)).toBeLessThanOrEqual(1)
  expect(Math.abs((await box(cell.locator('.pt-text'))).x - textBefore.x)).toBeLessThanOrEqual(1)
})

test('the phone is free text: no warning in the table', async ({ admin, signedIn }) => {
  const project = await seeded(admin, 2)
  const page = await signedIn(adminCreds())
  const ws = new WorkspacePage(page)
  await ws.open(project.id)
  await ws.editCell(ws.rows.first(), 'phone', 'call me maybe')
  await expect(ws.rows.first()).toContainText('call me maybe')
  await expect(page.locator('.pt-warn, [data-suspicious]')).toHaveCount(0)
  await expect.poll(async () => (await admin.participants(project.id))[0]?.phone).toBe('call me maybe')
})
