# TIP Web: project conventions

Web version of TIP, an internal tool for contest operators: projects, participant tables, ticket images, real-time collaboration, admin/worker roles.
**The design is fixed and lives in `docs/` (in Russian). Start with `docs/README.md`, then read the documents relevant to your task.** If the docs and your task disagree, follow the task and report the discrepancy; do not silently redesign.

## Hard environment limits (shape every decision)
Production server: 2 vCPU, **2 GB RAM, 10 GB HDD**. Keep memory and disk small, avoid heavy dependencies, no speculative abstractions.

## Stack
Backend: Go 1.27 (module `github.com/pavel-cpp/tip_website/backend`), `net/http` + chi, coder/websocket, `database/sql` + pgx stdlib (no ORM), goose migrations, zerolog, Prometheus client, go-redis, golang-jwt (HS256), argon2id.
Frontend: Vite + React + TypeScript (strict), TanStack Query/Virtual, React Router, Biome, Vitest, Playwright. Infra: Docker Compose, Caddy, PostgreSQL 18, Redis, Prometheus, Loki, Vector, Grafana.

## Language rules
* **All code comments, identifiers, log messages, error strings and commit messages are in English.**
* User-visible UI text lives only in i18n dictionaries (`ru`, `uz`); never hard-code UI strings in components.
* Documentation in `docs/` stays in Russian.
* No emojis in code, comments or commits. Comments explain *why*, not *what*; no commented-out code.

## Backend architecture (Clean Architecture: handler -> service -> repository)
`backend/internal/` has exactly: `domain` (entities, permissions, errors; stdlib only), `service` (business logic + interfaces in `ports.go`; imports only `domain`),
`handler` (http, ws; calls only `service`), `repository` (postgres, redis, blobfs, memory; imports only `domain` and `platform`), `platform` (config, logging, metrics, db, security, imaging, sheets).
Rules: `service` never imports `repository`/`handler`/`platform`; `handler` never calls `repository`; `service`/`repository` do not log (return wrapped errors, `handler` logs once);
authorization uses `Actor.Can(perm)` from JWT claims, no DB lookups per request; time and IDs go through `Clock`/`IDGen` interfaces; SQL is plain parameterized SQL.
Never log personal data (participant names/phones, passwords, tokens). Wiring is manual in `cmd/tipd/main.go` (no DI framework).

## Frontend rules
Animate only `transform`/`opacity`, respect `prefers-reduced-motion`, use motion/colour tokens from the design system, keep the initial JS bundle small (see `docs/06-frontend.md`).
Access token lives in memory only; refresh via httpOnly cookie; one shared refresh across tabs (`navigator.locks`).

## Git workflow
* Work only inside your own worktree/branch. **Never push. Never touch files owned by another stream** (ownership is stated in your task); if you need a change there, report it.
* Commit small logical units with Conventional Commit subjects in English (`feat(auth): ...`, `test(domain): ...`, `chore(ci): ...`). Every commit message ends with:
  `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`
* Do not edit `docs/` unless your task says so; list doc discrepancies in your final report instead.

## Quality gates (a task is done only when all pass)
Backend (from `backend/`): `go build ./...`, `go vet ./...`, `go test -race ./...`, `golangci-lint run` (when the config exists).
Frontend (from `frontend/`): `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`.
Tests that need Docker (testcontainers) must **skip cleanly** when Docker is not available (the daemon may be down on the developer machine).

## Final report format
End your work with a short report: what was built (files/packages), commands run and their results, what is not done or deferred, discrepancies with `docs/`, and anything the next stream needs to know.

## Dev machine notes
Windows 11 + Git Bash. Go and `golangci-lint`, `goose`, `gopls` are in `~/go/bin`. Node LTS is installed via winget (may need a new shell for PATH). Docker Desktop may be stopped.
