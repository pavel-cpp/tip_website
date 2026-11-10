import type { Page } from '@playwright/test'
import { type Api, adminCreds, uniq } from '../support/api'
import { Topbar } from '../support/pages'
import { expect, test } from '../support/test'
import { WorkspacePage } from '../support/workspace'

// Motion polish: the page-turn between tickets and the route transitions. The suite runs with reduced
// motion by default, so these specs switch it back on. Frames are recorded with E2E_FRAMES=1 (see `frames`).

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
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
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

test('opening a project morphs its card into the workspace and back; settings is a sheet', async ({
  admin,
  signedIn,
  viewport,
  browserName,
}) => {
  test.skip(!desktop(viewport), 'desktop pointer layout')
  const project = await seeded(admin)
  const page = await signedIn(adminCreds())
  const supported = await page.evaluate(() => typeof document.startViewTransition === 'function')
  test.skip(!supported, `${browserName} has no View Transitions: the CSS fade-in applies`)
  const root = page.locator('html')

  await page.locator(`.project-card[data-flip-id="${project.id}"] a.project-card-link`).click()
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}$`))
  // The flags are set for the duration of the transition and removed afterwards.
  await expect(root).not.toHaveAttribute('data-morph', /.*/)
  await expect(page.locator('main.page')).toHaveAttribute('data-rank', '1')

  await page.getByRole('button', { name: ws(page, 'workspace.settings') }).click()
  await expect(page).toHaveURL(/\/settings$/)
  await expect(root).not.toHaveAttribute('data-sheet', /.*/)
  await page.getByRole('button', { name: ws(page, 'action.close') }).click()
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}$`))
  await page
    .getByRole('link', { name: ws(page, 'projects.title') })
    .first()
    .click()
  await expect(page.locator('main.page')).toHaveAttribute('data-rank', '0')
  await expect(root).not.toHaveAttribute('data-morph', /.*/)
  // Nothing keeps a transition name behind, or the next morph would be refused for duplicate names.
  await expect(page.locator('[data-hero]')).toHaveCount(0)
})

function ws(page: Page, key: Parameters<WorkspacePage['t']>[0]): string {
  return new WorkspacePage(page).t(key)
}

// Dev tool: pauses the running transition at fixed times and saves screenshots to e2e/.output/frames.
test('frames', async ({ admin, signedIn, viewport, browserName }) => {
  test.skip(!process.env.E2E_FRAMES || !desktop(viewport), 'set E2E_FRAMES=1 to record frames')
  const project = await seeded(admin)
  const page = await signedIn(adminCreds())
  const shot = async (name: string, kind: string, times: number[], act: () => Promise<unknown>) => {
    void act()
    await page.waitForFunction(
      (k) =>
        document.getAnimations().some((a) => (a.effect as KeyframeEffect | null)?.pseudoElement?.includes(k)),
      kind,
      { timeout: 3000 },
    )
    for (const t of times) {
      await page.evaluate((ms) => {
        for (const a of document.getAnimations()) {
          a.pause()
          a.currentTime = ms
        }
      }, t)
      await page.screenshot({ path: `e2e/.output/frames/${browserName}-${name}-${t}.png` })
    }
    await page.evaluate(() => {
      for (const a of document.getAnimations()) a.finish()
    })
    await page.waitForTimeout(300)
  }
  const card = page.locator(`.project-card[data-flip-id="${project.id}"] a.project-card-link`)
  await shot('open', 'view-transition', [40, 100, 160, 240, 320], () => card.click())
  await shot('sheet-open', 'view-transition', [40, 100, 160, 240, 320], () =>
    page.getByRole('button', { name: ws(page, 'workspace.settings') }).click(),
  )
  await shot('sheet-close', 'view-transition', [40, 100, 160, 240, 320], () =>
    page.getByRole('button', { name: ws(page, 'action.close') }).click(),
  )
  await shot('close', 'view-transition', [40, 100, 160, 240, 320], () =>
    page
      .getByRole('link', { name: ws(page, 'projects.title') })
      .first()
      .click(),
  )

  await shot('sibling', 'view-transition', [40, 100, 180, 260], () => new Topbar(page).goTo('adminUsers'))
  await page.goto('/')

  // Page-turn between tickets (picture-only mode).
  await card.click()
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}$`))
  await expect(page.locator('html')).not.toHaveAttribute('data-nav', /.*/)
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
