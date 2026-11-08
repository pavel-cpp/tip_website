/// <reference types="node" />
// Thin client for the real REST API, used to prepare data quickly. Bearer tokens only: the Secure
// refresh cookie is irrelevant here, so no cookie jar is needed.
import { makePng } from './png'

export interface Creds {
  login: string
  password: string
}

export interface ApiUser {
  id: string
  login: string
  displayName: string
  color: string
  locale: 'ru' | 'uz'
  theme: 'dark' | 'light' | 'system'
  passwordTemporary: boolean
  permissions: string[]
  roles: { id: string; name: string }[]
}

export interface ApiProject {
  id: string
  title: string
  status: 'active' | 'finished'
  version: number
  image: { w: number; h: number; url: string } | null
}

export interface ApiRole {
  id: string
  name: string
  permissions: string[]
}

export interface ApiParticipant {
  id: string
  number: number
  name: string
  phone: string
  version: number
}

export function baseUrl(): string {
  const url = process.env.E2E_BASE_URL
  if (!url) throw new Error('E2E_BASE_URL is not set: the stack global setup did not run')
  return url
}

export function adminCreds(): Creds {
  return {
    login: process.env.E2E_ADMIN_LOGIN ?? '',
    password: process.env.E2E_ADMIN_PASSWORD ?? '',
  }
}

let counter = 0
/** A short unique suffix so that parallel workers and reruns never collide on logins or titles. */
export function uniq(prefix: string): string {
  counter += 1
  return `${prefix}${Date.now().toString(36)}${counter}${Math.floor(Math.random() * 1296).toString(36)}`
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(`${status} ${code}: ${message}`)
  }
}

export class Api {
  private constructor(
    private token: string,
    readonly user: ApiUser,
    private readonly creds: Creds,
  ) {}

  static async login(creds: Creds): Promise<Api> {
    const res = await fetch(`${baseUrl()}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(creds),
    })
    const body = (await res.json()) as { accessToken?: string; user?: ApiUser }
    if (!res.ok || !body.accessToken || !body.user) throw new Error(`login failed for ${creds.login}: ${res.status}`)
    return new Api(body.accessToken, body.user, creds)
  }

  /** Permission changes make older access tokens stale (TOKEN_STALE); a fresh login fixes that. */
  private async relogin(): Promise<void> {
    this.token = (await Api.login(this.creds)).token
  }

  static admin(): Promise<Api> {
    return Api.login(adminCreds())
  }

  /** The token of the session; used by tests that need to speak to the API from the browser side. */
  get accessToken(): string {
    return this.token
  }

  async call<T>(method: string, path: string, body?: unknown, form?: FormData, retried = false): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}` }
    if (body !== undefined) headers['content-type'] = 'application/json'
    const res = await fetch(`${baseUrl()}/api/v1${path}`, {
      method,
      headers,
      body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
    })
    if (res.status === 204) return undefined as T
    const text = await res.text()
    const data = text ? (JSON.parse(text) as unknown) : undefined
    if (!res.ok) {
      const env = (data as { error?: { code?: string; message?: string } } | undefined)?.error
      if (res.status === 401 && env?.code === 'TOKEN_STALE' && !retried) {
        await this.relogin()
        return this.call(method, path, body, form, true)
      }
      throw new ApiError(res.status, env?.code ?? 'UNKNOWN', env?.message ?? text)
    }
    return data as T
  }

  // --- users and roles

  async createUser(opts: { login?: string; displayName?: string; roleIds?: string[] } = {}) {
    const login = opts.login ?? uniq('u')
    const res = await this.call<{ user: ApiUser; tempPassword: string }>('POST', '/admin/users', {
      login,
      displayName: opts.displayName ?? `User ${login}`,
      roleIds: opts.roleIds,
    })
    return { ...res.user, tempPassword: res.tempPassword }
  }

  /** Creates a user and replaces the temporary password so the first UI login shows no prompt. */
  async createReadyUser(opts: { login?: string; displayName?: string; roleIds?: string[]; locale?: 'ru' | 'uz'; theme?: 'dark' | 'light' } = {}): Promise<Creds & { id: string; displayName: string }> {
    const u = await this.createUser(opts)
    const password = `pw-${uniq('x')}-long`
    const session = await Api.login({ login: u.login, password: u.tempPassword })
    await session.call('POST', '/me/password', { current: u.tempPassword, new: password })
    if (opts.locale || opts.theme) {
      // Changing the password ends the old sessions, so sign in again before touching the profile.
      const fresh = await Api.login({ login: u.login, password })
      await fresh.call('PATCH', '/me', { locale: opts.locale, theme: opts.theme })
    }
    return { login: u.login, password, id: u.id, displayName: u.displayName }
  }

  async roles(): Promise<ApiRole[]> {
    return this.call('GET', '/admin/roles')
  }

  async roleId(name: string): Promise<string> {
    const found = (await this.roles()).find((r) => r.name === name)
    if (!found) throw new Error(`role ${name} not found`)
    return found.id
  }

  async createRole(permissions: string[], name = uniq('role')): Promise<ApiRole> {
    return this.call('POST', '/admin/roles', { name, description: 'e2e', permissions })
  }

  async setUserRoles(userId: string, roleIds: string[]): Promise<void> {
    await this.call('PUT', `/admin/users/${userId}/roles`, { roleIds })
  }

  async setActive(userId: string, isActive: boolean): Promise<void> {
    await this.call('PATCH', `/admin/users/${userId}`, { isActive })
  }

  // --- projects and participants

  async createProject(title = uniq('Project ')): Promise<ApiProject> {
    return (await this.call<{ project: ApiProject }>('POST', '/projects', { title })).project
  }

  async uploadImage(projectId: string, width = 700, height = 400): Promise<ApiProject> {
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(makePng(width, height))], { type: 'image/png' }), 'ticket.png')
    return (await this.call<{ project: ApiProject }>('PUT', `/projects/${projectId}/image`, undefined, form)).project
  }

  async finishProject(projectId: string): Promise<void> {
    await this.call('POST', `/projects/${projectId}/finish`)
  }

  async addParticipants(projectId: string, items: { name: string; phone: string }[]): Promise<ApiParticipant[]> {
    return (await this.call<{ items: ApiParticipant[] }>('POST', `/projects/${projectId}/participants`, { items })).items
  }

  async participants(projectId: string): Promise<ApiParticipant[]> {
    return (await this.call<{ items: ApiParticipant[] }>('GET', `/projects/${projectId}/participants`)).items
  }

  async updateParticipant(id: string, version: number, patch: { name?: string; phone?: string }): Promise<void> {
    await this.call('PATCH', `/participants/${id}`, { version, ...patch })
  }
}
