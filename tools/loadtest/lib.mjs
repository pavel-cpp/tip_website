// Shared helpers of the load-test scripts (see README.md). Node 22+: global fetch and WebSocket.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws' // the global WebSocket cannot set the Origin header the server checks

export const BASE = process.env.TIP_BASE ?? 'https://tip.pavel-and-vera.ru'
export const STATE = process.env.TIP_STATE ?? fileURLToPath(new URL('./state.json', import.meta.url))

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function loadState() {
  return JSON.parse(readFileSync(STATE, 'utf8'))
}
export function saveState(s) {
  writeFileSync(STATE, JSON.stringify(s, null, 1))
}

/** Percentile of an unsorted sample (nearest rank). */
export function pct(xs, p) {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] * 10) / 10
}
export function summary(xs) {
  return { n: xs.length, p50: pct(xs, 50), p95: pct(xs, 95), p99: pct(xs, 99), max: xs.length ? Math.round(Math.max(...xs)) : null }
}

export async function http(token, method, path, body) {
  const t0 = performance.now()
  const headers = { origin: BASE }
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(`${BASE}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  const ms = performance.now() - t0
  let data
  try {
    data = text ? JSON.parse(text) : undefined
  } catch {
    data = undefined
  }
  return { status: res.status, ms, bytes: text.length, data }
}

export async function login(creds) {
  const r = await http(null, 'POST', '/auth/login', creds)
  if (r.status !== 200 || !r.data?.accessToken) throw new Error(`login ${creds.login}: ${r.status} ${JSON.stringify(r.data)?.slice(0, 120)}`)
  return { token: r.data.accessToken, user: r.data.user, ms: r.ms }
}

/** A WebSocket client of one project room; resolves once the server's hello arrived. */
export function openRoom(token, projectId, onFrame) {
  const url = `${BASE.replace(/^http/, 'ws')}/api/v1/projects/${projectId}/ws`
  return new Promise((resolve, reject) => {
    const t0 = performance.now()
    const ws = new WebSocket(url, { headers: { origin: BASE } })
    let ready = false
    const timer = setTimeout(() => reject(new Error('ws hello timeout')), 15000)
    ws.addEventListener('open', () => ws.send(JSON.stringify({ t: 'auth', token })))
    ws.addEventListener('message', (ev) => {
      const f = JSON.parse(String(ev.data))
      if (f.t === 'hello' && !ready) {
        ready = true
        clearTimeout(timer)
        resolve({ ws, connectMs: performance.now() - t0, hello: f })
      }
      onFrame?.(f)
    })
    ws.addEventListener('error', (e) => {
      clearTimeout(timer)
      if (!ready) reject(new Error(`ws error ${e.message ?? ''}`))
    })
  })
}
