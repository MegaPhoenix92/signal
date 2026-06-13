# Signal

Permissioned inbox intelligence for sales and product teams. Signal ingests Gmail/Outlook mailboxes, detects revenue and product signals, routes notifications, and exposes an admin console for launch readiness.

## Requirements

- Node.js **22+** (see `.nvmrc` and `package.json` `engines`)
- npm 10+

Optional for full local verification:

- Chrome/Chromium/Edge for browser route tests (`SIGNAL_CHROME_BIN`)
- PostgreSQL for external state-service + RLS drills

## Architecture

Signal runs as **four cooperating processes** in production:

| Process | Command | Default port | Role |
| --- | --- | --- | --- |
| **API** | `npm run api` | 8787 | HTTP API, OAuth callbacks, signed webhooks, mutations |
| **Web** | `npm run dev` / `npm run preview` | 5173 | Vite React SPA (hash routes: public, register, workspace, admin) |
| **Scheduler** | `npm run scheduler` | — | Job runner for provider validation, email sync, digests, billing webhooks |
| **State service** | `npm run state-service` | 8791 | Durable state storage (file or Postgres) with bearer auth |

Local development uses file-backed state (`data/signal-local.json`). Production moves durable state to the state service (`SIGNAL_BACKEND_MODE=external-service`) with Postgres and optional RLS.

Backend logic lives in `scripts/` (Node ESM `.mjs`). The React UI is in `src/`.

## Quick start (local)

```bash
nvm use          # Node 22
npm ci
npm run admin:bootstrap
npm run dev:local   # API + Vite together
```

Open `http://127.0.0.1:5173/#top`.

For API-only work:

```bash
npm run admin:bootstrap
npm run api
```

## Launch sequence

Use the admin CLI to move from local slice to production readiness:

```bash
# 1. Bootstrap local state from sample seed
npm run admin:bootstrap

# 2. Provider-by-provider launch evidence (Gmail, Outlook, email, Stripe, …)
npm run admin -- provider-launch --json

# 3. Go-live gate: blockers, required env, proof commands
npm run admin -- launch-gate --json

# 4. Production preflight with a filled env file
cp .env.production.example .env.production
npm run admin -- launch-gate --env-file ./.env.production --json
npm run admin -- provider-launch --env-file ./.env.production --json

# 5. Export and verify a launch evidence package
npm run admin -- launch-gate package ./signal-launch-evidence.json --env-file ./.env.production --json
npm run admin -- launch-gate verify-package ./signal-launch-evidence.json --json
```

## Testing

```bash
npm run lint              # ESLint over scripts/**
npm run typecheck         # TypeScript project references (src/)
npm run typecheck:scripts # Optional JS checkJs over scripts/ (noisy; not in CI)
npm run test:local        # Full local regression chain
```

`test:browser-routes` **skips** when no Chrome-compatible browser is found. Set `SIGNAL_CHROME_BIN` to run it locally or in CI (see `.github/workflows/ci.yml`).

Individual suites: `npm run test:api-security`, `npm run test:state-service`, `npm run test:critical-paths`, etc.

## Docker

Build and run the API image (file-backed state for a minimal smoke deploy):

```bash
docker build -t signal-api .
docker run --rm -p 8787:8787 -v "$(pwd)/data:/app/data" signal-api
```

For all four processes locally, use Compose:

```bash
docker compose up --build
```

Compose starts API (8787), static web (5173 → container 8080), scheduler, and state service (8791) with a shared `data/` volume. Bootstrap state first (`npm run admin:bootstrap`) or copy seed data into `data/` before bringing the stack up.

## Environment

- Local defaults: `SIGNAL_ALLOW_LOCAL_ACTOR=true`, `SIGNAL_ADMIN_STATE=data/signal-local.json`
- Production template: `.env.production.example`
- Token vault, JWKS auth, Stripe/email webhooks, and provider OAuth are configured via env — see admin `launch-gate` and `production-env` reports for the full list.