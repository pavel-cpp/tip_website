/// <reference types="node" />
// Reproducible full stack for the browser tests: Postgres + Redis (dev compose), the built SPA embedded
// into a freshly compiled tipd binary, a throwaway database and a free port. Used as Playwright's
// globalSetup; the returned function tears everything down and leaves the working tree clean.
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const frontendDir = path.resolve(here, '../..')
const repoDir = path.resolve(frontendDir, '..')
const backendDir = path.join(repoDir, 'backend')
const composeFile = path.join(repoDir, 'deploy', 'docker-compose.dev.yml')
const embedDir = path.join(backendDir, 'web', 'dist')

export const ADMIN_LOGIN = 'e2e-admin'
export const ADMIN_PASSWORD = 'e2e-admin-password-1'

const isWin = process.platform === 'win32'
const npm = isWin ? 'npm.cmd' : 'npm'

function sh(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {},
): string {
  return execFileSync(cmd, args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    input: opts.input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: isWin && cmd.endsWith('.cmd'),
    maxBuffer: 64 * 1024 * 1024,
  })
}

function compose(...args: string[]): string {
  return sh('docker', ['compose', '-f', composeFile, ...args])
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number }
      srv.close(() => resolve(port))
    })
  })
}

async function waitReady(url: string, proc: ChildProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`tipd exited early with code ${proc.exitCode}`)
    try {
      const res = await fetch(`${url}/readyz`)
      if (res.ok) return
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`tipd did not become ready at ${url}`)
}

/** Removes the SPA copy from the embed directory, keeping the tracked .gitkeep. */
function cleanEmbedDir(): void {
  if (!existsSync(embedDir)) return
  for (const name of readdirSync(embedDir)) {
    if (name !== '.gitkeep') rmSync(path.join(embedDir, name), { recursive: true, force: true })
  }
}

function killTree(proc: ChildProcess): void {
  if (proc.exitCode !== null || proc.pid === undefined) return
  try {
    if (isWin) sh('taskkill', ['/PID', String(proc.pid), '/T', '/F'])
    else proc.kill('SIGTERM')
  } catch {
    // already gone
  }
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  // Pointing the suite at an already running server skips the whole stack.
  if (process.env.E2E_BASE_URL) {
    if (!process.env.E2E_ADMIN_LOGIN || !process.env.E2E_ADMIN_PASSWORD) {
      throw new Error('E2E_BASE_URL requires E2E_ADMIN_LOGIN and E2E_ADMIN_PASSWORD')
    }
    return async () => {}
  }

  const runId = randomBytes(4).toString('hex')
  const dbName = `e2e_${runId}`
  const redisDb = 1 + (Number.parseInt(runId, 16) % 15)
  const pgUser = process.env.POSTGRES_USER ?? 'tip'
  const pgPassword = process.env.POSTGRES_PASSWORD ?? 'tip_dev_password'
  const pgPort = process.env.POSTGRES_PORT ?? '5432'
  const redisPassword = process.env.REDIS_PASSWORD ?? 'redis_dev_password'
  const redisPort = process.env.REDIS_PORT ?? '6379'
  const work = mkdtempSync(path.join(tmpdir(), 'tip-e2e-'))
  let server: ChildProcess | undefined
  let dbCreated = false
  let redisUsed = false

  const teardown = async (): Promise<void> => {
    if (server) killTree(server)
    if (redisUsed) {
      try {
        compose(
          'exec',
          '-T',
          'redis',
          'redis-cli',
          '-a',
          redisPassword,
          '--no-auth-warning',
          '-n',
          String(redisDb),
          'FLUSHDB',
        )
      } catch {}
    }
    if (dbCreated) {
      try {
        compose(
          'exec',
          '-T',
          'postgres',
          'psql',
          '-U',
          pgUser,
          '-d',
          'postgres',
          '-c',
          `DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`,
        )
      } catch {}
    }
    cleanEmbedDir()
    // The binary can stay locked for a moment on Windows after the kill.
    for (let i = 0; i < 10; i++) {
      try {
        rmSync(work, { recursive: true, force: true })
        break
      } catch {
        await new Promise((r) => setTimeout(r, 300))
      }
    }
  }

  try {
    compose('up', '-d', '--wait')

    sh(npm, ['run', 'build'], { cwd: frontendDir })
    cleanEmbedDir()
    mkdirSync(embedDir, { recursive: true })
    cpSync(path.join(frontendDir, 'dist'), embedDir, { recursive: true })
    const bin = path.join(work, isWin ? 'tipd.exe' : 'tipd')
    sh('go', ['build', '-o', bin, './cmd/tipd'], { cwd: backendDir })
    // The binary embeds the SPA at compile time, so the copy is not needed any more.
    cleanEmbedDir()

    compose(
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      pgUser,
      '-d',
      'postgres',
      '-c',
      `CREATE DATABASE ${dbName}`,
    )
    dbCreated = true
    redisUsed = true

    const port = await freePort()
    const internalPort = await freePort()
    // "localhost" rather than 127.0.0.1: WebKit only accepts the Secure refresh cookie on a localhost origin.
    const baseUrl = `http://localhost:${port}`
    const dataDir = path.join(work, 'data')
    mkdirSync(dataDir, { recursive: true })
    server = spawn(bin, ['serve'], {
      cwd: work,
      env: {
        ...process.env,
        HTTP_ADDR: `127.0.0.1:${port}`,
        INTERNAL_ADDR: `127.0.0.1:${internalPort}`,
        DATABASE_URL: `postgres://${pgUser}:${pgPassword}@127.0.0.1:${pgPort}/${dbName}?sslmode=disable`,
        REDIS_URL: `redis://:${redisPassword}@127.0.0.1:${redisPort}/${redisDb}`,
        DATA_DIR: dataDir,
        ALLOWED_ORIGINS: baseUrl,
        JWT_ACCESS_SECRET: 'e2e-access-secret-0123456789abcdef0123',
        JWT_REFRESH_SECRET: 'e2e-refresh-secret-fedcba9876543210fedc',
        PASSWORD_PEPPER: 'e2e-password-pepper-0123456789abcdef01',
        BOOTSTRAP_ADMIN_LOGIN: ADMIN_LOGIN,
        BOOTSTRAP_ADMIN_PASSWORD: ADMIN_PASSWORD,
        FORCE_PASSWORD_CHANGE: 'false',
        SWAGGER_ENABLED: 'false',
        LOKI_URL: 'off',
        MIN_FREE_DISK_MB: '1',
        LOG_LEVEL: 'warn',
      },
      stdio: ['ignore', 'ignore', 'inherit'],
      windowsHide: true,
    })
    await waitReady(baseUrl, server, 60_000)

    process.env.E2E_BASE_URL = baseUrl
    process.env.E2E_ADMIN_LOGIN = ADMIN_LOGIN
    process.env.E2E_ADMIN_PASSWORD = ADMIN_PASSWORD
  } catch (err) {
    await teardown()
    throw err
  }

  return async () => {
    delete process.env.E2E_BASE_URL
    await teardown()
  }
}

// `node e2e/stack/stack.ts` keeps the stack up for manual exploration until Ctrl+C.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const down = await globalSetup()
  console.log(`tipd: ${process.env.E2E_BASE_URL}  login: ${ADMIN_LOGIN} / ${ADMIN_PASSWORD}`)
  const stop = () => void down().then(() => process.exit(0))
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  setInterval(() => {}, 1 << 30)
}
