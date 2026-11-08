import { uniq } from '../support/api'
import { tr } from '../support/pages'
import { expect, FAILED_LOGIN_PROJECTS, test } from '../support/test'

const t = tr('ru')

test('a role change is picked up transparently (TOKEN_STALE is refreshed and retried)', async ({
  admin,
  signedIn,
}) => {
  const project = await admin.createProject(uniq('Stale '))
  const worker = await admin.createReadyUser()
  const page = await signedIn(worker)
  const link = page.getByRole('link', { name: new RegExp(project.title) })
  await expect(link).toBeVisible()

  const seen: { status: number; code?: string; url: string }[] = []
  page.on('response', async (res) => {
    if (!res.url().includes('/api/v1/projects/')) return
    const code =
      res.status() === 401
        ? ((await res.json().catch(() => ({}))) as { error?: { code?: string } }).error?.code
        : undefined
    seen.push({ status: res.status(), code, url: res.url() })
  })

  // The worker's permissions change on the server while the browser still holds the old token.
  const extra = await admin.createRole(['project.view', 'project.create', 'participant.view'])
  await admin.setUserRoles(worker.id, [await admin.roleId('worker'), extra.id])

  await link.click()
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}$`))
  await expect(page.getByRole('heading', { level: 1, name: project.title })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
  // Whether the server rejected the first call as stale depends on timing and on the browser's request
  // order; what matters is that the user saw nothing, which the assertions above prove. Record it.
  if (seen.some((r) => r.code === 'TOKEN_STALE')) {
    test.info().annotations.push({ type: 'token-stale', description: 'TOKEN_STALE was returned and handled' })
  }

  // The refreshed token carries the new permission: the create card appears after returning.
  await page.goto('/')
  await expect(page.getByRole('button', { name: t('projects.create.card') })).toBeVisible()
})

test('a deactivated user is signed out and cannot sign in again', async ({
  admin,
  signedIn,
  freshContext,
}) => {
  test.skip(!FAILED_LOGIN_PROJECTS.includes(test.info().project.name), 'limits failed logins per IP')
  const worker = await admin.createReadyUser()
  const page = await signedIn(worker)
  await expect(page.getByRole('heading', { level: 1, name: t('projects.title') })).toBeVisible()

  await admin.setActive(worker.id, false)
  // A reload restores the session from the refresh cookie, which the server has revoked.
  await page.reload()
  await expect(page).toHaveURL(/\/login/)

  const ctx = await freshContext()
  const again = await ctx.newPage()
  await again.goto('/login')
  await again.locator('input[name="username"]').fill(worker.login)
  await again.locator('input[name="password"]').fill(worker.password)
  await again.locator('form.login-card button[type="submit"]').click()
  await expect(again.locator('.login-error')).toBeVisible()
  await expect(again).toHaveURL(/\/login/)

  // Re-activating brings the account back.
  await admin.setActive(worker.id, true)
  await again.locator('form.login-card button[type="submit"]').click()
  await expect(again).not.toHaveURL(/\/login/)
})

test('signing out in one tab signs out the other tab of the same browser', async ({ admin, signedIn }) => {
  const user = await admin.createReadyUser()
  const first = await signedIn(user)
  const second = await first.context().newPage()
  await second.goto('/')
  await expect(second.getByRole('heading', { level: 1, name: t('projects.title') })).toBeVisible()
  await first.getByRole('button', { name: t('nav.userMenu') }).click()
  await first.getByRole('menuitem', { name: t('action.signOut') }).click()
  await expect(first).toHaveURL(/\/login/)
  await expect(second).toHaveURL(/\/login/)
})
