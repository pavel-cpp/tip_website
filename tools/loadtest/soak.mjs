// Holds M idle WebSocket sessions in the project room for S seconds (a ping every 20 s) to see what a connection costs.
// Usage: node soak.mjs <M> [seconds]
import { loadState, login, openRoom, sleep, summary } from './lib.mjs'

const M = Number(process.argv[2] ?? 100)
const SECONDS = Number(process.argv[3] ?? 30)
const state = loadState()
const tokens = []
for (let i = 0; i < state.users.length; i++) {
  const u = state.users[i]
  tokens.push((await login({ login: u.login, password: u.password })).token)
}
const t0 = Date.now()
const conn = []
const rooms = []
const errors = {}
let closes = 0
const codes = {}
const open1 = async (i) => {
  try {
    const r = await openRoom(tokens[i % tokens.length], state.projectId)
    r.ws.addEventListener('close', (ev) => {
      closes++
      const k = `${ev.code} ${ev.reason ?? ''} @${Math.round((Date.now() - t0) / 1000)}s`
      codes[k] = (codes[k] ?? 0) + 1
    })
    conn.push(r.connectMs)
    rooms.push(r)
  } catch (e) {
    errors[e.message] = (errors[e.message] ?? 0) + 1
  }
}
// Opened in groups of 25 at a time; the server drops a socket that is silent for 45 s, so pings start right away.
const pinger = setInterval(() => {
  for (const r of rooms) if (r.ws.readyState === 1) r.ws.send(JSON.stringify({ t: 'ping' }))
}, 12000)
for (let i = 0; i < M; i += 25) {
  await Promise.all(Array.from({ length: Math.min(25, M - i) }, (_, k) => open1(i + k)))
  if (Object.values(errors).reduce((a, b) => a + b, 0) > 5) break
  await sleep(200)
}
console.log(JSON.stringify({ opened: rooms.length, wanted: M, connectMs: summary(conn), errors }))
await sleep(SECONDS * 1000)
clearInterval(pinger)
console.log(JSON.stringify({ stillOpen: rooms.length - closes, closes, codes }))
for (const r of rooms) r.ws.close()
await sleep(500)
