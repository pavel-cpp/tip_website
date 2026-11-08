import { Api } from '../support/api'
import { LoginPage } from '../support/pages'
import { enter, hideVolatile, type Locale, SCREENS, snapshotProject, type Theme } from '../support/screens'
import { expect, seedPrefs, test } from '../support/test'

// Screenshot regression. Only Chromium and the iPhone profile are compared (a few MB in total);
// the other browsers are covered by the behavioural specs. Regions whose content depends on other
// tests running in parallel (project list, user table, role list, system numbers) are masked.
const COMPARED = ['chromium-desktop', 'iphone-15']
const LOCALES: Locale[] = ['ru', 'uz']
const THEMES: Theme[] = ['dark', 'light']

test.beforeEach(({ browserName: _b }, info) => {
  test.skip(!COMPARED.includes(info.project.name), 'visual comparison runs on chromium and iPhone only')
})

test.describe('login screen', () => {
  for (const locale of LOCALES) {
    for (const theme of THEMES) {
      test(`login ${locale} ${theme}`, async ({ freshContext }) => {
        const ctx = await freshContext()
        await seedPrefs(ctx, locale, theme)
        const page = await ctx.newPage()
        await new LoginPage(page).open()
        await page.evaluate(() => document.fonts.ready)
        await expect(page).toHaveScreenshot(`login-${locale}-${theme}.png`, { scale: 'css' })
      })
    }
  }
})

for (const screen of SCREENS) {
  test.describe(screen.id, () => {
    for (const locale of LOCALES) {
      for (const theme of THEMES) {
        test(`${screen.id} ${locale} ${theme}`, async ({ freshContext }) => {
          const admin = await Api.admin()
          const roleIds = [await admin.roleId('admin')]
          const user = await admin.createReadyUser({ displayName: 'Snapshot Admin', roleIds, locale, theme })
          const projectId = await snapshotProject(admin)
          const ctx = await freshContext()
          const page = await ctx.newPage()
          await enter(page, user, locale, theme)
          await screen.open(page, { api: admin, projectId, locale })
          await hideVolatile(page)
          const mask = (screen.volatile ?? []).map((sel) => page.locator(sel))
          await expect(page).toHaveScreenshot(`${screen.id}-${locale}-${theme}.png`, {
            scale: 'css',
            mask,
          })
        })
      }
    }
  })
}
