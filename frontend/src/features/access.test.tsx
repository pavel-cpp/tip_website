import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { Route, Routes } from 'react-router'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { clearAccessToken } from '../auth/tokenStore'
import { initI18n, setLocale } from '../i18n'
import { ru } from '../i18n/ru'
import type { Message } from '../i18n/types'
import { uz } from '../i18n/uz'
import Roles from '../pages/admin/Roles'
import Users from '../pages/admin/Users'
import Login from '../pages/Login'
import { ALL_PERMISSIONS, apiError, callLog, jsonRes, makeUser, stubFetch } from '../test/mockApi'
import { renderWithProviders } from '../test/render'
import type { Permission, PermissionCode } from './admin/api'
import { PermissionMatrix } from './admin/PermissionMatrix'
import { dependenciesOf, dependentsOf, togglePermission } from './admin/permissions'
import { TempPasswordDialog } from './admin/TempPasswordDialog'

beforeAll(() => initI18n())
afterEach(async () => {
  clearAccessToken()
  vi.unstubAllGlobals()
  await setLocale('ru')
})

const signedIn = (extra: (r: { method: string; path: string; body: unknown }) => Response | undefined) =>
  stubFetch((req) => {
    if (req.path === '/auth/refresh') return jsonRes(200, { accessToken: 't', expiresIn: 900 })
    if (req.path === '/me') return jsonRes(200, { user: makeUser() })
    return extra(req)
  })

describe('login screen', () => {
  const anonymous = (login: (body: unknown) => Response) =>
    stubFetch(({ method, path, body }) => {
      if (path === '/auth/refresh') return apiError(401, 'REFRESH_INVALID')
      if (method === 'POST' && path === '/auth/login') return login(body)
      return undefined
    })

  it('shows the message for the API error code', async () => {
    anonymous(() => apiError(401, 'BAD_CREDENTIALS'))
    renderWithProviders(<Login />, { route: '/login' })
    await userEvent.type(await screen.findByLabelText('Логин'), 'a.azimov')
    await userEvent.type(screen.getByLabelText('Пароль'), 'wrong')
    await userEvent.click(screen.getByRole('button', { name: 'Войти' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Неверный логин или пароль')
  })

  it('asks for both fields without calling the server', async () => {
    const mock = anonymous(() => apiError(500, 'INTERNAL'))
    renderWithProviders(<Login />, { route: '/login' })
    await userEvent.click(await screen.findByRole('button', { name: 'Войти' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Введите логин и пароль')
    expect(callLog(mock)).not.toContain('POST /auth/login')
  })

  it('toggles password visibility and shows the administrator hint for "Forgot password?"', async () => {
    anonymous(() => apiError(401, 'BAD_CREDENTIALS'))
    renderWithProviders(<Login />, { route: '/login' })
    const pw = await screen.findByLabelText('Пароль')
    expect(pw).toHaveAttribute('type', 'password')
    await userEvent.click(screen.getByRole('button', { name: 'Показать пароль' }))
    expect(pw).toHaveAttribute('type', 'text')
    await userEvent.click(screen.getByRole('button', { name: 'Забыли пароль?' }))
    expect(screen.getByText('Обратитесь к администратору')).toBeInTheDocument()
  })

  it('signs in and leaves the login page', async () => {
    anonymous(() => jsonRes(200, { accessToken: 'tok', expiresIn: 900, user: makeUser() }))
    renderWithProviders(
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={<div>home-page</div>} />
      </Routes>,
      { route: '/login' },
    )
    await userEvent.type(await screen.findByLabelText('Логин'), 'a.azimov')
    await userEvent.type(screen.getByLabelText('Пароль'), 'secret-pass')
    await userEvent.click(screen.getByRole('button', { name: 'Войти' }))
    expect(await screen.findByText('home-page')).toBeInTheDocument()
  })
})

const box = (code: string) => document.querySelector(`input[data-code="${code}"]`) as HTMLElement

describe('permission cascade', () => {
  it('enabling a permission also enables its dependencies, disabling drops dependents', () => {
    expect(dependenciesOf('participant.edit').sort()).toEqual(['participant.view', 'project.view'])
    const on = togglePermission(new Set(), 'participant.edit')
    expect([...on.next].sort()).toEqual(['participant.edit', 'participant.view', 'project.view'])
    expect(on.added.sort()).toEqual(['participant.view', 'project.view'])
    const off = togglePermission(on.next, 'project.view')
    expect(off.next.size).toBe(0)
    expect(dependentsOf('user.view')).toEqual(expect.arrayContaining(['user.manage', 'role.manage']))
  })

  const catalog: Permission[] = ALL_PERMISSIONS.map((code) => ({
    code,
    group:
      code.split('.')[0] === 'project'
        ? 'Projects'
        : code.startsWith('participant')
          ? 'Participants'
          : 'Administration',
    description: code,
  }))

  function Harness() {
    const [value, setValue] = useState<ReadonlySet<PermissionCode>>(new Set())
    return <PermissionMatrix catalog={catalog} value={value} onChange={setValue} />
  }

  it('checks the dependencies in the matrix and flashes the "added automatically" hint for ~600 ms', async () => {
    renderWithProviders(<Harness />)
    await userEvent.click(await screen.findByRole('checkbox', { name: /^Правка участников/ }))
    expect(box('participant.view')).toBeChecked()
    expect(box('project.view')).toBeChecked()
    expect(screen.getAllByText('добавлено автоматически')).toHaveLength(2)
    await waitFor(() => expect(screen.queryByText('добавлено автоматически')).not.toBeInTheDocument(), {
      timeout: 1500,
    })
    expect(box('project.view')).toBeChecked()
  })
})

describe('temporary password dialog', () => {
  it('shows the password with a once-only notice and copies it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const onClose = vi.fn()
    renderWithProviders(<TempPasswordDialog password="Xk3-secret-PW-99" userName="Murod" onClose={onClose} />)
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByLabelText('Временный пароль')).toHaveValue('Xk3-secret-PW-99')
    expect(within(dialog).getByRole('note')).toHaveTextContent('только один раз')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Копировать' }))
    expect(writeText).toHaveBeenCalledWith('Xk3-secret-PW-99')
    expect(await within(dialog).findByRole('button', { name: 'Скопировано' })).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Я сохранил пароль' }))
    expect(onClose).toHaveBeenCalled()
  })
})

describe('admin users screen', () => {
  const row = {
    user: makeUser({
      id: 'u2',
      login: 'm.karimov',
      displayName: 'Murod Karimov',
      roles: [{ id: 'r-w', name: 'worker' }],
    }),
    isActive: true,
    lastLoginAt: null,
  }

  it('creates a user and shows the generated password once', async () => {
    const mock = signedIn(({ method, path, body }) => {
      if (method === 'GET' && path === '/admin/users') return jsonRes(200, [row])
      if (method === 'GET' && path === '/admin/roles') return jsonRes(200, [])
      if (method === 'POST' && path === '/admin/users') {
        expect(body).toMatchObject({ login: 'new.user', displayName: 'New User' })
        return jsonRes(201, {
          user: makeUser({ id: 'u3', login: 'new.user', displayName: 'New User' }),
          tempPassword: 'T3mp-Pass-12345',
        })
      }
      return undefined
    })
    renderWithProviders(<Users />)
    expect(await screen.findByText('Murod Karimov')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Создать пользователя' }))
    await userEvent.type(await screen.findByLabelText('Логин'), 'new.user')
    await userEvent.type(screen.getByLabelText('Отображаемое имя'), 'New User')
    const dialog = screen.getByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Создать' }))
    expect(await screen.findByLabelText('Временный пароль')).toHaveValue('T3mp-Pass-12345')
    await userEvent.click(screen.getByRole('button', { name: 'Я сохранил пароль' }))
    await waitFor(() => expect(screen.queryByLabelText('Временный пароль')).not.toBeInTheDocument())
    expect(document.body.textContent).not.toContain('T3mp-Pass-12345')
    expect(callLog(mock).filter((c) => c === 'POST /admin/users')).toHaveLength(1)
  })

  it('filters by search and shows the empty state', async () => {
    signedIn(({ path }) => (path === '/admin/users' ? jsonRes(200, [row]) : jsonRes(200, [])))
    renderWithProviders(<Users />)
    await screen.findByText('Murod Karimov')
    await userEvent.type(screen.getByRole('searchbox'), 'zzz')
    expect(await screen.findByText('Ничего не найдено')).toBeInTheDocument()
  })

  it('shows an error state with retry', async () => {
    signedIn(({ path }) => (path === '/admin/users' ? apiError(500, 'INTERNAL') : jsonRes(200, [])))
    renderWithProviders(<Users />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Внутренняя ошибка')
    expect(screen.getByRole('button', { name: 'Повторить' })).toBeInTheDocument()
  })
})

describe('admin roles screen', () => {
  const role = {
    id: 'r1',
    name: 'Senior',
    description: '',
    isSystem: false,
    permissions: ['project.view'],
    userCount: 1,
  }

  it('explains who uses a role when deletion fails with ROLE_IN_USE', async () => {
    signedIn(({ method, path }) => {
      if (path === '/admin/roles' && method === 'GET') return jsonRes(200, [role])
      if (path === '/admin/permissions') return jsonRes(200, [])
      if (method === 'DELETE' && path === '/admin/roles/r1') return apiError(409, 'ROLE_IN_USE')
      if (path === '/admin/roles/r1')
        return jsonRes(200, {
          role,
          users: [{ id: 'u9', displayName: 'Holder Person', color: '#fff', avatarUrl: null }],
        })
      return undefined
    })
    renderWithProviders(<Roles />)
    await screen.findByText('Senior')
    await userEvent.click(screen.getByRole('button', { name: 'Удалить' }))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Удалить' }))
    expect(await screen.findByText('Holder Person')).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Роль назначена пользователям' })).toBeInTheDocument()
  })
})

describe('i18n parity for stream F1 keys', () => {
  const mine = (d: Record<string, Message>) =>
    Object.keys(d)
      .filter((k) => /^(auth|profile|admin)\./.test(k))
      .sort()
  const ruD = ru as Record<string, Message>
  const uzD = uz as Record<string, Message>

  it('has identical key sets in ru and uz', () => {
    expect(mine(uzD)).toEqual(mine(ruD))
    expect(mine(ruD).length).toBeGreaterThan(100)
  })

  it('has a label and a hint for every permission code and a name for every group', () => {
    for (const code of ALL_PERMISSIONS) {
      for (const d of [ruD, uzD]) {
        expect(d[`admin.perm.${code}`], code).toBeDefined()
        expect(d[`admin.permHint.${code}`], code).toBeDefined()
      }
    }
    for (const g of ['Projects', 'Participants', 'Administration'])
      expect(uzD[`admin.group.${g}`]).toBeDefined()
  })
})
