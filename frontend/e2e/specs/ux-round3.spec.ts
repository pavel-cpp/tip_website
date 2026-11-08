import { adminCreds, uniq } from '../support/api'
import { tr } from '../support/pages'
import { expect, test } from '../support/test'

const t = tr('ru')

/** WCAG contrast of two opaque rgb() colours. */
function ratio(a: string, b: string): number {
  const lum = (rgb: string) => {
    const [r, g, bl] = (rgb.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number) as [number, number, number]
    const lin = (v: number) => {
      const c = v / 255
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    }
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(bl)
  }
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

for (const theme of ['dark', 'light'] as const) {
  test(`field, secondary button and card borders reach 3:1 in the ${theme} theme`, async ({
    admin,
    signedIn,
  }) => {
    const project = await admin.createProject(uniq('Contrast '))
    const page = await signedIn(adminCreds(), { theme })
    await page.goto('/')
    await expect(page.getByText(project.title)).toBeVisible()
    const measure = (selector: string) =>
      page.evaluate((sel) => {
        const el = document.querySelector(sel) as HTMLElement
        if (!el) throw new Error(`no element for ${sel}`)
        const cs = getComputedStyle(el)
        // The colour behind the outline: walk up to the first opaque background.
        let bg = ''
        for (let n: HTMLElement | null = el.parentElement; n; n = n.parentElement) {
          const c = getComputedStyle(n).backgroundColor
          if (c && !c.endsWith(', 0)') && c !== 'transparent') {
            bg = c
            break
          }
        }
        return { border: cs.borderTopColor, bg, h: el.getBoundingClientRect().height }
      }, selector)

    const field = await measure('.projects-search .input')
    expect(ratio(field.border, field.bg)).toBeGreaterThanOrEqual(3)
    // One control height token: 40px for a mouse, the 44px touch target on touch devices.
    const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches)
    expect(Math.round(field.h)).toBe(coarse ? 44 : 40)

    const card = await measure('.project-card')
    expect(ratio(card.border, card.bg)).toBeGreaterThanOrEqual(3)

    await page.goto('/profile')
    await page
      .getByRole('button', { name: t('profile.photoChange') })
      .first()
      .waitFor()
    const secondary = await measure('.btn:not(.btn-primary):not(.btn-ghost):not(.btn-icon)')
    expect(ratio(secondary.border, secondary.bg)).toBeGreaterThanOrEqual(3)
  })
}

test('audit log names the target, offers every user in the filter and hides "show more" on a short list', async ({
  admin,
  signedIn,
}) => {
  const quiet = await admin.createUser({ displayName: uniq('Quiet '), login: uniq('q') })
  const page = await signedIn(adminCreds())
  await page.goto('/admin/system')
  const sentence = page.getByText(new RegExp(`создал пользователя «${quiet.displayName}»`)).first()
  await expect(sentence).toBeVisible()
  await expect(page.locator('.audit-sentence').first()).not.toContainText('в проекте «')

  // The quiet user never acted, yet is in the filter.
  const filter = page.getByLabel(t('admin.audit.filterActor'))
  await expect(filter.locator(`option[value="${quiet.id}"]`)).toHaveCount(1)

  // The action filter is applied by the server, so a rare action leaves no "show more" behind.
  await page.getByLabel(t('admin.audit.filterAction')).selectOption('user.create')
  await expect(page.locator('.audit-sentence').first()).toContainText('создал пользователя')
  await expect(page.getByRole('button', { name: t('admin.audit.more') })).toHaveCount(
    (await admin.call<{ next: number | null }>('GET', '/admin/audit?action=user.create&limit=50')).next
      ? 1
      : 0,
  )
})

test('the system page tells admins when Grafana is not configured', async ({ signedIn }) => {
  const page = await signedIn(adminCreds())
  await page.goto('/admin/system')
  // The e2e stack runs without GRAFANA_URL.
  await expect(page.getByTestId('grafana-note')).toContainText('GRAFANA_URL')
})

test('on a phone only the selected field handle is drawn on the settings preview', async ({
  admin,
  signedIn,
}) => {
  const project = await admin.uploadImage((await admin.createProject(uniq('Chips '))).id)
  const page = await signedIn(adminCreds())
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/projects/${project.id}/settings`)
  await expect(page.locator('.ph-chip').first()).toBeAttached()
  await expect(page.locator('.ph-chip:visible')).toHaveCount(1)
  await page.getByRole('tab', { name: t('settings.ph.name') }).click()
  await expect(page.locator('.ph-chip:visible')).toHaveCount(1)
  await expect(page.locator('.ph-chip[aria-pressed="true"]:visible')).toHaveCount(1)
})

test('numbers in Uzbek use a space for grouping and a comma for decimals', async ({ admin, signedIn }) => {
  // The profile language wins over the device default, so the account itself must be Uzbek.
  const user = await admin.createReadyUser({ locale: 'uz', roleIds: [await admin.roleId('admin')] })
  const page = await signedIn(user, { locale: 'uz' })
  await page.goto('/admin/system')
  const disk = page.locator('.number', { hasText: /GB dan/ })
  await expect(disk).toBeVisible()
  await expect(disk).not.toContainText(/\d\.\d GB/)
  await expect(disk).toContainText(/\d,\d GB/)
})
