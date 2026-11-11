import type { Page } from '@playwright/test'
import { type Api, adminCreds, uniq } from '../support/api'
import { expect, test } from '../support/test'
import { WorkspacePage } from '../support/workspace'

// Motion polish: the ticket slide and the splitter. Route motion has its own spec (route-motion.spec.ts). The suite
// runs with reduced motion by default, so these specs switch it back on. Frames: E2E_FRAMES=1 (see `frames`).

test.use({ reducedMotion: 'no-preference' })

const desktop = (v: { width: number } | null | undefined) => (v?.width ?? 0) >= 1000

const people = Array.from({ length: 6 }, (_, i) => ({ name: `Person ${i + 1}`, phone: `+99890111000${i}` }))

async function seeded(admin: Api) {
  const project = await admin.createProject(uniq('Motion '))
  await admin.uploadImage(project.id)
  await admin.addParticipants(project.id, people)
  return project
}

/** Hides the table by dragging the splitter to the edge: picture-only mode. */
async function pictureOnly(page: Page, ws: WorkspacePage) {
  const split = page.getByRole('separator', { name: ws.t('workspace.split.label') })
  const b = await split.boundingBox()
  const grid = await page.locator('.ws-grid').boundingBox()
  if (!b || !grid) throw new Error('no splitter')
  const y = b.y + b.height / 2
  await page.mouse.move(b.x + b.width / 2, y)
  await page.mouse.down()
  await page.mouse.move(grid.x + grid.width - 2, y, { steps: 10 })
  await page.mouse.up()
  await expect(page.locator('.ws-slot[data-panel="db"]')).toHaveAttribute('inert', '')
  // Focus leaves the handle, so the arrow keys step tickets.
  await page.locator('.tk-viewport').click()
}

test('stepping tickets in picture-only mode turns the card; quick repeats do not pile up', async ({
  admin,
  signedIn,
  viewport,
}) => {
  test.skip(!desktop(viewport), 'desktop layout')
  const project = await seeded(admin)
  const page = await signedIn(adminCreds())
  const ws = new WorkspacePage(page)
  await ws.open(project.id)
  await pictureOnly(page, ws)
  const who = page.getByTestId('ticket-who')
  await expect(who).toContainText('Person 1')

  await page.keyboard.press('ArrowRight')
  await expect(who).toContainText('Person 2')
  const turn = () =>
    page.evaluate(() =>
      document
        .getAnimations()
        .filter((a) =>
          ((a.effect as KeyframeEffect | null)?.target as HTMLElement | null)?.classList.contains(
            'tk-canvas',
          ),
        )
        .map((a) => String((a.effect as KeyframeEffect).getKeyframes()[0]?.transform)),
    )
  await expect.poll(async () => (await turn()).length).toBe(2)
  // Next: the new card arrives from the right, so it starts shifted right.
  expect((await turn()).some((t) => t.includes('translateX(32px)'))).toBe(true)

  // A burst of steps cancels the running turn each time: never more than the current pair.
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight')
  await expect(who).toContainText('Person 5')
  expect((await turn()).length).toBeLessThanOrEqual(2)

  // Back: mirrored.
  await page.keyboard.press('ArrowLeft')
  await expect(who).toContainText('Person 4')
  await expect.poll(async () => (await turn()).some((t) => t.includes('translateX(-32px)'))).toBe(true)
  await expect.poll(async () => (await turn()).length, { timeout: 3000 }).toBeLessThanOrEqual(2)
})

test('a held arrow key swaps tickets without the page-turn', async ({ admin, signedIn, viewport }) => {
  test.skip(!desktop(viewport), 'desktop layout')
  const project = await seeded(admin)
  const page = await signedIn(adminCreds())
  const ws = new WorkspacePage(page)
  await ws.open(project.id)
  await pictureOnly(page, ws)
  const who = page.getByTestId('ticket-who')
  // The first keydown turns; the auto-repeats (a held key) must cancel it and swap instantly.
  await page.keyboard.down('ArrowRight')
  await page.keyboard.down('ArrowRight')
  await page.keyboard.down('ArrowRight')
  await page.keyboard.up('ArrowRight')
  await expect(who).toContainText('Person 4')
  const n = await page.evaluate(
    () =>
      document
        .getAnimations()
        .filter(
          (a) =>
            !(a instanceof CSSTransition) &&
            ((a.effect as KeyframeEffect | null)?.target as HTMLElement | null)?.classList.contains(
              'tk-canvas',
            ),
        ).length,
  )
  expect(n).toBe(0)
})

test('the splitter follows the pointer 1:1, dims the panel that would hide, and settles on release', async ({
  admin,
  signedIn,
  viewport,
}) => {
  test.skip(!desktop(viewport), 'desktop layout')
  const project = await seeded(admin)
  const page = await signedIn(adminCreds())
  const errors: string[] = []
  // WebKit reports the `interactive-widget` viewport key as an error; it is a hint other engines understand.
  page.on(
    'console',
    (m) => m.type() === 'error' && !m.text().includes('interactive-widget') && errors.push(m.text()),
  )
  const ws = new WorkspacePage(page)
  await ws.open(project.id)
  const split = page.getByRole('separator', { name: ws.t('workspace.split.label') })
  const grid = page.locator('.ws-grid')
  const picture = page.locator('.ws-slot[data-panel="picture"]')
  const db = page.locator('.ws-slot[data-panel="db"]')
  const b = await split.boundingBox()
  const g = await grid.boundingBox()
  if (!b || !g) throw new Error('no splitter')
  const y = b.y + b.height / 2
  await page.mouse.move(b.x + b.width / 2, y)
  await page.mouse.down()
  await expect(grid).toHaveAttribute('data-dragging', '')

  // 1:1: the picture panel is as wide as the pointer travelled, with no easing lag (30 % of the grid).
  await page.mouse.move(g.x + g.width * 0.3, y, { steps: 6 })
  await expect.poll(async () => ((await picture.boundingBox())?.width ?? 0) / g.width).toBeCloseTo(0.3, 1)
  await expect(grid).not.toHaveAttribute('data-hide', /.*/)

  // Past the hide point the panel that would disappear dims; nothing has been hidden yet.
  await page.mouse.move(g.x + g.width - 2, y, { steps: 8 })
  await expect(grid).toHaveAttribute('data-hide', 'second')
  await expect
    .poll(async () => Number(await db.evaluate((el) => getComputedStyle(el).opacity)))
    .toBeLessThan(0.6)
  await expect(db).not.toHaveAttribute('inert', '')

  await page.mouse.up()
  await expect(db).toHaveAttribute('inert', '')
  await expect(grid).not.toHaveAttribute('data-dragging', /.*/)
  await expect(grid).not.toHaveAttribute('data-hide', /.*/)

  // Dragging the hidden panel's handle back out is 1:1 from the edge: the panel grows under the pointer.
  const b2 = await split.boundingBox()
  if (!b2) throw new Error('no splitter')
  await page.mouse.move(b2.x + b2.width / 2, y)
  await page.mouse.down()
  await page.mouse.move(g.x + g.width * 0.6, y, { steps: 8 })
  await expect(db).not.toHaveAttribute('data-hide', /.*/)
  await expect.poll(async () => ((await picture.boundingBox())?.width ?? 0) / g.width).toBeCloseTo(0.6, 1)
  await page.mouse.up()
  await expect(db).not.toHaveAttribute('inert', '')
  expect(errors).toEqual([])
})

test('no ticket animation with reduced motion', async ({ admin, signedIn, viewport }) => {
  test.skip(!desktop(viewport), 'desktop layout')
  const project = await seeded(admin)
  const page = await signedIn(adminCreds())
  const ws = new WorkspacePage(page)
  await ws.open(project.id)
  await pictureOnly(page, ws)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.keyboard.press('ArrowRight')
  await expect(page.getByTestId('ticket-who')).toContainText('Person 2')
  // The opacity swap is a CSS transition; only the scripted page-turn (a plain Animation) must be absent.
  const n = await page.evaluate(
    () =>
      document
        .getAnimations()
        .filter(
          (a) =>
            !(a instanceof CSSTransition) &&
            ((a.effect as KeyframeEffect | null)?.target as HTMLElement | null)?.classList.contains(
              'tk-canvas',
            ),
        ).length,
  )
  expect(n).toBe(0)
})

// Dev tool: pauses the page-turn at fixed times and saves screenshots to e2e/.output/frames. Route motion frames
// are recorded by route-motion.spec.ts.
test('frames', async ({ admin, signedIn, viewport, browserName }) => {
  test.skip(!process.env.E2E_FRAMES || !desktop(viewport), 'set E2E_FRAMES=1 to record frames')
  const project = await seeded(admin)
  const page = await signedIn(adminCreds())
  await page.goto(`/projects/${project.id}`)
  await pictureOnly(page, new WorkspacePage(page))
  await page.keyboard.press('ArrowRight')
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .some(
        (a) =>
          !(a instanceof CSSTransition) &&
          ((a.effect as KeyframeEffect | null)?.target as HTMLElement | null)?.classList.contains(
            'tk-canvas',
          ),
      ),
  )
  for (const t of [30, 60, 100, 150]) {
    await page.evaluate((ms) => {
      for (const a of document.getAnimations()) {
        a.pause()
        a.currentTime = ms
      }
    }, t)
    await page.screenshot({ path: `e2e/.output/frames/${browserName}-turn-${t}.png` })
  }
})
