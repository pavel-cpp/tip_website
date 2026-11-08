import { type BrowserContext, test as base, expect, type Page } from '@playwright/test'
import { Api, baseUrl, type Creds } from './api'
import { LoginPage } from './pages'

export { expect }

interface Fixtures {
  /** Admin API session (fresh login per test, cheap). */
  admin: Api
  /** Opens a new isolated browser context signed in through the real login form. */
  signedIn: (creds: Creds, opts?: { locale?: 'ru' | 'uz'; theme?: 'dark' | 'light' }) => Promise<Page>
  /** A new isolated context with the project's device settings, not signed in. */
  freshContext: () => Promise<BrowserContext>
}

/**
 * WebKit refuses to store a Secure cookie received over plain HTTP, even from localhost, which would make
 * every reload look signed out. Production runs behind HTTPS, so the test stack drops the Secure flag
 * for WebKit only; nothing else about the cookie changes.
 */
export async function relaxSecureCookie(ctx: BrowserContext): Promise<void> {
  await ctx.route('**/api/v1/auth/**', async (route) => {
    const response = await route.fetch()
    const headers = { ...response.headers() }
    const cookie = headers['set-cookie']
    if (cookie) headers['set-cookie'] = cookie.replace(/;\s*Secure/gi, '')
    await route.fulfill({ response, headers })
  })
}

/** Seeds the device preferences so the very first paint is deterministic. */
export async function seedPrefs(
  ctx: BrowserContext,
  locale: 'ru' | 'uz',
  theme: 'dark' | 'light',
): Promise<void> {
  await ctx.addInitScript(
    ([l, th]) => {
      try {
        if (!localStorage.getItem('tip.locale')) localStorage.setItem('tip.locale', l as string)
        if (!localStorage.getItem('tip.theme')) localStorage.setItem('tip.theme', th as string)
      } catch {
        // storage unavailable: defaults apply
      }
    },
    [locale, theme],
  )
}

export const test = base.extend<Fixtures>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright requires object destructuring in fixtures
  baseURL: async ({}, use) => {
    await use(baseUrl())
  },
  // biome-ignore lint/correctness/noEmptyPattern: Playwright requires object destructuring in fixtures
  admin: async ({}, use) => {
    await use(await Api.admin())
  },
  context: async ({ context, browserName }, use) => {
    if (browserName === 'webkit') await relaxSecureCookie(context)
    await use(context)
  },
  freshContext: async (
    {
      browser,
      browserName,
      viewport,
      userAgent,
      deviceScaleFactor,
      isMobile,
      hasTouch,
      locale,
      timezoneId,
      reducedMotion,
    },
    use,
  ) => {
    const contexts: BrowserContext[] = []
    await use(async () => {
      const ctx = await browser.newContext({
        baseURL: baseUrl(),
        viewport,
        userAgent,
        deviceScaleFactor,
        isMobile,
        hasTouch,
        locale,
        timezoneId,
        reducedMotion,
      })
      if (browserName === 'webkit') await relaxSecureCookie(ctx)
      contexts.push(ctx)
      return ctx
    })
    for (const c of contexts) await c.close()
  },
  signedIn: async ({ freshContext }, use) => {
    await use(async (creds, opts = {}) => {
      const ctx = await freshContext()
      await seedPrefs(ctx, opts.locale ?? 'ru', opts.theme ?? 'dark')
      const page = await ctx.newPage()
      await new LoginPage(page).signIn(creds)
      return page
    })
  },
})

/**
 * The server throttles failed logins to 20 per IP per 15 minutes, and every browser project shares one
 * IP. Tests that provoke failed logins therefore run on two projects only.
 */
export const FAILED_LOGIN_PROJECTS = ['chromium-desktop', 'webkit-desktop']
