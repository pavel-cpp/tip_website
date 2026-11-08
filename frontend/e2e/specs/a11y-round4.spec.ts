import type { Page } from '@playwright/test'
import { type Api, adminCreds, uniq } from '../support/api'
import { htmlLang, tr } from '../support/pages'
import { expect, test } from '../support/test'
import { WorkspacePage } from '../support/workspace'

// Round 4 accessibility regressions: skip link, page titles, keyboard flow, contrast of outlines and
// focus rings, reflow at 320 px, target sizes and the first-run empty states.
const COARSE = ['iphone-15', 'ipad']

async function seeded(admin: Api, rows = 4) {
  const project = await admin.createProject(uniq('A11y '))
  await admin.uploadImage(project.id)
  await admin.addParticipants(
    project.id,
    Array.from({ length: rows }, (_, i) => ({ name: `Guest ${i + 1}`, phone: `+99890111${2000 + i}` })),
  )
  return project
}

/** WCAG contrast of two "rgb(r, g, b)" strings (alpha already blended by the caller). */
const CONTRAST = `(a, b) => {
  const lum = (c) => {
    const v = c.map((x) => { const s = x / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 })
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]
  }
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}`

/** Contrast of every outlined control border and of the keyboard focus ring against what they sit on. */
async function outlineContrast(page: Page): Promise<{ worst: number; where: string }> {
  return page.evaluate(`(() => {
    const contrast = ${CONTRAST}
    const parse = (s) => (s.match(/[\\d.]+/g) || []).map(Number)
    const effectiveBg = (el) => {
      let layers = []
      for (let e = el; e; e = e.parentElement) {
        const c = parse(getComputedStyle(e).backgroundColor)
        if (c.length >= 3 && (c[3] === undefined || c[3] > 0)) layers.push(c)
        if (c.length >= 3 && (c[3] === undefined || c[3] === 1)) break
      }
      let base = [19, 20, 24]
      for (const l of layers.reverse()) {
        const a = l[3] === undefined ? 1 : l[3]
        base = base.map((v, i) => Math.round(l[i] * a + v * (1 - a)))
      }
      return base
    }
    let worst = 99
    let where = ''
    const sel = '.input, .btn:not(.btn-primary):not(.btn-ghost):not(.btn-danger):not(.btn-icon), select, .segmented'
    for (const el of document.querySelectorAll(sel)) {
      const cs = getComputedStyle(el)
      if (parseFloat(cs.borderTopWidth) < 1 || cs.visibility === 'hidden' || !el.getBoundingClientRect().width) continue
      const border = parse(cs.borderTopColor)
      if (border.length < 3 || border[3] === 0) continue
      const parentBg = effectiveBg(el.parentElement)
      const a = border[3] === undefined ? 1 : border[3]
      const blended = parentBg.map((v, i) => Math.round(border[i] * a + v * (1 - a)))
      const r = contrast(blended, parentBg)
      if (r < worst) { worst = r; where = el.className + ' ' + (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 20) }
    }
    return { worst, where }
  })()`) as Promise<{ worst: number; where: string }>
}

for (const theme of ['dark', 'light'] as const) {
  test(`outlined controls reach 3:1 against their surface (${theme})`, async ({ admin, signedIn }) => {
    const project = await seeded(admin)
    const page = await signedIn(adminCreds(), { theme })
    await page.goto(`/projects/${project.id}`)
    const ws = new WorkspacePage(page)
    await ws.showTable()
    await ws.rows.first().waitFor()
    const r = await outlineContrast(page)
    expect(r.worst, r.where).toBeGreaterThanOrEqual(3)
    await page.goto('/profile')
    await page.locator('.profile').waitFor()
    const p = await outlineContrast(page)
    expect(p.worst, p.where).toBeGreaterThanOrEqual(3)
  })
}

test('focus ring of buttons has at least 3:1 against the page', async ({ signedIn }) => {
  const page = await signedIn(adminCreds())
  await page.goto('/profile')
  await page.locator('.profile').waitFor()
  const ring = await page.evaluate(`(() => {
    const contrast = ${CONTRAST}
    const parse = (s) => (s.match(/[\\d.]+/g) || []).map(Number)
    const btn = document.querySelector('header.topbar button')
    btn.focus({ focusVisible: true })
    const cs = getComputedStyle(btn)
    const bg = parse(getComputedStyle(btn.closest('header')).backgroundColor)
    return { width: parseFloat(cs.outlineWidth), ratio: contrast(parse(cs.outlineColor), bg) }
  })()`)
  expect((ring as { width: number }).width).toBeGreaterThanOrEqual(2)
  expect((ring as { ratio: number }).ratio).toBeGreaterThanOrEqual(3)
})

test('skip link is the first tab stop and moves focus to the main content', async ({ signedIn }) => {
  const page = await signedIn(adminCreds())
  await page.goto('/profile')
  await page.locator('.profile').waitFor()
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press('Tab')
  const skip = page.getByRole('link', { name: tr('ru')('a11y.skipToContent') })
  await expect(skip).toBeFocused()
  await expect(skip).toBeInViewport()
  await page.keyboard.press('Enter')
  await expect(page.locator('main#main')).toBeFocused()
})

test('the document title follows the page and the language', async ({ admin, signedIn }) => {
  const project = await seeded(admin)
  const page = await signedIn(adminCreds())
  await page.goto('/profile')
  await expect(page).toHaveTitle(`${tr('ru')('profile.title')} · TIP`)
  await page.goto(`/projects/${project.id}`)
  await expect(page).toHaveTitle(new RegExp(`^${project.title} · TIP$`))
  await page.goto('/profile')
  await page
    .getByRole('button', { name: tr('ru')('language.title') })
    .first()
    .click()
  await page.getByRole('menuitemradio', { name: tr('ru')('language.uz') }).click()
  await expect(page).toHaveTitle(`${tr('uz')('profile.title')} · TIP`)
  expect(await htmlLang(page)).toBe('uz')
})

test('Tab leaves the participants grid instead of walking through every cell', async ({
  admin,
  signedIn,
}, info) => {
  test.skip(COARSE.includes(info.project.name), 'the spreadsheet grid is a desktop layout')
  const project = await seeded(admin, 12)
  const page = await signedIn(adminCreds())
  await page.goto(`/projects/${project.id}`)
  const ws = new WorkspacePage(page)
  await ws.showTable()
  await ws.rows.first().waitFor()
  await ws.cell(ws.row(0), 'name').click()
  await page.keyboard.press('ArrowDown')
  // Two stops are enough to be past the grid (its own header checkbox is the only focusable descendant).
  await page.keyboard.press('Tab')
  await page.keyboard.press('Tab')
  const onGrid = await page.evaluate(() => document.activeElement?.getAttribute('role') === 'grid')
  expect(onGrid).toBe(false)
  const onCell = await page.evaluate(() => !!document.activeElement?.closest('[role=gridcell]'))
  expect(onCell).toBe(false)
})

test('the create dialog traps focus, closes with Escape and returns focus to its trigger', async ({
  signedIn,
}) => {
  const page = await signedIn(adminCreds())
  await page.goto('/')
  await page.locator('.projects-head').waitFor()
  const trigger = page.getByRole('button', { name: tr('ru')('projects.create.card') }).first()
  await trigger.focus()
  await page.keyboard.press('Enter')
  const dialog = page.getByRole('dialog')
  await dialog.waitFor()
  for (let i = 0; i < 6; i++) {
    expect(await page.evaluate(() => !!document.activeElement?.closest('[role=dialog]'))).toBe(true)
    await page.keyboard.press('Tab')
  }
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(trigger).toBeFocused()
})

test('screens reflow at 320 px without horizontal scrolling', async ({ admin, signedIn }, info) => {
  test.skip(info.project.name !== 'chromium-desktop', 'viewport is resized explicitly')
  const project = await seeded(admin)
  const page = await signedIn(adminCreds())
  await page.setViewportSize({ width: 320, height: 640 })
  const screens: Array<[string, string]> = [
    ['/', '.projects-head'],
    [`/projects/${project.id}/settings`, '.ph-chip'],
    ['/profile', '.profile'],
    ['/admin/users', '.admin-page'],
    ['/admin/roles', '.admin-page'],
    ['/admin/system', '.admin-page'],
  ]
  for (const [path, ready] of screens) {
    await page.goto(path)
    await page.locator(ready).first().waitFor()
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow, `${path} overflows by ${overflow}px`).toBeLessThanOrEqual(0)
  }
})

test('interactive targets are at least 24 px (44 px on touch screens)', async ({ admin, signedIn }, info) => {
  const project = await seeded(admin)
  const page = await signedIn(adminCreds())
  const min = COARSE.includes(info.project.name) ? 44 : 24
  const selectors = ['header.topbar a', 'header.topbar button', '.breadcrumb a']
  for (const path of ['/profile', `/projects/${project.id}/settings`]) {
    await page.goto(path)
    await page.locator('main h1').first().waitFor()
    const small = await page.evaluate(
      ([sels, limit]) => {
        const out: string[] = []
        for (const sel of sels as string[]) {
          for (const el of document.querySelectorAll<HTMLElement>(sel)) {
            const r = el.getBoundingClientRect()
            if (r.width && (r.width < (limit as number) || r.height < (limit as number))) {
              out.push(`${sel} ${Math.round(r.width)}x${Math.round(r.height)}`)
            }
          }
        }
        return out
      },
      [selectors, min],
    )
    expect(small, path).toEqual([])
  }
})

test('first run: the empty table offers the next step and printing waits for a picture', async ({
  admin,
  signedIn,
}, info) => {
  const t = tr('ru')
  const project = await admin.createProject(uniq('First run '))
  const page = await signedIn(adminCreds())
  const ws = new WorkspacePage(page)
  await ws.open(project.id)
  // No picture yet: the panel names the next step as a button-styled link to the settings.
  await expect(page.locator('.tk-empty .btn-primary')).toHaveText(t('workspace.ticket.openSettings'))
  // No rows yet: the table itself carries the "add rows" action.
  await page.locator('.pt-empty').waitFor()
  const add = page.locator('.pt-empty').getByRole('button', { name: t('workspace.addRows') })
  await expect(add).toBeVisible()
  await add.click()
  const dialog = page.getByRole('dialog', { name: t('workspace.add.title') })
  await dialog.getByLabel(t('workspace.add.count')).fill('2')
  await dialog.getByRole('button', { name: t('workspace.add.submit') }).click()
  await expect(ws.rows.first()).toBeVisible()
  // Rows exist but the project still has no picture: printing is unavailable and says why.
  if (info.project.name === 'iphone-15') return
  await expect(page.getByRole('button', { name: t('workspace.print') })).toHaveAttribute(
    'aria-disabled',
    'true',
  )
})
