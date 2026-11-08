import type { Page } from '@playwright/test'
import { uniq } from '../support/api'
import { LoginPage, tr } from '../support/pages'
import { expect, test } from '../support/test'
import { WorkspacePage } from '../support/workspace'

// @realtime: two browsers as different users. The realtime client (stream F4) may not be merged yet,
// so every test first detects at runtime whether the SPA opens a WebSocket for a project, and skips
// otherwise. Run only these with: npx playwright test --grep @realtime

const t = tr('ru')

async function opensSocket(page: Page): Promise<boolean> {
  return page
    .waitForFunction(() => ((window as unknown as { __sockets?: number }).__sockets ?? 0) > 0, undefined, {
      timeout: 5_000,
    })
    .then(() => true)
    .catch(() => false)
}

async function watchSockets(page: Page): Promise<void> {
  await page.context().addInitScript(() => {
    const w = window as unknown as { __sockets: number }
    w.__sockets = 0
    const Native = window.WebSocket
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        w.__sockets += 1
      }
    }
  })
}

test.describe('@realtime workspace collaboration', () => {
  test('presence, lock, blocked edit and live propagation', async ({ admin, freshContext }) => {
    const project = await admin.createProject(uniq('RT '))
    await admin.uploadImage(project.id)
    const rows = await admin.addParticipants(project.id, [
      { name: 'Row One', phone: '+998901000001' },
      { name: 'Row Two', phone: '+998901000002' },
    ])
    const alice = await admin.createReadyUser({ displayName: 'Alice Editor' })
    const bob = await admin.createReadyUser({ displayName: 'Bob Reviewer' })

    const open = async (creds: { login: string; password: string }) => {
      const ctx = await freshContext()
      const page = await ctx.newPage()
      await watchSockets(page)
      await new LoginPage(page).signIn(creds)
      const ws = new WorkspacePage(page)
      await ws.open(project.id)
      return { page, ws }
    }
    const a = await open(alice)
    const available = await opensSocket(a.page)
    test.skip(!available, 'realtime client is not present in this build (stream F4 not merged)')
    const b = await open(bob)

    // Presence: each sees the other's avatar in the header.
    await expect(
      a.page.locator('.ws-head ul.rt-online').getByRole('img', { name: 'Bob Reviewer' }),
    ).toBeVisible()
    await expect(
      b.page.locator('.ws-head ul.rt-online').getByRole('img', { name: 'Alice Editor' }),
    ).toBeVisible()

    // Alice starts editing row one: Bob sees the lock outline and the tooltip on hover.
    const rowId = rows[0]?.id as string
    const aliceRow = a.ws.grid.locator(`[data-row-id="${rowId}"]`)
    await a.ws.cell(aliceRow, 'name').click()
    await a.page.keyboard.press('Enter')
    await expect(aliceRow.locator('input.pt-input')).toBeVisible()

    const bobRow = b.ws.grid.locator(`[data-row-id="${rowId}"]`)
    await expect(bobRow).toHaveAttribute('data-locked', 'true')
    const ring = await bobRow.evaluate(
      (el) => getComputedStyle(el.querySelector('.pt-lock-ring') as Element).borderTopColor,
    )
    expect(ring).not.toBe('rgba(0, 0, 0, 0)')
    await bobRow.hover()
    await expect(bobRow.locator('.pt-lock-tip')).toContainText(
      t('workspace.editing', { name: 'Alice Editor' }),
    )

    // Bob cannot edit the locked row.
    await b.ws.cell(bobRow, 'name').click()
    await b.page.keyboard.press('Enter')
    await expect(bobRow.locator('input.pt-input')).toHaveCount(0)

    // Alice commits: Bob's table updates live and the lock disappears.
    await aliceRow.locator('input.pt-input').fill('Row One Changed')
    await a.page.keyboard.press('Enter')
    await expect(b.ws.rowByText('Row One Changed')).toHaveCount(1)
    await expect(bobRow).not.toHaveAttribute('data-locked', 'true')

    // Rows added by Bob appear for Alice without a reload.
    await b.ws.addRows(1)
    await expect(a.ws.rows).toHaveCount(3)
  })

  test('a role change and a deactivation reach an open session', async ({ admin, freshContext }) => {
    const project = await admin.createProject(uniq('RT2 '))
    await admin.addParticipants(project.id, [{ name: 'Row One', phone: '+998901000001' }])
    const worker = await admin.createReadyUser()
    const ctx = await freshContext()
    const page = await ctx.newPage()
    await watchSockets(page)
    await new LoginPage(page).signIn(worker)
    const ws = new WorkspacePage(page)
    await ws.open(project.id)
    test.skip(
      !(await opensSocket(page)),
      'realtime client is not present in this build (stream F4 not merged)',
    )

    // TOKEN_STALE after a role change is handled without any visible error.
    const extra = await admin.createRole(['project.view', 'participant.view', 'participant.edit'])
    await admin.setUserRoles(worker.id, [await admin.roleId('worker'), extra.id])
    await ws.editCell(ws.rowByText('Row One'), 'name', 'After Role Change')
    await expect(ws.rowByText('After Role Change')).toHaveCount(1)
    await expect(page.getByRole('alert')).toHaveCount(0)

    // Deactivating the user closes the session without a reload.
    await admin.setActive(worker.id, false)
    await expect(page).toHaveURL(/\/login/, { timeout: 20_000 })
  })
})
