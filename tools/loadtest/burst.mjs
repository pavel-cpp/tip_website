// N operators open the project at the same moment: every one downloads the whole participant list (state.rows rows).
// Usage: node burst.mjs <N> [rounds]
import { http, loadState, login, summary } from './lib.mjs'

const N = Number(process.argv[2] ?? 10)
const ROUNDS = Number(process.argv[3] ?? 3)
const state = loadState()
const tokens = []
for (let i = 0; i < N; i++) {
  const u = state.users[i % state.users.length]
  tokens.push((await login({ login: u.login, password: u.password })).token)
}
const lat = []
const errors = {}
let bytes = 0
for (let r = 0; r < ROUNDS; r++) {
  const rs = await Promise.all(tokens.map((t) => http(t, 'GET', `/projects/${state.projectId}/participants`)))
  for (const x of rs) {
    if (x.status === 200) {
      lat.push(x.ms)
      bytes = x.bytes
    } else errors[x.status] = (errors[x.status] ?? 0) + 1
  }
  await new Promise((r2) => setTimeout(r2, 1500))
}
console.log(JSON.stringify({ simultaneous: N, rounds: ROUNDS, listKB: Math.round(bytes / 1024), latencyMs: summary(lat), errors }))
