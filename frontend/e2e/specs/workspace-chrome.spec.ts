import { adminCreds, uniq } from '../support/api'
import { expect, test } from '../support/test'
import { WorkspacePage } from '../support/workspace'

// Stream C: toolbar hierarchy, top bar, follow mode, splitter, multi-ticket copy and save.

const people = Array.from({ length: 6 }, (_, i) => ({
  name: `Person ${i + 1}`,
  phone: `+99890111000${i}`,
}))

async function seeded(admin: import('../support/api').Api) {
  const project = await admin.createProject(uniq('Chrome '))
  await admin.uploadImage(project.id)
  const rows = await admin.addParticipants(project.id, people)
  return { project, rows }
}

const isPhone = (v: { width: number } | null | undefined) => (v?.width ?? 1024) < 700

test('toolbar: Copy is the only primary button, then Save, Import/Export and a quiet Print', async ({
  admin,
  signedIn,
  viewport,
}) => {
  test.skip(isPhone(viewport), 'phones have their own bar (workspace-phone.spec.ts)')
  const { project } = await seeded(admin)
  const page = await signedIn(adminCreds())
  const ws = new WorkspacePage(page)
  await ws.open(project.id)
  const toolbar = page.getByRole('toolbar', { name: ws.t('workspace.toolbar') })
  const names = await toolbar
    .getByRole('button')
    .evaluateAll((els) => els.map((e) => ({ n: e.getAttribute('aria-label') ?? '', cls: e.className })))
  const idx = (re: RegExp) => names.findIndex((b) => re.test(b.n))
  const copy = idx(/^Копировать/)
  const save = idx(/^Сохранить/)
  const imp = idx(/^Импорт/)
  const exp = idx(/^Экспорт/)
  const print = idx(/^Печать/)
  expect(copy).toBeGreaterThanOrEqual(0)
  expect([copy, save, imp, exp, print]).toEqual([...[copy, save, imp, exp, print]].sort((a, b) => a - b))
  expect(names.filter((b) => b.cls.includes('btn-primary'))).toHaveLength(1)
  expect(names[copy]?.cls).toContain('btn-primary')
  expect(names[print]?.cls).toContain('btn-ghost')
  expect(names[imp]?.cls).toContain('btn-ghost')
})

test('settings: gear button, path in the top bar and Close returns to the workspace', async ({
  admin,
  signedIn,
  viewport,
}) => {
  const { project } = await seeded(admin)
  const page = await signedIn(adminCreds())
  const ws = new WorkspacePage(page)
  await ws.open(project.id)
  const bar = page.locator('header.topbar')
  await expect(bar.getByText(project.title)).toBeVisible()
  // The path and the users live in the top bar, not in the page.
  await expect(page.locator('main .ws-head')).toHaveCount(0)

  if (isPhone(viewport)) {
    await page
      .getByRole('toolbar', { name: ws.t('workspace.toolbar') })
      .getByRole('button', { name: ws.t('workspace.more') })
      .tap()
    await page.getByRole('menuitem', { name: ws.t('workspace.settings') }).tap()
  } else {
    const gear = page.getByRole('button', { name: ws.t('workspace.settings') })
    await expect(gear.locator('svg')).toBeVisible()
    await gear.click()
  }
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/settings$`))
  const crumbs = bar.getByRole('navigation')
  await expect(crumbs.getByRole('link', { name: ws.t('projects.title') })).toBeVisible()
  await expect(crumbs.getByRole('link', { name: project.title })).toBeVisible()
  await expect(crumbs.getByText(ws.t('settings.title'))).toBeVisible()
  await page.getByRole('button', { name: ws.t('action.close') }).click()
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}$`))
})

test('online colleagues are in the top bar and a click follows their row', async ({
  admin,
  signedIn,
  viewport,
}) => {
  test.skip(isPhone(viewport), 'rows are cards on phones; follow mode is checked on the desktop layout')
  const { project, rows } = await seeded(admin)
  const peerUser = await admin.createReadyUser({ displayName: 'Aziza Peer' })
  const me = await signedIn(adminCreds())
  const peer = await signedIn(peerUser)
  const ws = new WorkspacePage(me)
  const peerWs = new WorkspacePage(peer)
  await ws.open(project.id)
  await peerWs.open(project.id)

  const avatar = me.locator('header.topbar').getByRole('button', {
    name: ws.t('realtime.follow.jump', { name: 'Aziza Peer' }),
  })
  await expect(avatar).toBeVisible()

  await peerWs.cell(peerWs.grid.locator(`[data-row-id="${rows[3]?.id}"]`), 'name').click()
  await avatar.click()
  const row = (i: number) => ws.grid.locator(`[data-row-id="${rows[i]?.id}"]`)
  await expect(row(3)).toHaveAttribute('data-current', 'true')
  await expect(me.getByTestId('follow-status')).toContainText('Aziza Peer')
  await expect(me.getByTestId('follow-status')).toContainText('4')

  // Editing shows the field.
  await peer.keyboard.press('Enter')
  await expect(me.getByTestId('follow-status')).toContainText(
    ws.t('realtime.follow.editingName', { name: 'Aziza Peer', number: 4 }),
  )
  await peer.keyboard.press('Escape')

  // Follow: the view keeps tracking the colleague.
  await me.getByRole('button', { name: ws.t('realtime.follow.start') }).click()
  await peerWs.cell(peerWs.grid.locator(`[data-row-id="${rows[5]?.id}"]`), 'name').click()
  await expect(row(5)).toHaveAttribute('data-current', 'true')

  // Escape stops following; the next move is not tracked.
  await me.keyboard.press('Escape')
  await expect(me.getByRole('button', { name: ws.t('realtime.follow.start') })).toBeVisible()
  await peerWs.cell(peerWs.grid.locator(`[data-row-id="${rows[1]?.id}"]`), 'name').click()
  await expect(row(5)).toHaveAttribute('data-current', 'true')

  // Manual navigation also ends it.
  await me.getByRole('button', { name: ws.t('realtime.follow.start') }).click()
  await expect(row(1)).toHaveAttribute('data-current', 'true')
  await ws.cell(row(2), 'number').click()
  await expect(me.getByRole('button', { name: ws.t('realtime.follow.start') })).toBeVisible()
})

test('splitter: drag, keyboard, double click, drag to the edge hides a panel, drag back restores', async ({
  admin,
  signedIn,
  viewport,
}) => {
  const { project } = await seeded(admin)
  const page = await signedIn(adminCreds())
  const ws = new WorkspacePage(page)
  await ws.open(project.id)

  if (isPhone(viewport)) {
    await expect(page.locator('.ws-split')).toHaveCount(0)
    await expect(page.getByRole('tab', { name: ws.t('workspace.panel.picture') })).toBeVisible()
    await expect(page.getByRole('button', { name: /Закрыть панель/ })).toHaveCount(0)
    return
  }
  // The handle itself is the only control: no arrow buttons on it.
  await expect(page.locator('.ws-split button')).toHaveCount(0)

  const picture = page.locator('.ws-slot[data-panel="picture"]')
  const split = page.getByRole('separator', { name: ws.t('workspace.split.label') })
  const width = async () => (await picture.boundingBox())?.width ?? 0
  const before = await width()

  const box = await split.boundingBox()
  if (!box) throw new Error('no splitter')
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x - 200, y, { steps: 8 })
  await page.mouse.up()
  const dragged = await width()
  expect(dragged).toBeLessThan(before - 100)

  // Remembered per user.
  await page.reload()
  await ws.showTable()
  expect(Math.abs((await width()) - dragged)).toBeLessThan(4)

  // Keyboard.
  await split.focus()
  const now = Number(await split.getAttribute('aria-valuenow'))
  await page.keyboard.press('ArrowRight')
  expect(Number(await split.getAttribute('aria-valuenow'))).toBeGreaterThan(now)

  // Double click resets.
  const b2 = await split.boundingBox()
  if (!b2) throw new Error('no splitter')
  await page.mouse.dblclick(b2.x + b2.width / 2, b2.y + b2.height / 2)
  await expect(split).toHaveAttribute('aria-valuenow', '50')

  // Drag the handle to the right edge: the table hides and the picture fills the space with who is on it.
  const b3 = await split.boundingBox()
  if (!b3) throw new Error('no splitter')
  const y3 = b3.y + b3.height / 2
  const grid = await page.locator('.ws-grid').boundingBox()
  if (!grid) throw new Error('no grid')
  await page.mouse.move(b3.x + b3.width / 2, y3)
  await page.mouse.down()
  await page.mouse.move(grid.x + grid.width - 2, y3, { steps: 10 })
  await page.mouse.up()
  await expect(page.locator('.ws-slot[data-panel="db"]')).toHaveAttribute('inert', '')
  await expect(split).toHaveAttribute('aria-valuenow', '100')
  const who = page.getByTestId('ticket-who')
  await expect(who).toContainText('Person 1')
  await page.getByRole('button', { name: ws.t('workspace.ticket.next') }).click()
  await expect(who).toContainText('Person 2')
  await page.keyboard.press('ArrowRight')
  await expect(who).toContainText('Person 3')
  await page.keyboard.press('ArrowLeft')
  await expect(who).toContainText('Person 2')

  // The same handle on the edge brings the table back (a click is enough), and the selection followed along.
  const b4 = await split.boundingBox()
  if (!b4) throw new Error('no splitter')
  await page.mouse.click(b4.x + b4.width / 2, b4.y + b4.height / 2)
  await expect(page.locator('.ws-slot[data-panel="db"]')).not.toHaveAttribute('inert', '')
  await expect(ws.rowByText('Person 2')).toHaveAttribute('data-current', 'true')

  // Dragging far to the left hides the picture; dragging back out restores it.
  const b5 = await split.boundingBox()
  if (!b5) throw new Error('no splitter')
  const y5 = b5.y + b5.height / 2
  await page.mouse.move(b5.x + b5.width / 2, y5)
  await page.mouse.down()
  await page.mouse.move(grid.x + 2, y5, { steps: 10 })
  await page.mouse.up()
  await expect(page.locator('.ws-slot[data-panel="picture"]')).toHaveAttribute('inert', '')
  const b6 = await split.boundingBox()
  if (!b6) throw new Error('no splitter')
  await page.mouse.move(b6.x + b6.width / 2, y5)
  await page.mouse.down()
  await page.mouse.move(grid.x + grid.width / 2, y5, { steps: 10 })
  await page.mouse.up()
  await expect(page.locator('.ws-slot[data-panel="picture"]')).not.toHaveAttribute('inert', '')
})

test('several tickets: the Save label shows the count and ZIP, and a ZIP is downloaded', async ({
  admin,
  signedIn,
  viewport,
}) => {
  test.skip(isPhone(viewport), 'selection is a separate mode on phones')
  const { project } = await seeded(admin)
  const page = await signedIn(adminCreds())
  const ws = new WorkspacePage(page)
  await ws.open(project.id)
  await ws.grid.getByRole('checkbox', { name: ws.t('workspace.selectVisible') }).check()
  const save = page.getByRole('button', { name: ws.t('workspace.save.many', { count: 6 }) })
  await expect(save).toBeVisible()
  await expect(save).toContainText('ZIP')
  const download = page.waitForEvent('download')
  await save.click()
  expect((await download).suggestedFilename()).toMatch(/\.zip$/)
})

test('copying several tickets reports the count and puts HTML with every image on the clipboard', async ({
  admin,
  signedIn,
  browserName,
  viewport,
}) => {
  test.skip(
    isPhone(viewport) || browserName !== 'chromium',
    'clipboard permissions are scriptable in Chromium only',
  )
  const { project } = await seeded(admin)
  const page = await signedIn(adminCreds())
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  const ws = new WorkspacePage(page)
  await ws.open(project.id)
  await ws.grid.getByRole('checkbox', { name: ws.t('workspace.selectVisible') }).check()
  await page.getByRole('button', { name: ws.t('workspace.copy.many', { count: 6 }) }).click()
  await expect(page.getByText(ws.t('workspace.toast.copiedMany', { count: 6 }))).toBeVisible({
    timeout: 30_000,
  })
  await expect(page.getByRole('button', { name: ws.t('workspace.copy.zip') })).toBeVisible()
  const out = await page.evaluate(async () => {
    const [item] = await navigator.clipboard.read()
    const html = await (await item?.getType('text/html'))?.text()
    const text = await (await item?.getType('text/plain'))?.text()
    return { images: (html?.match(/<img /g) ?? []).length, text }
  })
  expect(out.images).toBe(6)
  expect(out.text?.split('\n')).toHaveLength(6)
})

test('probe: what the browser does with several ClipboardItems in one write', async ({
  page,
  browserName,
}) => {
  test.skip(!['chromium', 'webkit'].includes(browserName))
  await page.goto('/login')
  // A real click gives the page the user activation the clipboard needs.
  await page.locator('body').click()
  const res = await page.evaluate(async () => {
    const png = () => {
      const c = document.createElement('canvas')
      c.width = c.height = 4
      return new Promise<Blob>((r) => c.toBlob((b) => r(b as Blob), 'image/png'))
    }
    try {
      await navigator.clipboard.write([
        new ClipboardItem({ 'image/png': await png() }),
        new ClipboardItem({ 'image/png': await png() }),
      ])
      return 'accepted'
    } catch (e) {
      return `${(e as Error).name}: ${(e as Error).message}`
    }
  })
  // Recorded for the report; the app does not depend on it (it always writes one HTML item).
  test.info().annotations.push({ type: 'multi-ClipboardItem', description: `${browserName}: ${res}` })
  console.log(`multi-ClipboardItem write in ${browserName}: ${res}`)
})
