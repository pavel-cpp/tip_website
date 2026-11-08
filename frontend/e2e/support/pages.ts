import type { Locator, Page } from '@playwright/test'
import { ru } from '../../src/i18n/ru'
import { uz } from '../../src/i18n/uz'
import type { Creds } from './api'

export type Locale = 'ru' | 'uz'
type Key = keyof typeof ru

/** Looks UI strings up in the real dictionaries, so tests do not repeat (and drift from) the copy. */
export function tr(locale: Locale = 'ru') {
  const dict = (locale === 'uz' ? uz : ru) as Record<string, unknown>
  return (key: Key, params: Record<string, string | number> = {}): string => {
    const raw = dict[key]
    let text: string
    if (typeof raw === 'string') text = raw
    else {
      const forms = (raw ?? {}) as Record<string, string>
      const category = new Intl.PluralRules(locale).select(Number(params.count ?? 0))
      text = forms[category] ?? forms.other ?? String(key)
    }
    return text.replace(/\{(\w+)\}/g, (w, n: string) => (n in params ? String(params[n]) : w))
  }
}

export class LoginPage {
  constructor(readonly page: Page) {}

  get login(): Locator {
    return this.page.locator('input[name="username"]')
  }
  get password(): Locator {
    return this.page.locator('input[name="password"]')
  }
  get submit(): Locator {
    return this.page.locator('form.login-card button[type="submit"]')
  }
  get error(): Locator {
    return this.page.locator('.login-error')
  }

  async open(): Promise<void> {
    await this.page.goto('/login')
    await this.login.waitFor()
  }

  async fill(creds: Creds): Promise<void> {
    await this.login.fill(creds.login)
    await this.password.fill(creds.password)
  }

  /** Signs in through the form and waits until the app shell is shown. */
  async signIn(creds: Creds): Promise<void> {
    await this.open()
    await this.fill(creds)
    await this.submit.click()
    await this.page.waitForURL((u) => !u.pathname.startsWith('/login'))
    await this.page.locator('header.topbar').waitFor()
  }
}

/** Top bar: language, theme and user menus. Labels follow the active locale. */
export class Topbar {
  constructor(
    readonly page: Page,
    readonly locale: Locale = 'ru',
  ) {}

  private t = (k: Key) => tr(this.locale)(k)

  get userMenu(): Locator {
    return this.page.getByRole('button', { name: this.t('nav.userMenu') })
  }
  get languageButton(): Locator {
    return this.page.locator('header.topbar').getByRole('button', { name: this.t('language.title') })
  }
  get themeButton(): Locator {
    return this.page.locator('header.topbar').getByRole('button', { name: this.t('theme.title') })
  }

  async chooseLanguage(target: Locale): Promise<void> {
    await this.languageButton.click()
    await this.page.getByRole('menuitemradio', { name: tr(this.locale)(`language.${target}`) }).click()
  }

  async chooseTheme(mode: 'dark' | 'light' | 'system'): Promise<void> {
    await this.themeButton.click()
    await this.page.getByRole('menuitemradio', { name: this.t(`theme.${mode}`) }).click()
  }

  async goTo(item: 'profile' | 'adminUsers' | 'adminRoles' | 'adminSystem'): Promise<void> {
    await this.userMenu.click()
    await this.page.getByRole('menuitem', { name: this.t(`nav.${item}`), exact: true }).click()
  }

  async logout(): Promise<void> {
    await this.userMenu.click()
    await this.page.getByRole('menuitem', { name: this.t('action.signOut') }).click()
  }

  async menuItems(): Promise<string[]> {
    await this.userMenu.click()
    await this.page.getByRole('menuitem').first().waitFor()
    const names = await this.page.getByRole('menuitem').allInnerTexts()
    await this.page.keyboard.press('Escape')
    return names.map((n) => n.trim())
  }
}

export const theme = (page: Page) => page.evaluate(() => document.documentElement.getAttribute('data-theme'))
export const htmlLang = (page: Page) => page.evaluate(() => document.documentElement.lang)

/** Waits for web fonts and the next paint so screenshots do not depend on font swap timing. */
export async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  })
}
