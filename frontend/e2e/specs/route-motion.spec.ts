import type { Page } from '@playwright/test'
import { type Api, adminCreds, uniq } from '../support/api'
import { Topbar, tr } from '../support/pages'
import { expect, test } from '../support/test'

// The route motion engine (src/lib/routeMotion.ts) runs the same Web Animations in Chromium, Firefox and WebKit.
// Desktop pointer profiles only: phones keep the CSS fade.
const t = tr('ru')

test.skip(({ isMobile }) => isMobile, 'touch devices keep the light fade')

async function seeded(admin: Api, name: string) {
  const project = await admin.createProject(name)
  await admin.uploadImage(project.id)
  await admin.addParticipants(
    project.id,
    Array.from({ length: 6 }, (_, i) => ({ name: `Person ${i + 1}`, phone: `+9989000${1000 + i}` })),
  )
  return project
}

/** Number of engine layers plus Web Animations left on the page (CSS animations and transitions excluded). */
const leftovers = (page: Page) =>
  page.evaluate(() => {
    const css = (a: Animation) =>
      (typeof CSSAnimation !== 'undefined' && a instanceof CSSAnimation) ||
      (typeof CSSTransition !== 'undefined' && a instanceof CSSTransition)
    return {
      layers: document.querySelectorAll('.route-layer, .route-ghost').length,
      anims: document.getAnimations().filter((a) => !css(a) && a.playState !== 'finished').length,
    }
  })

const settled = (page: Page) =>
  expect
    .poll(async () => JSON.stringify(await leftovers(page)), { timeout: 5000 })
    .toBe('{"layers":0,"anims":0}')

test.describe('route motion engine', () => {
  test.use({ reducedMotion: 'no-preference' })

  test('list -> project -> settings -> back leaves no layers, animations or stray styles', async ({
    admin,
    signedIn,
  }) => {
    const project = await seeded(admin, uniq('Route '))
    const page = await signedIn(adminCreds(), { theme: 'dark' })
    await page.goto('/')
    const card = page.locator(`.project-card[data-flip-id="${project.id}"]`)
    await expect(card).toBeVisible()

    const seen = await page.evaluate(() => {
      const w = window as unknown as { __layers: number }
      w.__layers = 0
      new MutationObserver((records) => {
        for (const r of records)
          for (const n of r.addedNodes)
            if (n instanceof HTMLElement && n.classList.contains('route-layer')) w.__layers++
      }).observe(document.body, { childList: true })
      return true
    })
    expect(seen).toBe(true)

    await card.locator('a.project-card-link').click()
    await expect(page).toHaveURL(new RegExp(`/projects/${project.id}$`))
    await expect(page.locator('.ws')).toBeVisible()
    await settled(page)
    // The motion really ran: layers were added, and are gone now.
    expect(await page.evaluate(() => (window as unknown as { __layers: number }).__layers)).toBeGreaterThan(0)

    await page.getByRole('button', { name: t('workspace.settings') }).click()
    await expect(page).toHaveURL(/\/settings$/)
    await expect(page.locator('.st-title')).toBeVisible()
    await settled(page)

    await page.getByRole('button', { name: t('action.close') }).click()
    await expect(page).toHaveURL(new RegExp(`/projects/${project.id}$`))
    await settled(page)

    // Everything the user sees is fully opaque and un-transformed once the motion is over.
    const rest = await page.evaluate(() => {
      const main = document.querySelector('main.page') as HTMLElement
      const blocks = [...main.querySelectorAll<HTMLElement>('.ws-toolbar, .ws-grid, .tk-stage')]
      return blocks.map((b) => getComputedStyle(b).opacity)
    })
    for (const o of rest) expect(o).toBe('1')

    // Close returned through history, so one step back is the list.
    await page.goBack()
    await expect(page).toHaveURL(/\/$/)
    await settled(page)
    await expect(card).toBeVisible()
    await page.goForward()
    await expect(page).toHaveURL(new RegExp(`/projects/${project.id}$`))
    await settled(page)
  })

  test('a flying ghost exists while the card opens, and the title arrives at its final place', async ({
    admin,
    signedIn,
  }) => {
    const title = uniq('Ghost ')
    const project = await seeded(admin, title)
    const page = await signedIn(adminCreds(), { theme: 'dark' })
    await page.goto('/')
    const link = page.locator(`.project-card[data-flip-id="${project.id}"] a.project-card-link`)
    await expect(link).toBeVisible()
    await link.click()
    await expect.poll(() => page.locator('.route-ghost').count(), { timeout: 2000 }).toBeGreaterThan(0)
    // The old page is a layer, aria-hidden and inert: it can neither be reached nor read out.
    const hidden = await page.evaluate(() =>
      [...document.querySelectorAll('.route-layer')].every(
        (l) => l.getAttribute('aria-hidden') === 'true' && (l as HTMLElement).inert,
      ),
    )
    expect(hidden).toBe(true)
    await settled(page)
    const crumb = page.locator('.wsbar-title')
    await expect(crumb).toHaveText(title)
    expect(await crumb.evaluate((e) => getComputedStyle(e).opacity)).toBe('1')
  })

  test('a new navigation in the middle of a motion ends cleanly on the right page', async ({
    admin,
    signedIn,
  }) => {
    const project = await seeded(admin, uniq('Cut '))
    const page = await signedIn(adminCreds(), { theme: 'dark' })
    await page.goto('/')
    const link = page.locator(`.project-card[data-flip-id="${project.id}"] a.project-card-link`)
    await expect(link).toBeVisible()
    await link.click()
    await page.waitForTimeout(90)
    await new Topbar(page).goTo('profile')
    await expect(page).toHaveURL(/\/profile$/)
    await settled(page)
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible()
    expect(
      await page.evaluate(() => getComputedStyle(document.querySelector('main.page') as Element).opacity),
    ).toBe('1')
    // And again, back and forth quickly.
    await page.goBack()
    await page.waitForTimeout(60)
    await page.goForward()
    await expect(page).toHaveURL(/\/profile$/)
    await settled(page)
    expect(await page.evaluate(() => document.querySelectorAll('main.page').length)).toBe(1)
  })

  test('sibling screens slide along the menu order and keep focus and title', async ({ signedIn }) => {
    const page = await signedIn(adminCreds(), { theme: 'dark' })
    await page.goto('/')
    const bar = new Topbar(page)
    await bar.goTo('profile')
    await expect(page).toHaveURL(/\/profile$/)
    await settled(page)
    await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('main')
    await expect.poll(() => page.title()).toContain(t('profile.title'))
    await bar.goTo('adminUsers')
    await expect(page).toHaveURL(/\/admin\/users$/)
    await settled(page)
    await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('main')
  })
})

test.describe('reduced motion', () => {
  test.use({ reducedMotion: 'reduce' })

  test('a 120 ms opacity fade at most: no layers, no movement', async ({ signedIn }) => {
    const page = await signedIn(adminCreds(), { theme: 'dark' })
    await page.goto('/')
    await page.evaluate(() => {
      const w = window as unknown as { __layers: number; __moves: number }
      w.__layers = 0
      w.__moves = 0
      new MutationObserver((records) => {
        for (const r of records)
          for (const n of r.addedNodes)
            if (n instanceof HTMLElement && n.classList.contains('route-layer')) w.__layers++
      }).observe(document.body, { childList: true })
      const orig = Element.prototype.animate
      Element.prototype.animate = function (this: Element, ...args: Parameters<Element['animate']>) {
        const frames = args[0] as Keyframe[]
        for (const f of frames ?? []) if ('transform' in f) w.__moves++
        return orig.apply(this, args)
      }
    })
    await new Topbar(page).goTo('profile')
    await expect(page).toHaveURL(/\/profile$/)
    await settled(page)
    const r = await page.evaluate(() => {
      const w = window as unknown as { __layers: number; __moves: number }
      return { layers: w.__layers, moves: w.__moves }
    })
    expect(r.layers).toBe(0)
    expect(r.moves).toBe(0)
  })
})

// Developer aid, not part of the suite: pauses every engine animation as it is created and writes frames of the
// timeline (works the same in all three engines). E2E_FRAMES=1 npx playwright test --project=chromium-desktop route-motion -g frames
test.describe('frames', () => {
  test.use({ reducedMotion: 'no-preference' })

  test('frames', async ({ admin, signedIn, browserName }, info) => {
    test.skip(!process.env.E2E_FRAMES, 'developer aid')
    const title = uniq('Frames ')
    const project = await seeded(admin, title)
    const page = await signedIn(adminCreds(), { theme: 'dark' })
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto('/')
    const link = page.locator(`.project-card[data-flip-id="${project.id}"] a.project-card-link`)
    await expect(link).toBeVisible()
    const dir = `e2e/.output/shots/route-${browserName}`

    const run = async (name: string, act: () => Promise<unknown>, times: number[]) => {
      await page.evaluate(() => {
        const w = window as unknown as { __anims: Animation[]; __orig?: typeof Element.prototype.animate }
        w.__anims = []
        w.__orig ??= Element.prototype.animate
        const orig = w.__orig
        Element.prototype.animate = function (this: Element, ...args: Parameters<Element['animate']>) {
          const a = orig.apply(this, args)
          a.pause()
          w.__anims.push(a)
          return a
        }
      })
      await act()
      await expect
        .poll(() => page.evaluate(() => (window as unknown as { __anims: Animation[] }).__anims.length))
        .toBeGreaterThan(0)
      for (const ms of times) {
        await page.evaluate((v) => {
          for (const a of (window as unknown as { __anims: Animation[] }).__anims) a.currentTime = v
        }, ms)
        await page.screenshot({ path: `${dir}/${name}-${String(ms).padStart(3, '0')}.png` })
      }
      await page.evaluate(() => {
        const w = window as unknown as { __anims: Animation[]; __orig: typeof Element.prototype.animate }
        Element.prototype.animate = w.__orig
        for (const a of w.__anims) a.finish()
      })
      await settled(page)
    }

    const shots = [0, 60, 120, 180, 240, 300, 380]
    await run('1-open', () => link.click(), shots)
    await run('2-settings', () => page.getByRole('button', { name: t('workspace.settings') }).click(), shots)
    await run('3-close', () => page.getByRole('button', { name: t('action.close') }).click(), shots)
    await run(
      '4-list',
      () =>
        page
          .getByRole('link', { name: t('projects.title') })
          .first()
          .click(),
      shots,
    )
    await run('5-sibling', () => new Topbar(page).goTo('adminUsers'), [0, 80, 160, 260, 380])
    info.annotations.push({ type: 'frames', description: dir })
  })
})
