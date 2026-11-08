import AxeBuilder from '@axe-core/playwright'
import { Api } from '../support/api'
import { LoginPage } from '../support/pages'
import { enter, SCREENS, snapshotProject, type Theme } from '../support/screens'
import { expect, seedPrefs, test } from '../support/test'

// Accessibility audit with axe-core on the main screens in both themes (Russian UI, Chromium and the
// iPhone profile). Serious and critical findings are printed and attached to the test report. The
// test fails on them only with E2E_AXE_STRICT=1, because this stream reports problems and fixes none.
const THEMES: Theme[] = ['dark', 'light']
const strict = process.env.E2E_AXE_STRICT === '1'

test.beforeEach(({ browserName: _b }, info) => {
  test.skip(
    !['chromium-desktop', 'iphone-15'].includes(info.project.name),
    'axe runs on chromium and iPhone only',
  )
})

async function audit(page: import('@playwright/test').Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()
  const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  const summary = bad.map((v) => ({
    rule: v.id,
    impact: v.impact,
    help: v.help,
    nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ')),
    count: v.nodes.length,
  }))
  if (summary.length > 0) {
    console.log(`AXE ${label}: ${JSON.stringify(summary)}`)
    await test
      .info()
      .attach(`axe-${label}.json`, {
        body: JSON.stringify(summary, null, 2),
        contentType: 'application/json',
      })
  }
  if (strict) expect(summary).toEqual([])
}

for (const theme of THEMES) {
  test(`axe: login ${theme}`, async ({ freshContext }) => {
    const ctx = await freshContext()
    await seedPrefs(ctx, 'ru', theme)
    const page = await ctx.newPage()
    await new LoginPage(page).open()
    await audit(page, `login-${theme}`)
  })

  for (const screen of SCREENS) {
    test(`axe: ${screen.id} ${theme}`, async ({ freshContext }) => {
      const admin = await Api.admin()
      const roleIds = [await admin.roleId('admin')]
      const user = await admin.createReadyUser({ displayName: 'Axe Admin', roleIds, locale: 'ru', theme })
      const projectId = await snapshotProject(admin)
      const ctx = await freshContext()
      const page = await ctx.newPage()
      await enter(page, user, 'ru', theme)
      await screen.open(page, { api: admin, projectId, locale: 'ru' })
      await audit(page, `${screen.id}-${theme}`)
    })
  }
}
