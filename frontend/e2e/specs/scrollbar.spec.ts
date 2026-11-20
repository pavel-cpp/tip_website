import { adminCreds, uniq } from '../support/api'
import { expect, test } from '../support/test'
import { WorkspacePage } from '../support/workspace'

// The rows' scrollbar swells towards the pointer and can be dragged; Save sits before Copy in the toolbar.

// Headless Chromium hides scrollbars by default; the feature needs the classic ones.
test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } })

test.beforeEach(({ viewport }) => {
  test.skip(!viewport || viewport.width < 700, 'desktop pointer only')
})

test('the scrollbar thickens near the pointer and drags the list', async ({ admin, signedIn }) => {
  const project = await admin.createProject(uniq('Scroll '))
  await admin.uploadImage(project.id)
  await admin.addParticipants(
    project.id,
    Array.from({ length: 400 }, (_, i) => ({ name: `Person ${i + 1}`, phone: `+99890${1000000 + i}` })),
  )
  const page = await signedIn(adminCreds())
  const ws = new WorkspacePage(page)
  await ws.open(project.id)
  await expect(ws.rows.first()).toBeVisible()

  const thumb = page.locator('.psb-thumb')
  await expect(thumb).toBeVisible()
  const width = async () => (await thumb.boundingBox())?.width ?? 0
  const rest = await width()
  expect(rest).toBeGreaterThan(4)
  expect(rest).toBeLessThan(8)

  const t = await thumb.boundingBox()
  const area = await page.locator('.pt-scrollbox').boundingBox()
  if (!t || !area) throw new Error('no geometry')
  // Far from the bar: still thin. On it: wide.
  await page.mouse.move(area.x + area.width / 2, t.y + 10)
  await expect.poll(width).toBeLessThan(8)
  await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2)
  await expect.poll(width).toBeGreaterThan(13)

  // Dragging the thumb scrolls the rows.
  const grab = await thumb.boundingBox()
  if (!grab) throw new Error('no thumb')
  await page.mouse.down()
  await page.mouse.move(grab.x + grab.width / 2, grab.y + grab.height / 2 + 120, { steps: 6 })
  await page.mouse.up()
  expect(await page.locator('.pt-scroll').evaluate((el) => el.scrollTop)).toBeGreaterThan(200)

  // Leaving the area lets it thin out again.
  await page.mouse.move(area.x + 40, area.y + 40)
  await expect.poll(width).toBeLessThan(8)
})

test('Save comes before Copy in the toolbar', async ({ admin, signedIn }) => {
  const project = await admin.createProject(uniq('Order '))
  await admin.uploadImage(project.id)
  await admin.addParticipants(project.id, [{ name: 'Person', phone: '+998901000000' }])
  const page = await signedIn(adminCreds())
  const ws = new WorkspacePage(page)
  await ws.open(project.id)
  await expect(ws.rows.first()).toBeVisible()
  const save = await page.locator('.ws-savegroup').boundingBox()
  const copy = await page.locator('.ws-toolbar .btn-primary').first().boundingBox()
  if (!save || !copy) throw new Error('toolbar buttons are missing')
  expect(save.x).toBeLessThan(copy.x)
})
