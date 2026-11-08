import type { Page } from '@playwright/test'
import { type Api, adminCreds, uniq } from '../support/api'
import { expect, test } from '../support/test'
import { WorkspacePage } from '../support/workspace'

const MM = 96 / 25.4

async function openPrintPage(admin: Api, page: Page, count: number): Promise<WorkspacePage> {
  const project = await admin.createProject(uniq('Print '))
  await admin.uploadImage(project.id)
  const rows = Array.from({ length: count }, (_, i) => ({
    name: `Guest ${i + 1}`,
    phone: `+9989000${String(1000 + i)}`,
  }))
  await admin.addParticipants(project.id, rows)
  // The real print dialog cannot be driven; count the calls instead.
  await page.context().addInitScript(() => {
    const w = window as unknown as { __prints: number }
    w.__prints = 0
    window.print = () => {
      w.__prints += 1
    }
  })
  const ws = new WorkspacePage(page)
  await ws.open(project.id)
  await ws.grid.getByRole('checkbox', { name: ws.t('workspace.selectVisible') }).check()
  await ws.button('workspace.print').click()
  await expect(page).toHaveURL(/\/print$/)
  await expect(page.locator('.print-ticket')).toHaveCount(count, { timeout: 30_000 })
  return ws
}

test('print page splits 22 tickets into two A4 sheets of 21 and 1', async ({ admin, signedIn }) => {
  const page = await signedIn(adminCreds())
  const ws = await openPrintPage(admin, page, 22)
  const sheets = page.locator('.print-page')
  await expect(sheets).toHaveCount(2)
  await expect(page.getByText(ws.t('workspace.print.ready', { count: 22, pages: 2 }))).toBeVisible()
  await expect(sheets.first().locator('.print-ticket')).toHaveCount(21)
  await expect(sheets.nth(1).locator('.print-ticket')).toHaveCount(1)

  // The print button is the explicit path (iOS) and opens the dialog.
  await page.getByRole('button', { name: ws.t('workspace.print.button') }).click()
  await expect.poll(() => page.evaluate(() => (window as unknown as { __prints: number }).__prints)).toBeGreaterThan(0)
})

// BUG Q1-1: the print layout is injected as an inline <style> element (Print.tsx, printCss()), but the
// server sends `Content-Security-Policy: default-src 'self'; ...` without 'unsafe-inline' or a nonce for
// style-src. The browser blocks the style element, so on the real (embedded) server the sheet is not
// 210 mm wide, tickets keep their natural pixel size and flow in one column. Works under `vite preview`
// (no CSP header), which is why unit tests did not catch it.
test.fixme('print sheet is A4 with a 3 x 7 grid of 70 x 40 mm tickets', async ({ admin, signedIn }) => {
  const page = await signedIn(adminCreds())
  await openPrintPage(admin, page, 22)
  const geometry = await page.evaluate(() => {
    const box = (el: Element) => el.getBoundingClientRect()
    const sheet = document.querySelector('.print-page') as HTMLElement
    const tickets = [...sheet.querySelectorAll('.print-ticket')]
    const first = box(tickets[0] as Element)
    return {
      sheetW: box(sheet).width,
      sheetH: box(sheet).height,
      w: first.width,
      h: first.height,
      columns: getComputedStyle(sheet).gridTemplateColumns.split(' ').length,
      distinctLefts: new Set(tickets.map((t) => Math.round(box(t).left))).size,
      distinctTops: new Set(tickets.map((t) => Math.round(box(t).top))).size,
    }
  })
  expect(geometry.sheetW).toBeCloseTo(210 * MM, 0)
  expect(geometry.sheetH).toBeCloseTo(297 * MM, 0)
  expect(geometry.w).toBeCloseTo(70 * MM, 0)
  expect(geometry.h).toBeCloseTo(40 * MM, 0)
  expect(geometry.columns).toBe(3)
  expect(geometry.distinctLefts).toBe(3)
  expect(geometry.distinctTops).toBe(7)
})
