import { htmlLang, Topbar, theme, tr } from '../support/pages'
import { expect, test } from '../support/test'

test('the dark theme and Russian are the defaults', async ({ page }) => {
  await page.goto('/login')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru')
})

test('profile controls store language and theme on the server and survive a reload', async ({
  admin,
  signedIn,
}) => {
  const user = await admin.createReadyUser()
  const page = await signedIn(user)
  await page.goto('/profile')
  const t = tr('ru')
  await page.getByRole('radio', { name: t('theme.light') }).click()
  await expect.poll(() => theme(page)).toBe('light')
  await page.getByRole('radio', { name: t('language.uz') }).click()
  await expect.poll(() => htmlLang(page)).toBe('uz')
  // Wait for the PATCH /me round trips to finish before reloading.
  await page.waitForLoadState('networkidle')
  await page.reload()
  await expect.poll(() => theme(page)).toBe('light')
  await expect.poll(() => htmlLang(page)).toBe('uz')
  await expect(page.getByRole('heading', { level: 1, name: tr('uz')('profile.title') })).toBeVisible()
})

test('a user created with stored preferences gets them on every device', async ({ admin, signedIn }) => {
  const user = await admin.createReadyUser({ locale: 'uz', theme: 'light' })
  const page = await signedIn(user)
  await expect.poll(() => theme(page)).toBe('light')
  await expect.poll(() => htmlLang(page)).toBe('uz')
})

test('top bar theme switch persists across reload for a signed-in user', async ({ admin, signedIn }) => {
  const user = await admin.createReadyUser()
  const page = await signedIn(user)
  const bar = new Topbar(page)
  await bar.chooseTheme('light')
  await expect.poll(() => theme(page)).toBe('light')
  await page.reload()
  await expect.poll(() => theme(page)).toBe('light')
})

test('top bar language switch persists across reload for a signed-in user', async ({ admin, signedIn }) => {
  const user = await admin.createReadyUser()
  const page = await signedIn(user)
  await new Topbar(page).chooseLanguage('uz')
  await expect.poll(() => htmlLang(page)).toBe('uz')
  await page.reload()
  await expect.poll(() => htmlLang(page)).toBe('uz')
})

test('top bar theme and language switch apply immediately and persist for an anonymous visitor', async ({
  page,
}) => {
  await page.goto('/login')
  const bar = new Topbar(page)
  await bar.chooseTheme('light')
  await expect.poll(() => theme(page)).toBe('light')
  await bar.chooseLanguage('uz')
  await expect.poll(() => htmlLang(page)).toBe('uz')
  await page.reload()
  await expect.poll(() => theme(page)).toBe('light')
  await expect.poll(() => htmlLang(page)).toBe('uz')
  await expect(page.getByText(tr('uz')('auth.login.subtitle'))).toBeVisible()
})
