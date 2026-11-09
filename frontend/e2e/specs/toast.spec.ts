import type { Page } from '@playwright/test'
import { type Locale, tr } from '../support/pages'
import { expect, test } from '../support/test'

const WIDTHS = [1440, 820, 390, 360]

/** Saves the profile display name `n` times so that many toasts stack up. */
async function raiseToasts(page: Page, locale: Locale, n: number): Promise<void> {
  const t = tr(locale)
  for (let i = 0; i < n; i++) {
    await page.getByLabel(t('profile.displayName')).fill(`Toast tester ${i}`)
    await page.getByRole('button', { name: t('profile.save'), exact: true }).click()
    await expect(page.locator('.toast')).toHaveCount(i + 1)
  }
}

for (const locale of ['ru', 'uz'] as const) {
  for (const colour of ['dark', 'light'] as const) {
    test(`toasts are centred, unclipped and clear of the top bar (${locale}, ${colour})`, async ({
      admin,
      signedIn,
    }, info) => {
      const user = await admin.createReadyUser({ locale, theme: colour })
      const page = await signedIn(user, { locale, theme: colour })
      await page.goto('/profile')
      await raiseToasts(page, locale, 2)
      const view = page.viewportSize()
      if (!view) throw new Error('no viewport')
      const widths = info.project.name === 'chromium-desktop' ? WIDTHS : [view.width]
      for (const width of widths) {
        await page.setViewportSize({ width, height: view.height })
        const boxes = await page.locator('.toast').evaluateAll((els) =>
          els.map((e) => {
            const r = e.getBoundingClientRect()
            return { l: r.left, r: r.right, t: r.top, sw: e.scrollWidth, cw: e.clientWidth }
          }),
        )
        // The visible area: classic scrollbars (WebKit emulation) are not part of what fixed boxes centre on.
        const room = await page.evaluate(() => window.visualViewport?.width ?? innerWidth)
        const bar = await page.locator('header.topbar').boundingBox()
        for (const b of boxes) {
          expect(Math.abs((b.l + b.r) / 2 - room / 2)).toBeLessThanOrEqual(1)
          expect(b.l).toBeGreaterThanOrEqual(0)
          expect(b.r).toBeLessThanOrEqual(room)
          expect(b.sw).toBeLessThanOrEqual(b.cw + 1)
          expect(b.t).toBeGreaterThanOrEqual((bar?.y ?? 0) + (bar?.height ?? 0))
        }
        await page.screenshot({
          path: `e2e/.output/shots/toast-${info.project.name}-${width}-${locale}-${colour}.png`,
        })
      }
    })
  }
}

test('toast roles: confirmations are status, hover pauses the timer bar', async ({ admin, signedIn }) => {
  const user = await admin.createReadyUser()
  const page = await signedIn(user)
  await page.goto('/profile')
  await raiseToasts(page, 'ru', 1)
  await expect(page.locator('.toast').first()).not.toHaveAttribute('role', 'alert')
  await page.locator('.toast').first().hover()
  await expect(page.locator('.toast').first()).toHaveAttribute('data-paused', 'true')
})
