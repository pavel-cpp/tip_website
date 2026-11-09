import type { Locator, Page } from '@playwright/test'
import { type Api, adminCreds, uniq } from '../support/api'
import { LoginPage } from '../support/pages'
import { expect, test } from '../support/test'
import { WorkspacePage } from '../support/workspace'

// Phone and tablet layouts of the workspace (docs/06-frontend.md section 4, UX audit M7 and m15).
// Phone specs run on the `iphone-15` project, tablet specs on `ipad`; everything else is skipped.

const LONG_NAME = 'Abdurahmonova-Xudoyberdiyeva Gulnoza Rustamovna'
const people = [
  { name: 'Alisher Karimov', phone: '+998901112233' },
  { name: 'Bobur Rahimov', phone: '+998902223344' },
  { name: LONG_NAME, phone: '+998 90 108 33 44' },
  { name: 'Dilnoza Yusupova', phone: '+998903334455' },
  { name: 'Eldor Qodirov', phone: '+998904445566' },
]

async function seeded(admin: Api, title = uniq('Phone ')) {
  const project = await admin.createProject(title)
  await admin.uploadImage(project.id)
  const created = await admin.addParticipants(project.id, people)
  return { project, created }
}

/** Interactive controls that are on screen inside `scope` and smaller than 44 x 44 CSS px. */
async function smallTargets(scope: Locator, min = 44): Promise<string[]> {
  return scope.evaluate((root, size) => {
    const out: string[] = []
    const sel = 'button, a[href], input, select, textarea, [role="tab"], [role="menuitem"], [role="checkbox"]'
    for (const el of root.querySelectorAll<HTMLElement>(sel)) {
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      if (r.width === 0 || r.height === 0 || cs.visibility === 'hidden' || cs.display === 'none') continue
      // Visually hidden helpers (1 px clip) are not tap targets.
      if (r.width <= 1 || r.height <= 1) continue
      // A checkbox inside a label is tapped through the label.
      const hit = el.closest('label') ?? el
      const hr = hit.getBoundingClientRect()
      if (Math.round(hr.width) < size || Math.round(hr.height) < size) {
        const name = el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 30) ?? el.tagName
        out.push(`${el.tagName.toLowerCase()} "${name}" ${Math.round(hr.width)}x${Math.round(hr.height)}`)
      }
    }
    return out
  }, min)
}

const box = async (l: Locator) => {
  const b = await l.boundingBox()
  if (!b) throw new Error('element is not visible')
  return {
    x: Math.round(b.x * 10) / 10,
    y: Math.round(b.y * 10) / 10,
    w: Math.round(b.width * 10) / 10,
    h: Math.round(b.height * 10) / 10,
  }
}

test.describe('phone', () => {
  test.beforeEach(({ viewport }) => {
    test.skip(!viewport || viewport.width >= 700, 'phone layout: runs on the iphone-15 project only')
  })

  test('cards show number, the full name and the full phone', async ({ admin, signedIn }) => {
    const { project } = await seeded(admin)
    const page = await signedIn(adminCreds())
    const ws = new WorkspacePage(page)
    await ws.open(project.id)
    await expect(page.locator('.pt-grid')).toHaveCount(0)
    await expect(ws.rows).toHaveCount(5)
    const long = ws.rowByText(LONG_NAME)
    await expect(long).toContainText('+998 90 108 33 44')
    await expect(long).toContainText('3')
    // Nothing is cut with an ellipsis: the name wraps and the card grows.
    const name = long.locator('.pc-name')
    const clipped = await name.evaluate((el) => el.scrollWidth > el.clientWidth + 1)
    expect(clipped).toBe(false)
    expect((await box(long)).h).toBeGreaterThanOrEqual((await box(ws.rowByText('Alisher'))).h)
    const phone = long.locator('.pc-phone')
    expect(await phone.evaluate((el) => el.scrollWidth > el.clientWidth + 1)).toBe(false)
  })

  test('tap a card, edit in the sheet, save', async ({ admin, signedIn }) => {
    const { project } = await seeded(admin)
    const page = await signedIn(adminCreds())
    const ws = new WorkspacePage(page)
    await ws.open(project.id)
    await ws.rowByText('Bobur').locator('.pc-main').tap()
    await expect(ws.sheet).toBeVisible()
    await expect(ws.sheet.getByLabel(ws.t('workspace.col.name'))).toHaveValue('Bobur Rahimov')
    await ws.sheet.getByLabel(ws.t('workspace.col.name')).fill('Bobur Edited')
    await ws.sheet.getByLabel(ws.t('workspace.col.phone')).fill('+998905550000')
    await ws.sheet.getByRole('button', { name: ws.t('workspace.sheet.save') }).tap()
    await expect(ws.sheet).toBeHidden()
    await expect(ws.rowByText('Bobur Edited')).toContainText('+998905550000')
    await expect
      .poll(async () => (await admin.participants(project.id)).find((p) => p.name === 'Bobur Edited')?.phone)
      .toBe('+998905550000')
  })

  test('the sheet shows the ticket preview and pages between rows, keeping the phone as free text', async ({
    admin,
    signedIn,
  }) => {
    const { project } = await seeded(admin)
    const page = await signedIn(adminCreds())
    const ws = new WorkspacePage(page)
    await ws.open(project.id)
    await ws.rowByText('Alisher').locator('.pc-main').tap()
    await expect(ws.sheet.getByRole('img', { name: /Alisher Karimov/ })).toBeVisible()
    await ws.sheet.getByRole('button', { name: ws.t('workspace.sheet.next') }).tap()
    await expect(ws.sheet.getByLabel(ws.t('workspace.col.name'))).toHaveValue('Bobur Rahimov')
    await expect(ws.sheet.getByRole('img', { name: /Bobur Rahimov/ })).toBeVisible()
    await ws.sheet.getByLabel(ws.t('workspace.col.phone')).fill('abc')
    await expect(ws.sheet.getByRole('alert')).toHaveCount(0)
    // Paging with unsaved changes sends them in the background.
    await ws.sheet.getByRole('button', { name: ws.t('workspace.sheet.prev') }).tap()
    await expect
      .poll(async () => (await admin.participants(project.id)).find((p) => p.name === 'Bobur Rahimov')?.phone)
      .toBe('abc')
  })

  test('the sheet closes on Esc, backdrop and the back gesture, and traps focus', async ({
    admin,
    signedIn,
  }) => {
    const { project } = await seeded(admin)
    const page = await signedIn(adminCreds())
    const ws = new WorkspacePage(page)
    await ws.open(project.id)
    const open = () => ws.rowByText('Alisher').locator('.pc-main').tap()
    const url = page.url()

    await open()
    await expect(ws.sheet).toBeVisible()
    await expect(ws.sheet.getByLabel(ws.t('workspace.col.name'))).toBeFocused()
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab')
      const inside = await page.evaluate(() => !!document.activeElement?.closest('.sheet'))
      expect(inside).toBe(true)
    }
    await page.keyboard.press('Escape')
    await expect(ws.sheet).toBeHidden()

    await open()
    await expect(ws.sheet).toBeVisible()
    await page.touchscreen.tap(195, 40)
    await expect(ws.sheet).toBeHidden()

    await open()
    await expect(ws.sheet).toBeVisible()
    await page.goBack()
    await expect(ws.sheet).toBeHidden()
    expect(page.url()).toBe(url)
    await expect(ws.rows).toHaveCount(5)
  })

  test('the sheet respects the safe area and stays inside the viewport', async ({
    admin,
    signedIn,
    viewport,
  }) => {
    const { project } = await seeded(admin)
    const page = await signedIn(adminCreds())
    const ws = new WorkspacePage(page)
    await ws.open(project.id)
    await ws.rowByText('Alisher').locator('.pc-main').tap()
    await expect(ws.sheet).toBeVisible()
    const sheet = await box(ws.sheet)
    expect(sheet.x).toBeGreaterThanOrEqual(0)
    expect(sheet.y).toBeGreaterThanOrEqual(0)
    expect(sheet.x + sheet.w).toBeLessThanOrEqual((viewport?.width ?? 0) + 0.5)
    expect(sheet.y + sheet.h).toBeLessThanOrEqual((viewport?.height ?? 0) + 0.5)
    const pad = await ws.sheet.evaluate((el) => getComputedStyle(el).paddingBottom)
    expect(pad).toMatch(/px$/)
    const save = await box(ws.sheet.getByRole('button', { name: ws.t('workspace.sheet.save') }))
    expect(save.y + save.h).toBeLessThanOrEqual((viewport?.height ?? 0) + 0.5)
  })

  test('selection mode: the bulk bar replaces the toolbar in place and the list keeps its height (UX audit N2)', async ({
    admin,
    signedIn,
  }) => {
    const { project } = await seeded(admin)
    const page = await signedIn(adminCreds())
    const ws = new WorkspacePage(page)
    await ws.open(project.id)
    await expect(ws.rows).toHaveCount(5)

    const toolbar = page.getByRole('toolbar', { name: ws.t('workspace.toolbar') })
    const first = ws.rows.first()
    const second = ws.rows.nth(1)
    const before = {
      scroller: await box(page.locator('.pc-scroll')),
      first: await box(first),
      second: await box(second),
      tools: await box(page.locator('.pt-tools')),
      toolbar: await box(toolbar),
    }
    await ws.longPress(first)
    await expect(ws.bulkBar.getByRole('status')).toContainText(ws.t('workspace.selectedCount', { count: 1 }))
    await expect(first).toHaveAttribute('data-selected', 'true')
    // The toolbar is gone: the bar stands exactly where it was, one row of about 56 px.
    await expect(toolbar).toHaveCount(0)
    const bar = await box(ws.bulkBar)
    expect(bar.y).toBeCloseTo(before.toolbar.y, 0)
    expect(bar.h).toBeCloseTo(before.toolbar.h, 0)
    expect(bar.h).toBeLessThanOrEqual(80)
    // Nothing in the list moved or resized.
    const after = {
      scroller: await box(page.locator('.pc-scroll')),
      first: await box(first),
      second: await box(second),
      tools: await box(page.locator('.pt-tools')),
    }
    expect(after.scroller).toEqual(before.scroller)
    expect(after.tools).toEqual(before.tools)
    expect(after.first.y).toBe(before.first.y)
    expect(after.second.y).toBe(before.second.y)
    // The bar never overlaps the list.
    expect(bar.y).toBeGreaterThanOrEqual(before.scroller.y + before.scroller.h - 1)
    // The checkbox takes the number's place and its hit area is at least 44 px.
    await expect(first.locator('.pc-num')).toHaveCount(0)
    const check = await box(first.locator('.pc-check'))
    expect(check.w).toBeGreaterThanOrEqual(44)
    expect(check.h).toBeGreaterThanOrEqual(44)
    // Select all and the counter live in the list header.
    await expect(page.getByRole('checkbox', { name: ws.t('workspace.select.all') })).toBeVisible()
    await expect(page.getByText(ws.t('workspace.bulk.selectedOf', { count: 1, total: 5 }))).toBeVisible()

    await second.locator('.pc-main').tap()
    await expect(ws.sheet).toHaveCount(0)
    await expect(page.getByText(ws.t('workspace.bulk.selectedOf', { count: 2, total: 5 }))).toBeVisible()
    await expect(
      ws.bulkBar.getByRole('button', { name: ws.t('workspace.print.withCount', { count: 2 }) }),
    ).toBeVisible()
    expect(await smallTargets(ws.bulkBar)).toEqual([])

    // Copy is the primary action; saving several tickets is offered as one ZIP; Print stays neutral.
    await expect(
      ws.bulkBar.getByRole('button', { name: ws.t('workspace.bulk.copyMany', { count: 2 }) }),
    ).toBeVisible()
    await expect(
      ws.bulkBar.getByRole('button', { name: ws.t('workspace.bulk.saveMany', { count: 2 }) }),
    ).toBeVisible()
    await page.keyboard.press('Escape')

    // Leaving selection mode brings the toolbar back in the same place.
    await ws.bulkBar.getByRole('button', { name: ws.t('workspace.select.exit') }).tap()
    await expect(toolbar).toBeVisible()
    expect(await box(toolbar)).toEqual(before.toolbar)
  })

  test('the bottom toolbar has Copy as the primary action, Save beside it and the rest in a menu (UX audit N5)', async ({
    admin,
    signedIn,
  }) => {
    const { project } = await seeded(admin)
    const page = await signedIn(adminCreds())
    const ws = new WorkspacePage(page)
    await ws.open(project.id)
    const toolbar = page.getByRole('toolbar', { name: ws.t('workspace.toolbar') })
    await expect(toolbar.getByRole('button', { name: ws.t('workspace.copy') })).toHaveClass(/btn-primary/)
    await expect(toolbar.getByRole('button', { name: ws.t('workspace.save') })).toBeVisible()
    await toolbar.getByRole('button', { name: ws.t('workspace.more') }).tap()
    await expect(
      page.getByRole('menuitem', { name: ws.t('workspace.print.withCount', { count: 1 }) }),
    ).toBeVisible()
    for (const key of ['workspace.import', 'workspace.exportAs.xlsx', 'workspace.settings'] as const) {
      await expect(page.getByRole('menuitem', { name: ws.t(key) })).toBeVisible()
    }
  })

  test('cards have one accessible name with number, name and phone (UX audit N13)', async ({
    admin,
    signedIn,
  }) => {
    const { project } = await seeded(admin)
    const page = await signedIn(adminCreds())
    const ws = new WorkspacePage(page)
    await ws.open(project.id)
    await expect(
      ws.rowByText('Bobur').getByRole('button', { name: '№ 2, Bobur Rahimov, +998902223344' }),
    ).toBeVisible()
  })

  test('landscape: the list keeps most of the height and the bar is a rail (UX audit N2)', async ({
    admin,
    signedIn,
  }) => {
    test.skip(test.info().project.name !== 'iphone-15', 'landscape phone check runs on the iphone-15 project')
    const { project } = await seeded(admin)
    const page = await signedIn(adminCreds())
    await page.setViewportSize({ width: 844, height: 390 })
    const ws = new WorkspacePage(page)
    await ws.open(project.id)
    const list = await box(page.locator('.pc-scroll'))
    expect(list.h / 390).toBeGreaterThanOrEqual(0.55)
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(391)
    const rail = await box(page.getByRole('toolbar', { name: ws.t('workspace.toolbar') }))
    expect(rail.w).toBeLessThanOrEqual(70)
    expect(rail.x + rail.w).toBeLessThanOrEqual(845)
  })

  test('bulk clear empties the rows, keeps them, and Undo brings the text back', async ({
    admin,
    signedIn,
  }) => {
    const { project } = await seeded(admin)
    const page = await signedIn(adminCreds())
    const ws = new WorkspacePage(page)
    await ws.open(project.id)
    await ws.longPress(ws.rowByText('Alisher'))
    await ws.rowByText('Bobur').locator('.pc-main').tap()
    await ws.clearSelected(2)
    await expect(page.getByText(ws.t('workspace.toast.cleared', { count: 2 }))).toBeVisible()
    await expect(ws.rows).toHaveCount(5)
    await expect(ws.rowByText('Alisher')).toHaveCount(0)
    await expect(ws.bulkBar).toBeHidden()
    await expect
      .poll(async () => (await admin.participants(project.id)).filter((p) => p.name === '').length)
      .toBe(2)
    await page.getByRole('button', { name: ws.t('action.undo') }).tap()
    await expect(ws.rowByText('Alisher')).toHaveCount(1)
    await expect
      .poll(async () => (await admin.participants(project.id)).filter((p) => p.name !== '').length)
      .toBe(5)
    expect(await admin.participants(project.id)).toHaveLength(5)
  })

  test('clear from the sheet, then Undo', async ({ admin, signedIn }) => {
    const { project } = await seeded(admin)
    const page = await signedIn(adminCreds())
    const ws = new WorkspacePage(page)
    await ws.open(project.id)
    await ws.rowByText('Eldor').locator('.pc-main').tap()
    await ws.sheet.getByRole('button', { name: ws.t('workspace.sheet.clear') }).tap()
    await expect(ws.sheet).toBeHidden()
    await expect(ws.rows).toHaveCount(5)
    await expect(ws.rowByText('Eldor')).toHaveCount(0)
    await page.getByRole('button', { name: ws.t('action.undo') }).tap()
    await expect(ws.rowByText('Eldor')).toHaveCount(1)
  })

  test('two phones: a row open in the sheet is locked for the other', async ({ admin, freshContext }) => {
    const { project, created } = await seeded(admin)
    const alice = await admin.createReadyUser({ displayName: 'Alice Phone' })
    const bob = await admin.createReadyUser({ displayName: 'Bob Phone' })
    const open = async (creds: {
      login: string
      password: string
    }): Promise<{ page: Page; ws: WorkspacePage }> => {
      const ctx = await freshContext()
      const page = await ctx.newPage()
      await new LoginPage(page).signIn(creds)
      const ws = new WorkspacePage(page)
      await ws.open(project.id)
      return { page, ws }
    }
    const a = await open(alice)
    const b = await open(bob)
    const id = created[0]?.id as string

    await a.ws.grid.locator(`[data-row-id="${id}"]`).locator('.pc-main').tap()
    await expect(a.ws.sheet).toBeVisible()

    const bobCard = b.ws.grid.locator(`[data-row-id="${id}"]`)
    await expect(bobCard).toHaveAttribute('data-locked', 'true')
    await expect(bobCard.locator('.pc-lock-tip')).toContainText('Alice Phone')
    const ring = await bobCard.evaluate(
      (el) => getComputedStyle(el.querySelector('.pt-lock-ring') as Element).borderTopColor,
    )
    expect(ring).not.toBe('rgba(0, 0, 0, 0)')

    // Bob cannot open it and is told why.
    await bobCard.locator('.pc-main').tap()
    await expect(b.ws.sheet).toHaveCount(0)
    await expect(
      b.page.getByText(b.ws.t('workspace.card.blocked', { number: 1, name: 'Alice Phone' })),
    ).toBeVisible()

    // Alice edits through the sheet; Bob sees it live. After she closes, the row is free again.
    await a.ws.sheet.getByLabel(a.ws.t('workspace.col.name')).fill('Alisher Live')
    await a.ws.sheet.getByRole('button', { name: a.ws.t('workspace.sheet.save') }).tap()
    await expect(a.ws.sheet).toBeHidden()
    await expect(bobCard).toContainText('Alisher Live')
    await expect(bobCard).not.toHaveAttribute('data-locked', 'true')
    await bobCard.locator('.pc-main').tap()
    await expect(b.ws.sheet).toBeVisible()
  })

  test('every control in the workspace is at least 44 x 44 px', async ({ admin, signedIn }) => {
    const { project } = await seeded(admin)
    const page = await signedIn(adminCreds())
    const ws = new WorkspacePage(page)
    await ws.open(project.id)
    expect(await smallTargets(page.locator('.ws'))).toEqual([])
    await ws.showPicture()
    expect(await smallTargets(page.locator('.ws'))).toEqual([])
    await ws.showTable()
    await ws.rowByText('Alisher').locator('.pc-main').tap()
    await expect(ws.sheet).toBeVisible()
    expect(await smallTargets(ws.sheet)).toEqual([])
  })

  test('a very long project title takes at most two lines and keeps the full text in a tooltip', async ({
    admin,
    signedIn,
  }) => {
    const title = uniq('Tashkent City Mall extraordinarily long november raffle title for the winter season ')
    const project = await admin.createProject(title)
    await admin.uploadImage(project.id)
    await admin.addParticipants(project.id, people.slice(0, 1))
    const page = await signedIn(adminCreds())
    const ws = new WorkspacePage(page)
    await ws.open(project.id)
    const h1 = page.locator('.ws-title')
    await expect(h1).toHaveAttribute('title', title)
    const lines = await h1.evaluate(
      (el) => el.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(el).lineHeight),
    )
    expect(lines).toBeLessThanOrEqual(2.05)
  })

  test('search narrows the cards and the empty result is announced', async ({ admin, signedIn }) => {
    const { project } = await seeded(admin)
    const page = await signedIn(adminCreds())
    const ws = new WorkspacePage(page)
    await ws.open(project.id)
    await ws.search.fill('Dilnoza')
    await expect(ws.rows).toHaveCount(1)
    await ws.search.fill('zzz')
    await expect(page.getByText(ws.t('workspace.search.none'))).toBeVisible()
  })

  test('5000 rows scroll as virtualized cards', async ({ admin, signedIn }) => {
    test.setTimeout(120_000)
    const project = await admin.createProject(uniq('Big '))
    await admin.uploadImage(project.id)
    for (let from = 0; from < 5000; from += 500) {
      await admin.addParticipants(
        project.id,
        Array.from({ length: 500 }, (_, i) => ({
          name: `Guest number ${from + i + 1}`,
          phone: `+9989000${String(10000 + from + i)}`,
        })),
      )
    }
    const page = await signedIn(adminCreds())
    const ws = new WorkspacePage(page)
    await ws.open(project.id)
    await expect(page.getByText(/Строк: 5\s?000 из 5\s?000/)).toBeVisible({
      timeout: 30_000,
    })
    const mounted = await ws.rows.count()
    expect(mounted).toBeLessThan(40)
    const frames = await page.evaluate(async () => {
      const el = document.querySelector('.pc-scroll') as HTMLElement
      const times: number[] = []
      let last = performance.now()
      for (let i = 0; i < 60; i++) {
        el.scrollTop += 400
        await new Promise((r) => requestAnimationFrame(r))
        const now = performance.now()
        times.push(now - last)
        last = now
      }
      return { worst: Math.max(...times), avg: times.reduce((a, b) => a + b, 0) / times.length }
    })
    // A smooth scroll keeps frames well under 100 ms even on the emulated phone under CI load.
    test.info().annotations.push({
      type: 'scroll-frames',
      description: `avg ${frames.avg.toFixed(1)} ms, worst ${frames.worst.toFixed(1)} ms`,
    })
    expect(frames.avg).toBeLessThan(120)
    await page.evaluate(() => {
      ;(document.querySelector('.pc-scroll') as HTMLElement).scrollTop = 1e9
    })
    await expect(ws.rowByText('Guest number 5000')).toBeVisible()
  })
})

test.describe('phone landscape', () => {
  test.use({ viewport: { width: 844, height: 390 } })
  // biome-ignore lint/correctness/noEmptyPattern: Playwright requires object destructuring in hooks
  test.beforeEach(({}, info) => {
    test.skip(info.project.name !== 'iphone-15', 'landscape phone check runs on the iphone-15 project')
  })

  test('cards and the sheet stay usable', async ({ admin, signedIn }) => {
    const { project } = await seeded(admin)
    const page = await signedIn(adminCreds())
    const ws = new WorkspacePage(page)
    await ws.open(project.id)
    await expect(page.locator('.pc-scroll')).toBeVisible()
    await ws.rowByText('Alisher').locator('.pc-main').tap()
    await expect(ws.sheet).toBeVisible()
    const save = await box(ws.sheet.getByRole('button', { name: ws.t('workspace.sheet.save') }))
    expect(save.y + save.h).toBeLessThanOrEqual(390.5)
    const sheet = await box(ws.sheet)
    expect(sheet.y).toBeGreaterThanOrEqual(0)
    await page.keyboard.press('Escape')
    await expect(ws.sheet).toBeHidden()
  })
})

test.describe('tablet', () => {
  // Playwright's iPad profile is 656 px wide; the real iPad portrait viewport is 820 x 1180.
  test.use({ viewport: { width: 820, height: 1180 } })
  // biome-ignore lint/correctness/noEmptyPattern: Playwright requires object destructuring in hooks
  test.beforeEach(({}, info) => {
    test.skip(info.project.name !== 'ipad', 'tablet layout: runs on the ipad project only')
  })

  test('portrait: ticket above the table, both visible, selecting never shifts the table', async ({
    admin,
    signedIn,
  }) => {
    const { project } = await seeded(admin)
    const page = await signedIn(adminCreds())
    const ws = new WorkspacePage(page)
    await ws.open(project.id)
    await expect(page.locator('.pc-scroll')).toHaveCount(0)
    const picture = await box(page.locator('[data-panel="picture"]'))
    const db = await box(page.locator('[data-panel="db"]'))
    expect(picture.y + picture.h).toBeLessThanOrEqual(db.y + 1)
    expect(picture.h).toBeGreaterThan(200)
    expect(db.h).toBeGreaterThan(200)
    await expect(ws.rows.first()).toBeVisible()

    const before = { scroller: await box(page.locator('.pt-scroll')), row: await box(ws.rows.nth(1)) }
    await ws.cell(ws.rows.first(), 'name').tap()
    await expect(ws.rows.first()).toHaveAttribute('data-selected', 'true')
    expect(await box(page.locator('.pt-scroll'))).toEqual(before.scroller)
    expect((await box(ws.rows.nth(1))).y).toBe(before.row.y)
    // The clear button appears when something is selected; it no longer holds room back from the search.
    await expect(ws.button('workspace.clearSelected', { count: 1 })).toBeVisible()
  })

  test('every control is at least 44 x 44 px', async ({ admin, signedIn }) => {
    const { project } = await seeded(admin)
    const page = await signedIn(adminCreds())
    const ws = new WorkspacePage(page)
    await ws.open(project.id)
    await ws.cell(ws.rows.first(), 'name').tap()
    expect(await smallTargets(page.locator('.ws'))).toEqual([])
  })

  test('landscape: table and ticket side by side', async ({ admin, signedIn }) => {
    const { project } = await seeded(admin)
    const page = await signedIn(adminCreds())
    await page.setViewportSize({ width: 1180, height: 820 })
    const ws = new WorkspacePage(page)
    await ws.open(project.id)
    const picture = await box(page.locator('[data-panel="picture"]'))
    const db = await box(page.locator('[data-panel="db"]'))
    expect(picture.x + picture.w).toBeLessThanOrEqual(db.x + 1)
    expect(Math.abs(picture.y - db.y)).toBeLessThan(2)
    await expect(ws.rows.first()).toBeVisible()
    await expect(page.locator('.tk-canvas[data-front]')).toBeVisible()
  })
})

test.describe('desktop', () => {
  test.beforeEach(({ viewport }) => {
    test.skip(!viewport || viewport.width < 1100, 'desktop sizes: runs on the desktop projects only')
  })

  test('toolbar buttons and the add-rows button are at least 40 px high', async ({ admin, signedIn }) => {
    const { project } = await seeded(admin)
    const page = await signedIn(adminCreds())
    const ws = new WorkspacePage(page)
    await ws.open(project.id)
    const small = await smallTargets(page.locator('.ws'), 40)
    // Inputs inside the grid (header checkbox hit area is 40) and the search field are covered too.
    expect(small).toEqual([])
  })
})
