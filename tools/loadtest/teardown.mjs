// Removes what setup.mjs created: the project, and the accounts are deactivated (the API cannot delete users).
import { http, loadState, login } from './lib.mjs'

const s = loadState()
const admin = await login({ login: process.env.TIP_ADMIN_LOGIN, password: process.env.TIP_ADMIN_PASSWORD })
const d = await http(admin.token, 'DELETE', `/projects/${s.projectId}`)
console.log('project delete', d.status)
let ok = 0
for (const u of s.users) {
  const r = await http(admin.token, 'PATCH', `/admin/users/${u.id}`, { isActive: false })
  if (r.status === 200) ok++
}
console.log(`deactivated ${ok}/${s.users.length}`)
