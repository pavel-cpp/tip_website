// Creates the load-test project (5000 rows) and N operator accounts; writes state.json. Admin credentials come from
// TIP_ADMIN_LOGIN / TIP_ADMIN_PASSWORD. Everything created here is prefixed "lt-" / "LOADTEST" and removed by teardown.mjs.
import { http, login, saveState } from './lib.mjs'

const USERS = Number(process.argv[2] ?? 40)
const ROWS = Number(process.argv[3] ?? 5000)
const admin = await login({ login: process.env.TIP_ADMIN_LOGIN, password: process.env.TIP_ADMIN_PASSWORD })
const stamp = Date.now().toString(36)
const p = await http(admin.token, 'POST', '/projects', { title: `LOADTEST ${stamp}` })
if (p.status !== 201 && p.status !== 200) throw new Error(`project: ${p.status} ${JSON.stringify(p.data)}`)
const projectId = (p.data.project ?? p.data).id
for (let i = 0; i < ROWS; i += 1000) {
  const items = Array.from({ length: Math.min(1000, ROWS - i) }, (_, k) => ({
    name: `Load Person ${i + k + 1}`,
    phone: `+7900${String(1000000 + i + k)}`,
  }))
  const r = await http(admin.token, 'POST', `/projects/${projectId}/participants`, { items })
  if (r.status >= 300) throw new Error(`rows: ${r.status} ${JSON.stringify(r.data)}`)
}
const users = []
for (let i = 0; i < USERS; i++) {
  const r = await http(admin.token, 'POST', '/admin/users', { login: `lt-${stamp}-${i}`, displayName: `Load ${i + 1}` })
  if (r.status !== 201) throw new Error(`user ${i}: ${r.status} ${JSON.stringify(r.data)}`)
  users.push({ id: r.data.user.id, login: r.data.user.login, password: r.data.tempPassword })
}
saveState({ projectId, stamp, users, rows: ROWS })
console.log(`project ${projectId}, ${ROWS} rows, ${users.length} users`)
