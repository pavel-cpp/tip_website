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

/** Seeds the device preferences so the very first paint is deterministic. */
export async function seedPrefs(ctx: BrowserContext, locale: 'ru' | 'uz', theme: 'dark' | 'light'): Promise<void> {
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
  baseURL: async ({}, use) => {
    await use(baseUrl())
  },
  admin: async ({}, use) => {
    await use(await Api.admin())
  },
  freshContext: async (
    { browser, viewport, userAgent, deviceScaleFactor, isMobile, hasTouch, locale, timezoneId, reducedMotion },
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
