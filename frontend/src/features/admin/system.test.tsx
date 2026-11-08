import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { clearAccessToken } from '../../auth/tokenStore'
import { initI18n, setLocale } from '../../i18n'
import System from '../../pages/admin/System'
import { jsonRes, makeUser, stubFetch } from '../../test/mockApi'
import { renderWithProviders } from '../../test/render'

beforeAll(() => initI18n())

afterEach(async () => {
  clearAccessToken()
  admin = makeUser({ id: 'me' })
  vi.unstubAllGlobals()
  await setLocale('ru')
})

let admin = makeUser({ id: 'me' })
const GB = 1024 ** 3

function status(links: Record<string, string> = {}) {
  return {
    version: 'test',
    uptime: 3600,
    checks: [{ name: 'postgres', status: 'ok', detail: 'reachable' }],
    db: { sizeBytes: 5 * 1024 * 1024, pool: { open: 1, inUse: 0, maxOpen: 10 } },
    disk: { free: 913.7 * GB, total: 1006.9 * GB },
    retention: { obsDays: 7, auditDays: 30 },
    links,
  }
}

const userRow = (id: string, login: string, displayName: string) => ({
  user: makeUser({ id, login, displayName }),
  isActive: true,
  lastLoginAt: null,
})

function setup(links: Record<string, string>, audit: unknown[] = []) {
  const urls: string[] = []
  stubFetch(({ method, path }) => {
    if (path === '/auth/refresh') return jsonRes(200, { accessToken: 't', expiresIn: 900 })
    if (path === '/me') return jsonRes(200, { user: admin })
    if (path === '/admin/system') return jsonRes(200, status(links))
    if (method === 'GET' && path.startsWith('/admin/audit')) {
      urls.push(path)
      return jsonRes(200, { items: audit, next: null })
    }
    if (path === '/admin/users')
      return jsonRes(200, [userRow('me', 'admin', 'Admin'), userRow('u7', 'quiet.one', 'Quiet One')])
    if (path.startsWith('/projects')) return jsonRes(200, [])
    return undefined
  })
  renderWithProviders(<System />)
  return urls
}

describe('system page', () => {
  it('tells admins that Grafana is not configured', async () => {
    setup({})
    expect(await screen.findByTestId('grafana-note')).toHaveTextContent(/GRAFANA_URL/)
  })

  it('links to Grafana when the server knows its address', async () => {
    setup({ grafana: 'https://grafana.example/' })
    const note = await screen.findByTestId('grafana-note')
    expect(within(note).getByRole('link')).toHaveAttribute('href', 'https://grafana.example/')
  })

  it('formats sizes with a space for grouping and a decimal comma', async () => {
    setup({})
    expect(await screen.findByText(/913,7 ГБ из 1\s006,9 ГБ/)).toBeInTheDocument()
    expect(screen.queryByText(/1,006\.9/)).toBeNull()
  })

  it('formats sizes the Uzbek way in Uzbek', async () => {
    await setLocale('uz')
    // The signed-in profile decides the language, so the stored user must be Uzbek too.
    admin = makeUser({ id: 'me', locale: 'uz' })
    setup({})
    expect(await screen.findByText(/GB dan/)).toHaveTextContent(/1\s006,9 GB dan 913,7 GB/)
    expect(screen.queryByText(/913\.7/)).toBeNull()
  })
})

describe('audit log', () => {
  it('lists every user in the filter, including ones that appear in no loaded row', async () => {
    setup({}, [])
    const select = await screen.findByLabelText('Пользователь')
    await within(select).findByRole('option', { name: 'quiet.one' })
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Все', 'admin', 'quiet.one'])
  })

  it('hides "show more" when there is no further page', async () => {
    setup({}, [
      {
        id: 2,
        at: '2026-11-08T10:00:00Z',
        actorId: 'me',
        actorLogin: 'admin',
        action: 'user.create',
        projectId: null,
        entityId: 'u7',
        meta: { login: 'quiet.one' },
        ip: null,
      },
    ])
    expect(await screen.findByText('admin создал пользователя «Quiet One»')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Показать ещё' })).toBeNull()
  })

  it('asks the server to filter by action', async () => {
    const urls = setup({}, [])
    await userEvent.selectOptions(await screen.findByLabelText('Действие'), 'user.create')
    await vi.waitFor(() => expect(urls.some((u) => u.includes('action=user.create'))).toBe(true))
  })
})
