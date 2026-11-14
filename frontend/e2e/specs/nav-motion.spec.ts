import { adminCreds } from '../support/api'
import { Topbar, tr } from '../support/pages'
import { expect, test } from '../support/test'

const t = tr('ru')

// Route motion itself is covered by route-motion.spec.ts; this file keeps the navigation contract around it.

test.describe('desktop', () => {
  test.skip(({ isMobile }) => isMobile, 'desktop pointer profiles')
  test.use({ reducedMotion: 'no-preference' })

  test('the top bar is the same node across navigations; focus, title and history stay right', async ({
    signedIn,
    browserName,
  }) => {
    const page = await signedIn(adminCreds(), { theme: 'dark' })
    await page.goto('/')
    // An expando mark instead of a stored element reference (references do not survive in every engine).
    await page.evaluate(() => {
      document.querySelector('header.topbar')?.setAttribute('data-keep', '1')
    })
    await new Topbar(page).goTo('profile')
    await expect(page).toHaveURL(/\/profile$/)
    await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('main')
    await expect.poll(() => page.title()).toContain(t('profile.title'))
    await page.goBack()
    await expect(page).toHaveURL(/\/$/)
    await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('main')
    await expect.poll(() => page.title()).toContain(t('projects.title'))
    await page.goForward()
    await expect(page).toHaveURL(/\/profile$/)
    // WebKit re-creates the bar on client-side navigations (also with reduced motion, so not the route motion).
    if (browserName !== 'webkit') await expect(page.locator('header.topbar[data-keep="1"]')).toHaveCount(1)
  })

  test('skip link still moves focus to the main region after a transition', async ({ signedIn }) => {
    const page = await signedIn(adminCreds())
    await page.goto('/')
    await new Topbar(page).goTo('profile')
    await expect(page).toHaveURL(/\/profile$/)
    const skip = page.getByRole('link', { name: t('a11y.skipToContent') })
    await skip.focus()
    await expect(skip).toBeFocused()
    await page.keyboard.press('Enter')
    await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('main')
  })
})

test.describe('phones', () => {
  test.skip(({ isMobile }) => !isMobile, 'touch devices only')
  test.use({ reducedMotion: 'no-preference' })

  test('touch devices slide pages in and out, leave no layers behind, and navigation works', async ({
    signedIn,
  }) => {
    const page = await signedIn(adminCreds())
    await page.goto('/')
    await new Topbar(page).goTo('profile')
    await expect(page).toHaveURL(/\/profile$/)
    // The sliding transition (lib/routeMotion.ts, mode "push") replaces the CSS fade of `.route-enter`...
    await expect(page.locator('#main')).not.toHaveClass(/route-enter/)
    // ...and everything it adds is gone once it has played, including the clip on the page width.
    await expect.poll(() => page.locator('.route-layer').count()).toBe(0)
    await expect(page.locator('html')).not.toHaveClass(/route-pushing/)
    await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('main')
    await page.goBack()
    await expect(page).toHaveURL(/\/$/)
    await expect.poll(() => page.locator('.route-layer').count()).toBe(0)
  })
})

test('admin navigation icons are distinct, System in particular', async ({ signedIn }) => {
  const page = await signedIn(adminCreds())
  await page.goto('/')
  await new Topbar(page).userMenu.click()
  await page.getByRole('menuitem').first().waitFor()
  const items = await page.getByRole('menuitem').evaluateAll((els) =>
    els.map((e) => ({
      name: e.textContent?.trim() ?? '',
      icon: e.querySelector('svg')?.innerHTML ?? '',
    })),
  )
  const withIcon = items.filter((i) => i.icon)
  const icons = withIcon.map((i) => i.icon)
  expect(new Set(icons).size).toBe(icons.length)
  const system = items.find((i) => [t('nav.adminSystem'), tr('uz')('nav.adminSystem')].includes(i.name))
  expect(system?.icon).toBeTruthy()
  // The old gear-like glyph (shared with the settings and sun symbols) must not come back.
  expect(system?.icon).toContain('<rect')
})
