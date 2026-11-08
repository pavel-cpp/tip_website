# Browser end-to-end tests (Playwright)

The suite drives the real application: the SPA built by Vite, embedded into a freshly compiled `tipd`
binary, backed by the dev Postgres and Redis.

## Run

```bash
task e2e                                   # everything, all projects
task e2e -- --project=chromium-desktop     # one browser profile
task e2e -- --headed --project=chromium-desktop auth      # watch it, one spec
task e2e -- --debug workspace              # Playwright inspector
task e2e -- --grep @realtime               # only the realtime specs
task e2e -- --update-snapshots=all visual  # refresh screenshots after an intended UI change
```

Without `task`: `cd frontend && npx playwright install chromium firefox webkit && npx playwright test`.
Docker Desktop must be running (the stack starts `deploy/docker-compose.dev.yml` if it is not up).
`go` and `node` must be on PATH. The HTML report is written to `e2e/.output/report`
(`npx playwright show-report e2e/.output/report`).

## What the stack script does (`stack/stack.ts`, Playwright global setup)

1. `docker compose -f deploy/docker-compose.dev.yml up -d --wait` (Postgres, Redis).
2. `npm run build`, copies `dist` to `backend/web/dist`, `go build` into a temp directory, removes the copy.
3. Creates database `e2e_<random>` and uses a random Redis database number.
4. Starts `tipd serve` on free ports with test secrets, `SWAGGER_ENABLED=false`, `FORCE_PASSWORD_CHANGE=false`,
   bootstrap admin `e2e-admin`.
5. After the run: kills the process tree, drops the database, flushes that Redis database, deletes the temp
   directory. The working tree stays clean (generated output is ignored by `e2e/.gitignore`).

`node e2e/stack/stack.ts` keeps the stack up for manual exploration until Ctrl+C.
To test an already running server set `E2E_BASE_URL`, `E2E_ADMIN_LOGIN`, `E2E_ADMIN_PASSWORD`
(the stack is then not started).

## Projects

`chromium-desktop`, `firefox-desktop`, `webkit-desktop` (stand-in for desktop Safari), `iphone-15` (WebKit
emulation) and `ipad`. Motion is reduced (`reducedMotion: 'reduce'`) and screenshots run with animations
disabled; tests wait on conditions, never on fixed delays.

## Layout

- `specs/` scenarios: `auth`, `temp-password`, `preferences`, `admin`, `projects`, `workspace`, `print`,
  `session`, `realtime` (`@realtime`), `visual`, `a11y`.
- `support/` API client (`api.ts`), page objects (`pages.ts`, `workspace.ts`), fixtures (`test.ts`),
  PNG generator (`png.ts`), screen list for visual and axe runs (`screens.ts`).
- `__snapshots__/<project>/...` screenshot baselines (Chromium and iPhone only, 1x scale).

UI strings are read from the real `ru`/`uz` dictionaries, so tests follow copy changes.

## Notes

- `@realtime` tests detect at runtime whether the SPA opens a WebSocket for a project and skip when the
  realtime client is absent.
- Accessibility findings (serious/critical) are printed and attached; set `E2E_AXE_STRICT=1` to fail on them.
- Known product bugs are written as `test.fixme` with a `BUG Q1-n` comment above them.
- Volatile regions (project list, user table, role list, system numbers) are masked in screenshots because
  other tests create data in parallel.
