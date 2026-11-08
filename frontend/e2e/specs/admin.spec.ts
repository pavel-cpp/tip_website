import { adminCreds, uniq } from '../support/api'
import { Topbar, tr } from '../support/pages'
import { expect, test } from '../support/test'

const t = tr('ru')

test('admin creates a role with cascading permissions and assigns it to a user', async ({ admin, signedIn }) => {
  const page = await signedIn(adminCreds())
  const roleName = uniq('Printer ')
  const user = await admin.createUser({ displayName: uniq('Assignee ') })

  await page.goto('/admin/roles')
  await page.getByRole('button', { name: t('admin.roles.create') }).click()
  const editor = page.getByRole('dialog', { name: t('admin.roles.createTitle') })
  await editor.getByLabel(t('admin.roles.name'), { exact: true }).fill(roleName)

  const box = (code: string) => editor.locator(`input[data-code="${code}"]`)
  await expect(box('project.view')).not.toBeChecked()
  await box('participant.print').check()
  // Dependencies are switched on automatically: print -> view participants -> view projects.
  await expect(box('participant.print')).toBeChecked()
  await expect(box('participant.view')).toBeChecked()
  await expect(box('project.view')).toBeChecked()
  await expect(editor.getByText(t('admin.roles.autoAdded')).first()).toBeVisible()
  await editor.getByRole('button', { name: t('action.save') }).click()
  await expect(page.getByRole('heading', { level: 2, name: roleName })).toBeVisible()

  // Assign the role to the user through the users screen and confirm it in the table and the API.
  await page.goto('/admin/users')
  await page.getByRole('searchbox').fill(user.login)
  await page.getByRole('button', { name: `${t('action.more')}: ${user.displayName}` }).click()
  await page.getByRole('menuitem', { name: t('admin.users.assignRoles') }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel(roleName).check()
  await dialog.getByRole('button', { name: t('action.save') }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('row', { name: new RegExp(user.login) }).getByText(roleName)).toBeVisible()
  const roles = await admin.roles()
  const created = roles.find((r) => r.name === roleName)
  expect(created?.permissions).toEqual(expect.arrayContaining(['participant.print', 'participant.view', 'project.view']))
})

test('a worker sees no admin entries and is refused on admin routes', async ({ admin, signedIn }) => {
  const worker = await admin.createReadyUser()
  const page = await signedIn(worker)
  const items = await new Topbar(page).menuItems()
  expect(items.some((i) => i.includes(t('nav.adminUsers')))).toBe(false)
  expect(items.some((i) => i.includes(t('nav.adminRoles')))).toBe(false)
  expect(items.some((i) => i.includes(t('nav.adminSystem')))).toBe(false)
  expect(items.some((i) => i.includes(t('nav.profile')))).toBe(true)
  await expect(page.getByRole('button', { name: t('projects.create.card') })).toHaveCount(0)

  for (const path of ['/admin/users', '/admin/roles', '/admin/system']) {
    await page.goto(path)
    await expect(page.getByText(t('auth.forbidden.title'))).toBeVisible()
  }
})

test('the admin can open every admin screen', async ({ signedIn }) => {
  const page = await signedIn(adminCreds())
  const bar = new Topbar(page)
  await bar.goTo('adminUsers')
  await expect(page.getByRole('heading', { level: 1, name: t('nav.adminUsers') })).toBeVisible()
  await bar.goTo('adminRoles')
  await expect(page.getByRole('heading', { level: 1, name: t('nav.adminRoles') })).toBeVisible()
  await bar.goTo('adminSystem')
  await expect(page.getByRole('heading', { level: 1, name: t('nav.adminSystem') })).toBeVisible()
})
