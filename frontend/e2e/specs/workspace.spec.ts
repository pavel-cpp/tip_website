import { readFile } from 'node:fs/promises'
import { adminCreds, uniq } from '../support/api'
import { expect, test } from '../support/test'
import { WorkspacePage } from '../support/workspace'

const people = [
  { name: 'Alisher Karimov', phone: '+998901112233' },
  { name: 'Bobur Rahimov', phone: '+998902223344' },
  { name: 'Dilnoza Yusupova', phone: '+998903334455' },
]

async function seeded(admin: import('../support/api').Api, rows = people) {
  const project = await admin.createProject(uniq('WS '))
  await admin.uploadImage(project.id)
  const created = await admin.addParticipants(project.id, rows)
  return { project, created }
}

test('add rows, edit a cell and search', async ({ admin, signedIn }) => {
  const { project } = await seeded(admin)
  const page = await signedIn(adminCreds())
  const ws = new WorkspacePage(page)
  await ws.open(project.id)
  await expect(ws.rows).toHaveCount(3)

  await ws.addRows(2)
  await expect(ws.rows).toHaveCount(5)
  await expect(page.getByText(ws.t('workspace.toast.added', { count: 2 }))).toBeVisible()

  const target = ws.rowByText('Bobur')
  await ws.editCell(target, 'name', 'Bobur Edited')
  await expect(ws.rowByText('Bobur Edited')).toHaveCount(1)
  await expect
    .poll(async () => (await admin.participants(project.id)).some((p) => p.name === 'Bobur Edited'))
    .toBe(true)

  await ws.search.fill('Dilnoza')
  await expect(ws.rows).toHaveCount(1)
  await ws.search.fill('zzz-no-match')
  await expect(ws.rows).toHaveCount(0)
  await expect(page.getByText(ws.t('workspace.search.none'))).toBeVisible()
  await ws.search.fill('')
  await expect(ws.rows).toHaveCount(5)
})

test('paste spreadsheet rows', async ({ admin, signedIn, viewport }) => {
  test.skip((viewport?.width ?? 1024) < 700, 'pasting into the grid is a desktop flow; phones have cards')
  const { project } = await seeded(admin, people.slice(0, 1))
  const page = await signedIn(adminCreds())
  const ws = new WorkspacePage(page)
  await ws.open(project.id)
  await ws.paste('Pasted One\t+998905550001\nPasted Two\t+998905550002')
  await expect(ws.rowByText('Pasted One')).toHaveCount(1)
  await expect(ws.rowByText('Pasted Two')).toHaveCount(1)
  await expect
    .poll(
      async () => (await admin.participants(project.id)).filter((p) => p.name.startsWith('Pasted')).length,
    )
    .toBe(2)
})

test('delete with Undo restores the row, and a plain delete is committed', async ({ admin, signedIn }) => {
  const { project } = await seeded(admin)
  const page = await signedIn(adminCreds())
  const ws = new WorkspacePage(page)
  await ws.open(project.id)

  await ws.selectRow(ws.rowByText('Alisher'))
  await ws.deleteSelected(1)
  await expect(ws.rows).toHaveCount(2)
  await page.getByRole('button', { name: ws.t('action.undo') }).click()
  await expect(ws.rows).toHaveCount(3)
  expect(await admin.participants(project.id)).toHaveLength(3)

  await ws.selectRow(ws.rowByText('Alisher'))
  await ws.deleteSelected(1)
  await expect(ws.rows).toHaveCount(2)
  // The server delete is sent once the undo window (5 s) has passed.
  await expect.poll(async () => (await admin.participants(project.id)).length, { timeout: 15_000 }).toBe(2)
})

test('export XLSX downloads a spreadsheet', async ({ admin, signedIn }) => {
  const { project } = await seeded(admin)
  const page = await signedIn(adminCreds())
  const ws = new WorkspacePage(page)
  await ws.open(project.id)
  const download = page.waitForEvent('download')
  await ws.button('workspace.export').click()
  await page.getByRole('menuitem', { name: ws.t('workspace.export.xlsx') }).click()
  const file = await download
  expect(file.suggestedFilename()).toMatch(/\.xlsx$/)
  const path = await file.path()
  const bytes = await readFile(path)
  expect(bytes.subarray(0, 2).toString()).toBe('PK')
  expect(bytes.length).toBeGreaterThan(1000)
})

test('import: dry run previews the file, confirming adds the rows', async ({ admin, signedIn }) => {
  const { project } = await seeded(admin, people.slice(0, 1))
  const page = await signedIn(adminCreds())
  const ws = new WorkspacePage(page)
  await ws.open(project.id)
  await ws.button('workspace.import').click()
  const dialog = page.getByRole('dialog', { name: ws.t('workspace.import.title') })
  const csv = 'name,phone\nImported A,+998907770001\nImported B,+998907770002\n'
  await dialog
    .getByTestId('import-file')
    .setInputFiles({ name: 'people.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) })
  await expect(
    dialog.getByText(ws.t('workspace.import.summary', { total: 2, valid: 2, errors: 0 })),
  ).toBeVisible()
  // Nothing has been written yet.
  expect(await admin.participants(project.id)).toHaveLength(1)
  await dialog.getByRole('button', { name: ws.t('workspace.import.confirm', { count: 2 }) }).click()
  await expect(dialog).toBeHidden()
  await expect(ws.rowByText('Imported A')).toHaveCount(1)
  expect(await admin.participants(project.id)).toHaveLength(3)
})

test('copy and save actions follow the selection', async ({ admin, signedIn, browserName }) => {
  const { project } = await seeded(admin)
  const page = await signedIn(adminCreds())
  const ws = new WorkspacePage(page)
  await ws.open(project.id)
  const copy = ws.button('workspace.copy')
  const save = ws.button('workspace.save')
  const print = ws.button('workspace.print')
  await ws.showPicture()
  // The first row is the current one as soon as the table is loaded.
  await expect(save).toBeEnabled()
  await expect(copy).toBeEnabled()
  await expect(print).toBeEnabled()

  await save.click()
  // One ticket is saved as a PNG; the toast reports the count.
  await expect(page.getByText(ws.t('workspace.toast.saved', { count: 1 }))).toBeVisible({ timeout: 15_000 })
  void browserName
})

test('without rows the ticket actions are disabled', async ({ admin, signedIn }) => {
  const project = await admin.createProject(uniq('Empty '))
  await admin.uploadImage(project.id)
  const page = await signedIn(adminCreds())
  const ws = new WorkspacePage(page)
  await ws.open(project.id)
  await expect(page.getByText(ws.t('workspace.empty.title'))).toBeVisible()
  await expect(ws.button('workspace.print')).toBeDisabled()
  await expect(ws.button('workspace.copy')).toBeDisabled()
  await expect(ws.button('workspace.save')).toBeDisabled()
})
