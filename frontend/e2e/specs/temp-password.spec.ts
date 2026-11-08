import { adminCreds, uniq } from '../support/api'
import { LoginPage, Topbar, tr } from '../support/pages'
import { expect, test } from '../support/test'

const t = tr('ru')

test('admin creates a user, the temporary password prompts a change on first login', async ({
  signedIn,
  freshContext,
}) => {
  const admin = await signedIn(adminCreds())
  const login = uniq('tmp')
  await admin.goto('/admin/users')
  await admin.getByRole('button', { name: t('admin.users.create') }).click()
  const dialog = admin.getByRole('dialog')
  await dialog.getByLabel(t('auth.login.login'), { exact: true }).fill(login)
  await dialog.getByLabel(t('profile.displayName'), { exact: true }).fill('Temp User')
  await dialog.getByRole('button', { name: t('action.create') }).click()

  const secret = admin.getByRole('dialog').getByLabel(t('admin.users.tempPassword'))
  await expect(secret).toBeVisible()
  const temp = await secret.inputValue()
  expect(temp).toHaveLength(16)
  await admin.getByRole('button', { name: t('admin.users.passwordSaved') }).click()
  await expect(admin.getByRole('row', { name: new RegExp(login) })).toBeVisible()

  // First login of the new user: the recommendation appears and can be completed.
  const ctx = await freshContext()
  const page = await ctx.newPage()
  await new LoginPage(page).signIn({ login, password: temp })
  const prompt = page.getByRole('dialog', { name: t('auth.prompt.title') })
  await expect(prompt).toBeVisible()
  await prompt.getByRole('button', { name: t('auth.prompt.now') }).click()
  const newPassword = `${uniq('np')}-secret`
  await prompt.getByLabel(t('auth.password.current'), { exact: true }).fill(temp)
  await prompt.getByLabel(t('auth.password.new'), { exact: true }).fill(newPassword)
  await prompt.getByLabel(t('auth.password.repeat'), { exact: true }).fill(newPassword)
  await prompt.getByRole('button', { name: t('auth.password.submit') }).click()
  await expect(page.getByText(t('auth.password.changed'))).toBeVisible()
  await expect(prompt).toBeHidden()

  // The new password works and no prompt follows.
  await new Topbar(page).logout()
  await new LoginPage(page).signIn({ login, password: newPassword })
  await expect(page.getByRole('dialog', { name: t('auth.prompt.title') })).toHaveCount(0)
})

test('the recommendation can be postponed', async ({ admin, signedIn }) => {
  const user = await admin.createUser()
  const page = await signedIn({ login: user.login, password: user.tempPassword })
  const prompt = page.getByRole('dialog', { name: t('auth.prompt.title') })
  await expect(prompt).toBeVisible()
  await prompt.getByRole('button', { name: t('auth.prompt.later') }).click()
  await expect(prompt).toBeHidden()
  await expect(page.getByRole('heading', { level: 1, name: t('projects.title') })).toBeVisible()
})

test('a wrong current password is reported in the form', async ({ admin, signedIn }) => {
  const user = await admin.createUser()
  const page = await signedIn({ login: user.login, password: user.tempPassword })
  const prompt = page.getByRole('dialog', { name: t('auth.prompt.title') })
  await prompt.getByRole('button', { name: t('auth.prompt.now') }).click()
  await prompt.getByLabel(t('auth.password.current'), { exact: true }).fill('not-the-password')
  await prompt.getByLabel(t('auth.password.new'), { exact: true }).fill('another-long-pass')
  await prompt.getByLabel(t('auth.password.repeat'), { exact: true }).fill('another-long-pass')
  await prompt.getByRole('button', { name: t('auth.password.submit') }).click()
  await expect(prompt.getByText(t('auth.password.currentWrong'))).toBeVisible()
})
