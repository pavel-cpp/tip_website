import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { clearAccessToken } from '../auth/tokenStore'
import { initI18n } from '../i18n'
import { jsonRes, makeUser, stubFetch } from '../test/mockApi'
import { renderWithProviders } from '../test/render'
import { Topbar } from './Topbar'

beforeAll(() => initI18n())

afterEach(() => {
  clearAccessToken()
  vi.unstubAllGlobals()
})

const status = (links?: object) => ({
  version: 'x',
  uptime: 1,
  checks: [],
  db: { sizeBytes: 1, pool: { inUse: 0, open: 0, maxOpen: 1 } },
  disk: { free: 1, total: 2 },
  retention: { obsDays: 1, auditDays: 1 },
  ...(links ? { links } : {}),
})

async function openMenu(permissions: string[], links?: object) {
  const mock = stubFetch(({ method, path }) => {
    if (method === 'POST' && path === '/auth/refresh')
      return jsonRes(200, { accessToken: 't', expiresIn: 900 })
    if (path === '/me') return jsonRes(200, { user: makeUser({ permissions: permissions as never }) })
    if (path === '/admin/system') return jsonRes(200, status(links))
    return undefined
  })
  renderWithProviders(<Topbar />)
  await userEvent.click(await screen.findByRole('button', { name: 'Меню пользователя' }))
  return mock
}

describe('operator links in the user menu', () => {
  it('shows both links as new-tab anchors for system.view', async () => {
    await openMenu(['system.view'], { swagger: '/api/docs', grafana: 'https://grafana.example/' })
    const grafana = await screen.findByRole('menuitem', { name: /Grafana/ })
    expect(grafana).toHaveAttribute('href', 'https://grafana.example/')
    expect(grafana).toHaveAttribute('target', '_blank')
    expect(grafana).toHaveAttribute('rel', 'noopener noreferrer')
    expect(screen.getByRole('menuitem', { name: /Документация API/ })).toHaveAttribute('href', '/api/docs')
  })

  it('hides an item whose link is absent', async () => {
    await openMenu(['system.view'], { swagger: '/api/docs' })
    await screen.findByRole('menuitem', { name: /Документация API/ })
    expect(screen.queryByRole('menuitem', { name: /Grafana/ })).toBeNull()
  })

  it('does not fetch or show anything without system.view', async () => {
    const mock = await openMenu(['project.view'], { swagger: '/api/docs' })
    await screen.findByRole('menuitem', { name: 'Профиль' })
    expect(screen.queryByRole('menuitem', { name: /Документация API/ })).toBeNull()
    expect(mock.mock.calls.some(([u]) => String(u).includes('/admin/system'))).toBe(false)
  })
})
