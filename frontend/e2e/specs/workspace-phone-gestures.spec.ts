import type { Page } from '@playwright/test'
import { type Api, adminCreds, uniq } from '../support/api'
import { expect, test } from '../support/test'
import { WorkspacePage } from '../support/workspace'

// Phone workspace: swipe to turn the ticket, select-then-edit, no keyboard on open, native long-press image,
// image files instead of a ZIP, and a Print button that prints inside the tap. Runs on the `iphone-15` project.

const people = [
  { name: 'Alisher Karimov', phone: '+998901112233' },
  { name: 'Bobur Rahimov', phone: '+998902223344' },
  { name: 'Dilnoza Yusupova', phone: '+998903334455' },
]

async function seeded(admin: Api) {
  const project = await admin.createProject(uniq('Gest '))
  await admin.uploadImage(project.id)
  await admin.addParticipants(project.id, people)
  return project
}

/** A finger drag along the picture as touch pointer events (the engines do not all offer a swipe in emulation). */
async function swipe(page: Page, dx: number) {
  await page.evaluate((dist) => {
    const el = document.querySelector('.tk-viewport') as HTMLElement
    const r = el.getBoundingClientRect()
    const x0 = r.left + r.width / 2 - dist / 2
    const y = r.top + r.height / 2
    const fire = (type: string, x: number) =>
      el.dispatchEvent(
        new PointerEvent(type, {
          pointerType: 'touch',
          isPrimary: true,
          pointerId: 7,
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
        }),
      )
    fire('pointerdown', x0)
    for (let i = 1; i <= 6; i++) fire('pointermove', x0 + (dist * i) / 6)
    fire('pointerup', x0 + dist)
  }, dx)
}

test.describe('phone gestures', () => {
  test.beforeEach(({ viewport }) => {
    test.skip(!viewport || viewport.width >= 700, 'phone layout: runs on the iphone-15 project only')
  })

  test('the first tap selects a card, the second opens the editor without raising the keyboard', async ({
    admin,
    signedIn,
  }) => {
    const project = await seeded(admin)
    const page = await signedIn(adminCreds())
    const ws = new WorkspacePage(page)
    await ws.open(project.id)
    const card = ws.rowByText('Bobur')
    await card.locator('.pc-main').tap()
    await expect(ws.sheet).toHaveCount(0)
    await expect(card).toHaveAttribute('data-current', 'true')
    await card.locator('.pc-main').tap()
    await expect(ws.sheet).toBeVisible()
    // The dialog holds the focus; no field is focused, so the on-screen keyboard stays down.
    await expect.poll(() => page.evaluate(() => document.activeElement?.className ?? '')).toMatch(/\bsheet\b/)
    expect(await page.evaluate(() => document.activeElement?.matches('input, textarea'))).toBe(false)
    // A tap on a field still edits it.
    await ws.sheet.getByLabel(ws.t('workspace.col.phone')).tap()
    expect(await page.evaluate(() => document.activeElement?.matches('input'))).toBe(true)
  })

  test('swiping the picture turns to the next and previous ticket, and stops at the ends', async ({
    admin,
    signedIn,
  }) => {
    const project = await seeded(admin)
    const page = await signedIn(adminCreds())
    const ws = new WorkspacePage(page)
    await ws.open(project.id)
    await ws.rowByText('Alisher').locator('.pc-main').tap()
    await ws.showPicture()
    const who = page.getByTestId('ticket-who')
    await expect(who).toContainText(ws.t('workspace.ticket.who', { number: 1 }))
    await expect(page.locator('.tk-viewport')).toHaveAttribute('data-swipe', 'true')

    await swipe(page, 40) // a short slow drag towards "previous" at the first ticket: nothing to turn to
    await expect(who).toContainText(ws.t('workspace.ticket.who', { number: 1 }))
    await swipe(page, -170)
    await expect(who).toContainText(ws.t('workspace.ticket.who', { number: 2 }))
    await swipe(page, -170)
    await expect(who).toContainText(ws.t('workspace.ticket.who', { number: 3 }))
    await swipe(page, -170) // the last one has no neighbour
    await expect(who).toContainText(ws.t('workspace.ticket.who', { number: 3 }))
    await swipe(page, 170)
    await expect(who).toContainText(ws.t('workspace.ticket.who', { number: 2 }))
    // The ticket canvas is back in its slot once the turn is over (no inline shift left behind).
    await expect
      .poll(() =>
        page.evaluate(() =>
          [...document.querySelectorAll<HTMLElement>('.tk-canvas')].every((c) => !c.style.transform),
        ),
      )
      .toBe(true)
  })

  test('the settled ticket is a real image for the native long-press menu, and text around it is not selectable', async ({
    admin,
    signedIn,
  }) => {
    const project = await seeded(admin)
    const page = await signedIn(adminCreds())
    const ws = new WorkspacePage(page)
    await ws.open(project.id)
    await ws.rowByText('Alisher').locator('.pc-main').tap()
    await ws.showPicture()
    const img = page.locator('.tk-native')
    await expect(img).toBeVisible({ timeout: 8000 })
    expect(await img.evaluate((el: HTMLImageElement) => el.naturalWidth > 0 && !el.draggable)).toBe(true)
    const noSelect = await page.locator('.tk').first().evaluate((el) => {
      const cs = getComputedStyle(el) as CSSStyleDeclaration & { webkitUserSelect?: string }
      return (cs.userSelect || cs.webkitUserSelect) === 'none'
    })
    expect(noSelect).toBe(true)
  })

  test('saving several tickets offers image files to the share sheet, never a ZIP', async ({
    admin,
    signedIn,
  }) => {
    const project = await seeded(admin)
    const page = await signedIn(adminCreds())
    await page.addInitScript(() => {
      const w = window as unknown as { __shared: string[][] }
      w.__shared = []
      Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true })
      Object.defineProperty(navigator, 'share', {
        value: async (data: { files: File[] }) => {
          w.__shared.push(data.files.map((f) => `${f.name}|${f.type}`))
        },
        configurable: true,
      })
    })
    const ws = new WorkspacePage(page)
    await ws.open(project.id)
    await ws.longPress(ws.rowByText('Alisher'))
    await ws.rowByText('Bobur').locator('.pc-main').tap()
    await ws.bulkBar.getByRole('button', { name: ws.t('workspace.bulk.saveMany', { count: 2 }) }).tap()
    const again = page.getByRole('button', { name: ws.t('workspace.share.save'), exact: true })
    await expect
      .poll(async () => {
        // Either the sheet opened inside the tap, or the files are ready and one more tap opens it.
        if (await again.isVisible()) await again.tap()
        return page.evaluate(() => (window as unknown as { __shared: string[][] }).__shared.length)
      })
      .toBe(1)
    const shared = await page.evaluate(() => (window as unknown as { __shared: string[][] }).__shared[0])
    expect(shared).toHaveLength(2)
    for (const f of shared ?? []) expect(f).toMatch(/\.png\|image\/png$/)
  })

  test('the Print button opens the dialog itself (no extra message to press)', async ({
    admin,
    signedIn,
  }) => {
    const project = await seeded(admin)
    const page = await signedIn(adminCreds())
    await page.addInitScript(() => {
      const w = window as unknown as { __prints: number }
      w.__prints = 0
      window.print = () => {
        w.__prints += 1
      }
    })
    const ws = new WorkspacePage(page)
    await ws.open(project.id)
    await ws.rowByText('Alisher').locator('.pc-main').tap()
    // The sheet of the ticket on screen is made ahead of the tap.
    await expect(page.locator('.print-ticket')).toHaveCount(1, { timeout: 10_000 })
    await page.getByRole('button', { name: ws.t('workspace.more') }).tap()
    await page.getByRole('menuitem', { name: /^(Печать|Chop etish)/ }).tap()
    expect(await page.evaluate(() => (window as unknown as { __prints: number }).__prints)).toBe(1)
    await expect(page.getByRole('button', { name: ws.t('workspace.print.button'), exact: true })).toHaveCount(
      0,
    )
  })
})
