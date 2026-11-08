import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { clearAccessToken } from '../../auth/tokenStore'
import { formatDate, initI18n, setLocale } from '../../i18n'
import Roles from '../../pages/admin/Roles'
import Users from '../../pages/admin/Users'
import { callLog, jsonRes, makeUser, stubFetch } from '../../test/mockApi'
import { renderWithProviders } from '../../test/render'
import type { AuditEntry, SystemStatus } from './api'
import { auditSentence } from './auditText'
import { checkDetail, checkTitle } from './checks'
import { TempPasswordDialog } from './TempPasswordDialog'

beforeAll(() => initI18n())

afterEach(async () => {
  clearAccessToken()
  vi.unstubAllGlobals()
  await setLocale('ru')
})

const entry = (patch: Partial<AuditEntry>): AuditEntry => ({
  id: 1,
  at: '2026-11-08T10:00:00Z',
  actorId: 'u1',
  actorLogin: 'admin',
  action: 'tickets.print',
  projectId: 'p1',
  entityId: null,
  meta: { count: 5 },
  ip: null,
  ...patch,
})

describe('audit sentences', () => {
  it('names the actor, count and project', () => {
    const projects = new Map([['p1', 'Tashkent City Mall']])
    expect(auditSentence(entry({}), projects)).toBe(
      'admin напечатал 5 билетов в проекте «Tashkent City Mall»',
    )
  })

  it('says "deleted project" for an unknown id and omits the project while titles are unknown', () => {
    expect(auditSentence(entry({}), new Map())).toContain('в удалённом проекте')
    expect(auditSentence(entry({}), null)).toBe('admin напечатал 5 билетов')
  })

  it('falls back to the raw code for an action without a phrase', () => {
    expect(auditSentence(entry({ action: 'brand.new', projectId: null }), null)).toBe('admin: brand.new')
  })

  it('is translated to Uzbek', async () => {
    await setLocale('uz')
    expect(auditSentence(entry({ projectId: null }), null)).toBe('admin 5 ta chipta chop etdi')
  })
})

describe('system checks', () => {
  const check = (patch: Partial<SystemStatus['checks'][number]>) => ({
    name: 'postgres',
    status: 'ok' as const,
    detail: 'reachable',
    ...patch,
  })

  it('translates names and known details by code', async () => {
    expect(checkTitle(check({}))).toBe('База данных (PostgreSQL)')
    expect(checkDetail(check({}), { free: '1', total: '2' })).toBe('доступен')
    expect(
      checkDetail(check({ name: 'backups', status: 'warn', detail: 'no backup metrics file yet' }), {
        free: '',
        total: '',
      }),
    ).toBe('данных о резервных копиях пока нет')
    await setLocale('uz')
    expect(checkDetail(check({}), { free: '1', total: '2' })).toBe('mavjud')
  })

  it('rebuilds the disk text from the figures and keeps unknown text as it is', () => {
    const disk = { free: '5 ГБ', total: '10 ГБ' }
    expect(checkDetail(check({ name: 'disk', detail: '5.0 GB free of 10.0 GB' }), disk)).toBe(
      'свободно 5 ГБ из 10 ГБ',
    )
    expect(checkDetail(check({ name: 'weird', detail: 'local: 3h ago' }), disk)).toBe('local: 3h ago')
  })
})

describe('Uzbek dates', () => {
  it('use dd.mm.yyyy instead of the ICU "2026 M11 8" form', async () => {
    await setLocale('uz')
    const text = formatDate(new Date(2026, 10, 8, 16, 13), { dateStyle: 'medium', timeStyle: 'short' })
    expect(text).toMatch(/^08\.11\.2026/)
    expect(text).not.toContain('M11')
  })
})

describe('temporary password dialog', () => {
  it('ignores Esc and a backdrop press; only the explicit button closes it', async () => {
    const onClose = vi.fn()
    renderWithProviders(<TempPasswordDialog password="s3cret-pass" userName="Test" onClose={onClose} />)
    const dialog = await screen.findByRole('dialog')
    await userEvent.keyboard('{Escape}')
    await userEvent.pointer({ target: dialog.parentElement as Element, keys: '[MouseLeft]' })
    expect(onClose).not.toHaveBeenCalled()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Я сохранил пароль' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

const admin = makeUser({ id: 'me' })
const userRow = (id: string, login: string, isActive = true) => ({
  user: makeUser({ id, login, displayName: login }),
  isActive,
  lastLoginAt: null,
})

describe('users page: deactivation', () => {
  function setup() {
    let active = true
    const mock = stubFetch(({ method, path, body }) => {
      if (path === '/auth/refresh') return jsonRes(200, { accessToken: 't', expiresIn: 900 })
      if (path === '/me') return jsonRes(200, { user: admin })
      if (method === 'GET' && path === '/admin/users')
        return jsonRes(200, [userRow('me', 'admin'), userRow('u2', 'worker1', active)])
      if (method === 'GET' && path === '/admin/roles') return jsonRes(200, [])
      if (method === 'PATCH' && path === '/admin/users/u2') {
        active = (body as { isActive: boolean }).isActive
        return jsonRes(200, { user: makeUser({ id: 'u2' }) })
      }
      return undefined
    })
    renderWithProviders(<Users />)
    return mock
  }

  it('disables "deactivate" on your own row with an explanation', async () => {
    setup()
    await userEvent.click(await screen.findByRole('button', { name: 'Ещё: admin' }))
    expect(await screen.findByRole('menuitem', { name: 'Отключить' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
  })

  it('deactivates at once and offers an undo that switches the user back on', async () => {
    const mock = setup()
    await userEvent.click(await screen.findByRole('button', { name: 'Ещё: worker1' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Отключить' }))
    expect(await screen.findByText('Пользователь worker1 отключён')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Вернуть' }))
    await waitFor(() => expect(callLog(mock).filter((c) => c === 'PATCH /admin/users/u2')).toHaveLength(2))
  })
})

describe('roles page', () => {
  it('translates system role descriptions and says how many users hold a role being deleted', async () => {
    const role = (id: string, name: string, isSystem: boolean, userCount: number) => ({
      id,
      name,
      description: 'English seed text',
      isSystem,
      permissions: [],
      userCount,
    })
    stubFetch(({ method, path }) => {
      if (path === '/auth/refresh') return jsonRes(200, { accessToken: 't', expiresIn: 900 })
      if (path === '/me') return jsonRes(200, { user: admin })
      if (method === 'GET' && path === '/admin/roles')
        return jsonRes(200, [role('r1', 'worker', true, 2), role('r2', 'Старший', false, 3)])
      if (method === 'GET' && path === '/admin/permissions') return jsonRes(200, [])
      return undefined
    })
    renderWithProviders(<Roles />)
    expect(await screen.findByText(/Оператор: работает с участниками/)).toBeInTheDocument()
    expect(screen.queryByText('English seed text', { selector: 'p.muted' })).toBeInTheDocument() // custom role keeps its own text
    const deletes = screen.getAllByRole('button', { name: 'Удалить' })
    await userEvent.click(deletes[1] as HTMLElement)
    expect(await screen.findByText(/назначена: 3 пользователя/)).toBeInTheDocument()
  })
})
