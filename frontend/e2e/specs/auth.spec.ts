import { adminCreds, uniq } from '../support/api'
import { LoginPage, Topbar, tr } from '../support/pages'
import { expect, seedPrefs, test } from '../support/test'

test.describe('login and session', () => {
  for (const locale of ['ru', 'uz'] as const) {
    test(`signs in and shows the projects screen (${locale})`, async ({ freshContext, admin }) => {
      const t = tr(locale)
      // The locale stored on the server wins after sign-in, so the user is created with it.
      const user = await admin.createReadyUser({ locale })
      const ctx = await freshContext()
      await seedPrefs(ctx, locale, 'dark')
      const page = await ctx.newPage()
      const login = new LoginPage(page)
      await login.open()
      await expect(page.locator('html')).toHaveAttribute('lang', locale)
      await expect(page.getByText(t('auth.login.subtitle'))).toBeVisible()
      await login.fill(user)
      await expect(login.submit).toContainText(t('auth.login.submit'))
      await login.submit.click()
      await expect(page).toHaveURL(/\/$/)
      await expect(page.getByRole('heading', { level: 1, name: t('projects.title') })).toBeVisible()
    })

    test(`wrong password shows the localized error (${locale})`, async ({ freshContext }) => {
      const t = tr(locale)
      const ctx = await freshContext()
      await seedPrefs(ctx, locale, 'dark')
      const page = await ctx.newPage()
      const login = new LoginPage(page)
      await login.open()
      await login.fill({ login: uniq('nobody'), password: 'definitely-wrong' })
      await login.submit.click()
      await expect(login.error).toHaveText(t('errors.BAD_CREDENTIALS'))
      await expect(page).toHaveURL(/\/login/)
    })
  }

  test('empty form asks for both fields', async ({ page }) => {
    const login = new LoginPage(page)
    await login.open()
    await login.submit.click()
    await expect(login.error).toHaveText(tr('ru')('auth.login.fillBoth'))
  })

  test('session survives a reload and logout ends it', async ({ page }) => {
    const login = new LoginPage(page)
    await login.signIn(adminCreds())
    await page.reload()
    await expect(page.getByRole('heading', { level: 1, name: tr('ru')('projects.title') })).toBeVisible()
    await expect(page).not.toHaveURL(/\/login/)

    await new Topbar(page).logout()
    await expect(page).toHaveURL(/\/login/)
    await page.reload()
    await expect(login.login).toBeVisible()
    await expect(page).toHaveURL(/\/login/)
  })

  test('a protected page redirects an anonymous visitor to the login form', async ({ page }) => {
    await page.goto('/admin/users')
    await expect(page).toHaveURL(/\/login/)
  })
})
