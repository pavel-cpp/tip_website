// One load phase: N concurrent operators in the project for S seconds. Each operator logs in, opens the project (the
// whole list), joins the room and then edits: lock, cursor, PATCH its own rows, unlock, about once a second and a half.
// Prints latency percentiles; exits with 2 when the gates (patch p95 over 2 s, server errors, many failures) break.
import { http, loadState, login, openRoom, sleep, summary } from './lib.mjs'

const N = Number(process.argv[2] ?? 10)
const SECONDS = Number(process.argv[3] ?? 40)
const SESSIONS_PER_USER = Number(process.env.TIP_SESSIONS ?? 1)
// Operators join spread over this many seconds (a shift does not open the project in the same instant).
const STAGGER = Number(process.env.TIP_STAGGER ?? 0)
const state = loadState()

const m = { login: [], list: [], project: [], patch: [], ws: [], fan: [], errors: {}, closes: 0, patches: 0, frames: 0 }
const err = (k) => {
  m.errors[k] = (m.errors[k] ?? 0) + 1
}
const sent = new Map() // "rowId:version" -> { t, by } of finished PATCHes
const arrived = new Map() // "rowId:version" -> { at, to } of upserts that were seen before their PATCH reply
let done = false

async function operator(idx, creds) {
  if (STAGGER > 0) await sleep(Math.random() * STAGGER * 1000)
  const l = await login(creds)
  m.login.push(l.ms)
  const [pr, ls] = await Promise.all([
    http(l.token, 'GET', `/projects/${state.projectId}`),
    http(l.token, 'GET', `/projects/${state.projectId}/participants`),
  ])
  m.project.push(pr.ms)
  if (ls.status !== 200) {
    err(`list ${ls.status}`)
    return
  }
  m.list.push(ls.ms)
  const first = (idx * 40) % Math.max(1, ls.data.items.length - 40)
  const mine = ls.data.items.slice(first, first + 40).map((r) => ({ id: r.id, version: r.version }))
  let room
  try {
    room = await openRoom(l.token, state.projectId, (f) => {
      m.frames++
      if (f.t === 'rows.upsert') {
        for (const it of f.items) {
          const key = `${it.id}:${it.version}`
          const s = sent.get(key)
          if (s) {
            if (s.by !== idx && !s.seen) {
              s.seen = true
              m.fan.push(performance.now() - s.t)
            }
          } else if (!arrived.has(key)) arrived.set(key, { at: performance.now(), to: idx })
        }
      }
    })
  } catch (e) {
    err(`ws ${e.message}`)
    return
  }
  m.ws.push(room.connectMs)
  let closing = false
  room.ws.addEventListener('close', () => {
    if (!closing && !done) m.closes++
  })
  const end = performance.now() + SECONDS * 1000
  while (performance.now() < end) {
    const row = mine[Math.floor(Math.random() * mine.length)]
    room.ws.send(JSON.stringify({ t: 'lock.acquire', rowId: row.id }))
    room.ws.send(JSON.stringify({ t: 'cursor', rowId: row.id, field: 'name' }))
    await sleep(150)
    const t = performance.now()
    const r = await http(l.token, 'PATCH', `/participants/${row.id}`, {
      version: row.version,
      name: `LT ${idx} ${Date.now() % 100000}`,
    })
    m.patches++
    if (r.status === 200) {
      m.patch.push(r.ms)
      const it = r.data.item
      row.version = it.version
      const key = `${row.id}:${it.version}`
      const early = arrived.get(key)
      if (early && early.to !== idx) m.fan.push(early.at - t)
      sent.set(key, { t, by: idx, seen: !!early })
    } else if (r.status === 409) {
      err(`patch 409 ${r.data?.error?.code ?? ''}`)
      const cur = r.data?.error?.details?.current
      if (cur) row.version = cur.version
    } else {
      err(`patch ${r.status}`)
    }
    room.ws.send(JSON.stringify({ t: 'lock.release', rowId: row.id }))
    await sleep(900 + Math.random() * 1000)
  }
  closing = true
  room.ws.close()
}

const jobs = []
const t00 = performance.now()
for (let i = 0; i < N; i++) {
  const u = state.users[i % state.users.length]
  for (let s = 0; s < SESSIONS_PER_USER; s++) {
    jobs.push(operator(i * SESSIONS_PER_USER + s, { login: u.login, password: u.password }))
  }
}
await Promise.all(jobs.map((j) => j.catch((e) => err(`op ${e.message}`))))
done = true
const total = Object.values(m.errors).reduce((a, b) => a + b, 0)
const out = {
  operators: N * SESSIONS_PER_USER,
  seconds: SECONDS,
  wall: Math.round((performance.now() - t00) / 1000),
  loginMs: summary(m.login),
  openListMs: summary(m.list),
  openProjectMs: summary(m.project),
  wsConnectMs: summary(m.ws),
  patchMs: summary(m.patch),
  fanoutMs: summary(m.fan),
  patches: m.patches,
  patchPerSec: Math.round((m.patches / SECONDS) * 10) / 10,
  frames: m.frames,
  unexpectedCloses: m.closes,
  errors: m.errors,
}
console.log(JSON.stringify(out))
const serverErr = Object.entries(m.errors).filter(([k]) => /\b5\d\d\b/.test(k)).reduce((a, [, v]) => a + v, 0)
if (total > Math.max(3, m.patches * 0.05) || (out.patchMs.p95 ?? 0) > 2000 || serverErr > 0) process.exit(2)
