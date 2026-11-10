import type { Page } from '@playwright/test'
import { adminCreds, uniq } from '../support/api'
import { Topbar, tr } from '../support/pages'
import { expect, test } from '../support/test'

const t = tr('ru')

/** Records every data-nav value the root element takes, and frame/CLS/long-task statistics. */
async function instrument(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __nav: string[]
      __frames: number[]
      __cls: number
      __long: number
      __dur: number[]
    }
    w.__nav = []
    w.__dur = []
    let began = 0
    w.__frames = []
    w.__cls = 0
    w.__long = 0
    new MutationObserver(() => {
      const v = document.documentElement.dataset.nav
      if (v) {
        w.__nav.push(v)
        began = performance.now()
      } else if (began) w.__dur.push(Math.round(performance.now() - began))
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-nav'] })
    new PerformanceObserver((l) => {
      for (const e of l.getEntries() as unknown as { value: number; hadRecentInput: boolean }[])
        if (!e.hadRecentInput) w.__cls += e.value
    }).observe({ type: 'layout-shift', buffered: false })
    new PerformanceObserver((l) => {
      w.__long += l.getEntries().length
    }).observe({ type: 'longtask', buffered: false })
    let last = performance.now()
    const tick = (now: number) => {
      w.__frames.push(now - last)
      last = now
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}

const stats = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as {
      __nav: string[]
      __frames: number[]
      __cls: number
      __long: number
      __dur: number[]
    }
    const f = [...w.__frames].sort((a, b) => a - b)
    return {
      nav: w.__nav,
      durations: w.__dur,
      cls: w.__cls,
      long: w.__long,
      frames: f.length,
      worst: f.at(-1) ?? 0,
      p95: f[Math.floor(f.length * 0.95)] ?? 0,
    }
  })

const settled = (page: Page) =>
  expect.poll(() => page.evaluate(() => document.documentElement.dataset.nav ?? '')).toBe('')

test.describe('desktop route transitions', () => {
  test.skip(
    ({ browserName, isMobile }) => browserName !== 'chromium' || isMobile,
    'View Transitions, desktop',
  )
  test.use({ reducedMotion: 'no-preference' })

  test('drill in, back and forward animate, keep focus, title and history right', async ({
    admin,
    signedIn,
  }, info) => {
    const title = uniq('Motion ')
    await admin.createProject(title)
    const page = await signedIn(adminCreds(), { theme: 'dark' })
    await page.goto('/')
    await expect(page.getByText(title).first()).toBeVisible()
    await instrument(page)

    // Shared-shell check: the top bar element must be the very same node after navigating.
    await page.evaluate(() => {
      ;(window as unknown as { __bar: Element | null }).__bar = document.querySelector('header.topbar')
    })

    // list -> project (drill) with a frame sequence for visual review.
    const shots: Promise<unknown>[] = []
    await page.getByText(title).first().click()
    for (let i = 0; i < 6; i++) {
      shots.push(page.screenshot({ path: `e2e/.output/shots/vt-drill-${info.project.name}-${i}.png` }))
      await page.waitForTimeout(40)
    }
    await Promise.all(shots)
    await expect(page).toHaveURL(/\/projects\/[^/]+$/)
    await settled(page)
    await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('main')
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible()
    await expect.poll(() => page.title()).toContain(title)

    // back (browser history): list again, focus on main, title restored.
    await page.goBack()
    await expect(page).toHaveURL(/\/$/)
    await settled(page)
    await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('main')
    await expect.poll(() => page.title()).toContain(t('projects.title'))

    await page.goForward()
    await expect(page).toHaveURL(/\/projects\/[^/]+$/)
    await settled(page)

    // sibling navigation through the user menu.
    await new Topbar(page).goTo('profile')
    await expect(page).toHaveURL(/\/profile$/)
    await settled(page)

    const s = await stats(page)
    info.annotations.push({ type: 'frames', description: JSON.stringify(s) })
    expect(s.nav).toEqual(expect.arrayContaining(['drill', 'back']))
    expect(s.cls).toBe(0)
    // Each transition (animation plus the wait for the destination to render) stays well under a second.
    for (const d of s.durations) expect(d).toBeLessThan(1000)
    const sameBar = await page.evaluate(
      () =>
        (window as unknown as { __bar: Element | null }).__bar === document.querySelector('header.topbar'),
    )
    expect(sameBar).toBe(true)
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

test.describe('reduced motion', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'View Transitions')
  test.use({ reducedMotion: 'reduce' })

  test('navigation is instant: no view transition is started', async ({ signedIn }) => {
    const page = await signedIn(adminCreds())
    await page.goto('/')
    await instrument(page)
    await new Topbar(page).goTo('profile')
    await expect(page).toHaveURL(/\/profile$/)
    await page.goBack()
    await expect(page).toHaveURL(/\/$/)
    expect((await stats(page)).nav).toEqual([])
    await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('main')
  })
})

test.describe('phones', () => {
  test.skip(({ isMobile }) => !isMobile, 'touch devices only')
  test.use({ reducedMotion: 'no-preference' })

  test('touch devices get the light fade, never a view transition, and navigation works', async ({
    signedIn,
  }) => {
    const page = await signedIn(adminCreds())
    await page.goto('/')
    await instrument(page)
    await new Topbar(page).goTo('profile')
    await expect(page).toHaveURL(/\/profile$/)
    await expect(page.locator('main.page')).toHaveClass(/route-enter/)
    await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('main')
    await page.goBack()
    await expect(page).toHaveURL(/\/$/)
    expect((await stats(page)).nav).toEqual([])
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
