import AxeBuilder from '@axe-core/playwright'
import { Api } from '../support/api'
import { LoginPage } from '../support/pages'
import { A11Y_STATES, enter, type Locale, SCREENS, snapshotProject, type Theme } from '../support/screens'
import { expect, seedPrefs, test } from '../support/test'

// Accessibility audit with axe-core on every screen and the dialog, menu, sheet and selection states, in
// both themes and both languages (Chromium and the iPhone profile). By default serious and critical
// findings are printed and attached to the report; with E2E_AXE_STRICT=1 every finding of every impact
// (including best-practice rules) fails the test.
const THEMES: Theme[] = ['dark', 'light']
const LOCALES: Locale[] = ['ru', 'uz']
const strict = process.env.E2E_AXE_STRICT === '1'

test.beforeEach(({ browserName: _b }, info) => {
  test.skip(
    !['chromium-desktop', 'iphone-15'].includes(info.project.name),
    'axe runs on chromium and iPhone only',
  )
})

async function audit(page: import('@playwright/test').Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze()
  const bad = strict
    ? results.violations
    : results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  const summary = bad.map((v) => ({
    rule: v.id,
    impact: v.impact,
    help: v.help,
    nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ')),
    count: v.nodes.length,
  }))
  if (summary.length > 0) {
    console.log(`AXE ${label}: ${JSON.stringify(summary)}`)
    await test.info().attach(`axe-${label}.json`, {
      body: JSON.stringify(summary, null, 2),
      contentType: 'application/json',
    })
  }
  if (strict) expect(summary).toEqual([])
}

for (const locale of LOCALES) {
  for (const theme of THEMES) {
    test(`axe: login ${locale} ${theme}`, async ({ freshContext }) => {
      const ctx = await freshContext()
      await seedPrefs(ctx, locale, theme)
      const page = await ctx.newPage()
      await new LoginPage(page).open()
      await audit(page, `login-${locale}-${theme}`)
    })

    for (const screen of [...SCREENS, ...A11Y_STATES]) {
      test(`axe: ${screen.id} ${locale} ${theme}`, async ({ freshContext }) => {
        const admin = await Api.admin()
        const roleIds = [await admin.roleId('admin')]
        const user = await admin.createReadyUser({ displayName: 'Axe Admin', roleIds, locale, theme })
        const projectId = await snapshotProject(admin)
        const ctx = await freshContext()
        const page = await ctx.newPage()
        await enter(page, user, locale, theme)
        await screen.open(page, { api: admin, projectId, locale })
        if (screen.id === 'settings') {
          // The pinned save bar covers the lowest fields on a short window until the page is scrolled to its
          // end; measure that state, because axe reports a target hidden under the bar as too small.
          await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
        }
        await audit(page, `${screen.id}-${locale}-${theme}`)
      })
    }
  }
}
