import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { App } from './App'
import { initI18n, setLocale } from './i18n'

beforeAll(() => initI18n())
afterEach(async () => {
  await setLocale('ru')
})

function open(path: string) {
  window.history.pushState({}, '', path)
  return render(<App />)
}

describe('app shell and routing', () => {
  it('renders lazy placeholder pages inside the shell', async () => {
    open('/profile')
    expect(await screen.findByRole('heading', { name: 'Профиль' })).toBeInTheDocument()
    expect(screen.getByRole('banner')).toBeInTheDocument()
    expect(screen.getByText('Раздел в разработке')).toBeInTheDocument()
  })

  for (const path of [
    '/',
    '/login',
    '/projects/42',
    '/projects/42/settings',
    '/admin/users',
    '/admin/roles',
    '/admin/system',
  ]) {
    it(`serves ${path}`, async () => {
      open(path)
      expect(await screen.findByText('Раздел в разработке')).toBeInTheDocument()
    })
  }

  it('shows the 404 page for unknown paths', async () => {
    open('/nope/nothing')
    expect(await screen.findByRole('heading', { name: 'Страница не найдена' })).toBeInTheDocument()
  })

  it('switches language without reloading', async () => {
    open('/profile')
    await screen.findByRole('heading', { name: 'Профиль' })
    await userEvent.click(screen.getByRole('button', { name: 'Язык' }))
    await userEvent.click(await screen.findByRole('menuitemradio', { name: 'Oʻzbekcha' }))
    expect(await screen.findByRole('heading', { name: 'Profil' })).toBeInTheDocument()
  })

  it('/design lists components and renders in both languages', async () => {
    open('/design')
    expect(await screen.findByRole('heading', { name: 'Дизайн-система' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Основная' })).toBeInTheDocument()
    await setLocale('uz')
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Dizayn tizimi' })).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Asosiy' })).toBeInTheDocument()
  })

  it('/design can show both themes side by side', async () => {
    const { container } = open('/design')
    await screen.findByRole('heading', { name: 'Дизайн-система' })
    await userEvent.click(screen.getByRole('button', { name: 'Тёмная / Светлая' }))
    const scopes = container.querySelectorAll('[data-theme]')
    expect([...scopes].map((s) => s.getAttribute('data-theme'))).toEqual(['dark', 'light'])
    expect(within(scopes[1] as HTMLElement).getByRole('button', { name: 'Основная' })).toBeInTheDocument()
  })
})
