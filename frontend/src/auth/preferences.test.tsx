import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { LanguageMenu } from '../components/LanguageMenu'
import { ThemeMenu } from '../components/ThemeMenu'
import { getLocale, initI18n, setLocale } from '../i18n'
import { jsonRes, makeUser, stubFetch } from '../test/mockApi'
import { renderWithProviders } from '../test/render'
import { getThemeMode, setThemeMode } from '../theme/theme'
import { clearAccessToken } from './tokenStore'

beforeAll(() => initI18n())

beforeEach(async () => {
  await setLocale('ru')
  setThemeMode('dark')
})

afterEach(async () => {
  clearAccessToken()
  vi.unstubAllGlobals()
  setThemeMode('dark')
  await setLocale('ru')
})

function session(signedIn: boolean) {
  const patches: unknown[] = []
  stubFetch(({ method, path, body }) => {
    if (path === '/auth/refresh')
      return signedIn
        ? jsonRes(200, { accessToken: 't', expiresIn: 900 })
        : jsonRes(401, { error: { code: 'UNAUTHENTICATED', message: 'x' } })
    if (path === '/me' && method === 'GET') return jsonRes(200, { user: makeUser() })
    if (path === '/me' && method === 'PATCH') {
      patches.push(body)
      return jsonRes(200, { user: makeUser({ ...(body as object) }) })
    }
    return undefined
  })
  return patches
}

describe('top bar preferences', () => {
  it('store the theme and language on the server for a signed-in user', async () => {
    const patches = session(true)
    renderWithProviders(
      <>
        <LanguageMenu />
        <ThemeMenu />
      </>,
    )
    await userEvent.click(await screen.findByRole('button', { name: /Тема/ }))
    await userEvent.click(await screen.findByRole('menuitemradio', { name: 'Светлая' }))
    await waitFor(() => expect(patches).toContainEqual({ theme: 'light' }))

    await userEvent.click(screen.getByRole('button', { name: /RU/ }))
    await userEvent.click(
      await screen.findByRole('menuitemradio', { name: /Oʻzbekcha|O‘zbekcha|Uzbek|Oʻzbek/i }),
    )
    await waitFor(() => expect(patches).toContainEqual({ locale: 'uz' }))
    // The dictionary loads asynchronously; let it settle so it cannot land in the next test.
    await waitFor(() => expect(getLocale()).toBe('uz'))
  })

  it('keep a fresh local choice when the server reply comes back', async () => {
    session(true)
    renderWithProviders(<ThemeMenu />)
    await userEvent.click(await screen.findByRole('button', { name: /Тема/ }))
    expect(getLocale()).toBe('ru')
    expect(document.body.textContent).toContain('Светлая')
    await userEvent.click(await screen.findByRole('menuitemradio', { name: 'Светлая' }))
    // A later local change must survive the reply of the earlier PATCH (which says "light").
    setThemeMode('system')
    await new Promise((r) => setTimeout(r, 50))
    expect(getThemeMode()).toBe('system')
    expect(getLocale()).toBe('ru')
  })

  it('stay local (no PATCH /me) for an anonymous visitor', async () => {
    const patches = session(false)
    renderWithProviders(<ThemeMenu />)
    await userEvent.click(await screen.findByRole('button', { name: /Тема/ }))
    await userEvent.click(await screen.findByRole('menuitemradio', { name: 'Светлая' }))
    await waitFor(() => expect(getThemeMode()).toBe('light'))
    expect(patches).toHaveLength(0)
  })
})
