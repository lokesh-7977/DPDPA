# DPDPA Consent Platform

Consent management and compliance platform for India's **Digital Personal Data Protection Act, 2023**
and the **DPDP Rules, 2025**, with a tamper-evident audit trail.

Organizations use it to record consent, answer Data Principal rights requests, handle breaches,
keep their records of processing, find personal data in their code, websites and cloud, and prove
compliance to auditors and customers.

> **Status:** backend (API + worker) is feature-complete for the current roadmap. The web app in
> `apps/web` is still the starter page plus a typed API client; product screens come later.

---

## What it does

| Area | Highlights |
|---|---|
| Consent | Purposes, Data Principals, consent grant / withdraw, versioned multilingual notices (s.5, r.3), guardian consent for children and persons with disability (s.9, r.10–11), Consent Manager registry |
| Rights | Public request form with email verification, 1–90 day deadlines, access / correction / erasure / nomination (s.11–14, r.14) |
| Breaches | 72-hour Board report clock, initial and detailed Board notices, notices to affected people (s.8(6), r.7) |
| Records | ROPA, DPIA, AI system register, vendors and contracts, cross-border transfers, retention and automatic erasure (s.8(7), r.8) |
| Discovery | HoundDog code scans (CI upload or GitHub App), website audit and security checks on verified domains, AWS and Google Workspace inventory |
| Programme | Control catalog, evidence with independent approval, policies from templates, risk register, training, access reviews, 0–100 compliance score with PDF report |
| Sharing | Public trust center, security questionnaires, read-only auditor rooms, read-only MCP server for AI assistants |
| Platform | Multi-tenant with row-level security, hash-chained append-only audit log, Postgres job queue |

Full feature map and end-to-end flows: [`docs/features.md`](docs/features.md).

---

## Tech stack

- **Monorepo:** Turborepo 2, pnpm 11 workspaces, Node ≥ 24, TypeScript 7 (TypeScript only, no `.js`)
- **API:** Hono 4 on Node, `@hono/zod-openapi` (Zod 4), OpenAPI at `/openapi.json`, Scalar docs at `/docs`
- **Database:** PostgreSQL with Drizzle ORM; embedded PGlite when `DATABASE_URL` is unset (dev / test only)
- **Auth:** email + password (argon2id), short-lived JWT access token + rotating httpOnly refresh cookie, org API keys (`dpk_…`) with scopes
- **Email:** Resend (production), console / memory drivers for dev and tests
- **Web:** Next.js 16, React 19, typed Hono RPC client
- **Tests:** `node:test` via `tsx --test` against in-memory PGlite

---

## Getting started

### Prerequisites

- Node.js 24 or newer
- pnpm 11 (`corepack enable` picks the version from `package.json`)
- PostgreSQL is optional for local work: without `DATABASE_URL` the API uses embedded PGlite in `apps/api/.pglite`

### Setup

```sh
pnpm install

# API configuration: copy the example and fill it in
cp apps/api/.env.example apps/api/.env
# Minimum for local dev: JWT_SECRET (at least 32 characters)

pnpm --filter api db:migrate        # create tables
pnpm --filter api seed:catalog      # load DPDPA / DPDP Rules / AIGIS catalog
pnpm --filter api create-super-admin you@example.com "Your Name"
```

### Run

```sh
pnpm --filter api dev       # API on http://localhost:3002 (docs at /docs)
pnpm --filter api worker    # background jobs (emails, scans, reports, digests)
pnpm --filter web dev       # web app on http://localhost:3000
```

`pnpm dev` starts every app at once.

### Key settings

All settings are validated at startup in `apps/api/src/config/env.ts`; `apps/api/.env.example`
documents each one.

| Variable | Needed | Purpose |
|---|---|---|
| `JWT_SECRET` | always | Signs access tokens (≥ 32 chars; production: real random secret, ≥ 43) |
| `DATABASE_URL` | production | Postgres connection; unset = embedded PGlite |
| `AUDIT_HMAC_KEY` | production | Hashes IP / user agent before they enter the audit trail (own secret, not `JWT_SECRET`) |
| `CREDENTIAL_VAULT_KEY` | production | AES-256-GCM key for stored scan / integration secrets |
| `MAIL_DRIVER`, `RESEND_API_KEY`, `MAIL_FROM` | production | Outgoing email (`resend` required in production) |
| `APP_URL`, `CORS_ORIGINS` | as needed | Links in emails, allowed browser origins |
| `RATE_LIMIT_STORE` | production | `postgres` so limits are shared across instances |
| `STORAGE_DRIVER`, `STORAGE_DIR` | as needed | Where uploaded files and reports are kept |
| `GITHUB_APP_*`, `GITHUB_WEBHOOK_SECRET` | optional | GitHub App for managed code scans |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | optional (worker) | AWS inventory connector |

Production refuses to start with unsafe settings (missing secrets, non-https `APP_URL` or
CORS origins, in-memory rate limits / storage, or a database login that could bypass
row-level security). See [`docs/operations.md`](docs/operations.md).

---

## Commands

Run from the repo root. `--filter` targets one workspace.

| Task | Command |
|---|---|
| Dev (all / api / web) | `pnpm dev` · `pnpm --filter api dev` · `pnpm --filter web dev` |
| Worker | `pnpm --filter api worker` (production: `start:worker`) |
| Lint | `pnpm lint` |
| Typecheck | `pnpm check-types` |
| Format | `pnpm format` |
| Test (API) | `pnpm --filter api test` |
| Build | `pnpm build` |
| Start built API | `pnpm --filter api start` |
| Migrate / new migration | `pnpm --filter api db:migrate` · `pnpm --filter api db:generate` |
| Database browser | `pnpm --filter api db:studio` |
| Seed compliance catalog | `pnpm --filter api seed:catalog` |
| Create super admin | `pnpm --filter api create-super-admin <email> "<Name>"` |
| Rotate vault key | `pnpm --filter api rotate-vault-key` |
| Dependency audit | `pnpm audit` |

---

## Repository layout

```text
apps/
  api/                Hono API + worker (port 3002)
    catalog/          compliance catalog content (JSON, versioned)
    drizzle/          SQL migrations
    src/
      config/         env validation, logger
      domain/         pure business rules (no I/O)
      db/             Drizzle client, schemas per module, row-level security scope
      repositories/   queries only
      services/       business logic, transactions, audit recording, external adapters
      jobs/           background job handlers
      http/           routes, request/response schemas, middleware
      scripts/        CLI scripts
      test/           end-to-end tests
  web/                Next.js app (port 3000)
  docs/               Next.js docs app (port 3001, template)
packages/
  ui/                 shared React components
  eslint-config/      shared ESLint configs
  typescript-config/  shared tsconfigs
docs/
  features.md         feature map and flows
  operations.md       operations runbook
  integrations/       customer guides (CI code scans, cloud, GitHub App, MCP)
  plans/              implementation plans
  health/             codebase health reports
```

Backend layers are enforced by ESLint: `http → services → repositories → db`, and `domain`
imports nothing above it.

---

## Documentation

- [`docs/features.md`](docs/features.md): what the platform does and how the flows connect
- [`docs/operations.md`](docs/operations.md): deployment checks, row-level security, key rotation, health
- [`docs/integrations/hounddog-ci.md`](docs/integrations/hounddog-ci.md): upload code scans from GitHub, GitLab, Bitbucket or Jenkins
- [`docs/integrations/cloud.md`](docs/integrations/cloud.md): AWS and Google Workspace connectors
- [`docs/integrations/github-app.md`](docs/integrations/github-app.md): GitHub App for managed scans
- [`docs/integrations/mcp.md`](docs/integrations/mcp.md): connect an AI assistant over MCP
- [`CLAUDE.md`](CLAUDE.md): detailed module reference and coding conventions
- API reference: run the API and open `http://localhost:3002/docs`

---

## Contributing

- Work happens on the `dev` branch; `main` receives reviewed changes only.
- Every state change goes through a service transaction that writes an audit entry; audit
  entries never contain personal data.
- Schema changes: edit `apps/api/src/db/schemas/<module>`, run `db:generate`, commit the SQL;
  never edit an applied migration.
- Never commit secrets or `.env` files.
