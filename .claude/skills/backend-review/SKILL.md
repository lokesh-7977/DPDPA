---
name: backend-review
description: Checklist and report format for reviewing backend code (Hono API in apps/api — routes, services, repositories, Drizzle schema/migrations, auth). Use when reviewing API/auth/DB changes or auditing the backend.
---

# Backend review

Scope: `apps/api/**` (Hono + zod-openapi, Drizzle/Postgres, JWT). Read-only: report, never edit.

## 1. Gather

- Changed files: `git diff HEAD --name-only` + `git ls-files --others --exclude-standard`, filtered to `apps/api/`. Full audit = whole app.
- Read `CLAUDE.md` (layering rules, audit/PII rules).
- Run checks (report, don't fix):
  - `pnpm --filter api lint` (also enforces layer boundaries)
  - `pnpm --filter api check-types`
  - `pnpm --filter api test`
  - `pnpm --filter api build` for full audits

## 2. Checklist

### API design
- Consistent style: resource nouns, plural paths, correct verbs/status codes (201 create, 404, 409, 422), errors as `{ error, issues? }`.
- Validation at the boundary: every param/query/body has a Zod schema via `createRoute`; no unchecked `c.req.json()`.
- No leaked fields: responses go through DTO mappers in `http/schemas/`; no PII in audit payloads, no internal columns or stack traces.
- List endpoints paginated (cursor/limit with max) — no unbounded queries.
- Route documented in OpenAPI (summary, responses incl. errors, `security`).

### Auth
- `authenticate` middleware on **every** non-public route; public routes are intentional (`/health`, `/docs`, `/openapi.json`).
- Ownership checks (no IDOR): services call `assertCanActFor`/`assertRole` from `domain/policies.ts` for any record looked up by ID; list endpoints scope by caller.
- Passwords (if ever added) hashed with argon2/bcrypt; never stored/logged plain.
- Tokens: `exp` enforced, issuer verified, secret ≥ 32 chars from env, sensible TTL.

### Data layer
- No N+1 (queries in loops → join / `inArray`); flag loops of awaited queries.
- Indexes for every filter/order/FK column used in queries.
- Multi-statement writes in one transaction; audit row written in the **same** transaction; row locks (`FOR UPDATE`) where read-then-write races exist.
- Migrations: generated via drizzle-kit, reversible-in-spirit, no edits to applied migrations, no destructive change without a data plan; `audit_log` trigger intact.
- No string-built SQL: only Drizzle builders / `sql` tagged templates with params.

### Errors & ops
- Central handler (`http/error-handler.ts`) maps `DomainError` and PG codes; services throw `DomainError`, not HTTP errors.
- No swallowed errors (empty `catch`, ignored promises).
- Timeouts on outbound calls / DB pool settings.
- Structured logs, no secrets/PII/tokens in logs.
- Env config validated (`config/env.ts`) — no raw `process.env` reads elsewhere.

### Structure
- Layers respected: `http → services → repositories → db`; `domain` pure. Business rules in services, queries in repositories, HTTP shape in http.
- Small focused modules; no dead code.

### Performance
- Slow/side-effect work (emails, exports, webhooks) in background jobs, not request path.
- Caching where reads are hot and safe.
- Rate limits on auth and write endpoints.

### Tests
- Per route: success, validation failure (400), unauthorized (401), forbidden/ownership (403), not found/conflict where relevant.
- Audit invariants (append-only, chain verify) covered.

## 3. Report format

```
## Backend review — <scope>

**Health:** 🟢 | 🟡 | 🔴

| Area | Status | Notes |
|---|---|---|
| API design | 🟢/🟡/🔴 | … |
| Auth | | |
| Data layer | | |
| Errors & ops | | |
| Structure | | |
| Performance | | |
| Tests | | |

### Findings
- [Critical] apps/api/src/services/x.service.ts:42 — issue — fix
- [High] …
- [Medium] …
- [Low] …

### Checks
| Check | Result |
|---|---|
| lint | ✅ / ❌ |
| typecheck | |
| test | ✅ n/n / ❌ |
| build | (skipped / ✅ / ❌) |

### Top 3 fixes
1. …
2. …
3. …
```

Severity guide: **Critical** = auth bypass, IDOR, injection, PII leak, audit trail mutable, data loss. **High** = missing validation/ownership check, missing transaction, failing tests. **Medium** = N+1, missing index/pagination, weak tests. **Low** = style.
Health: 🔴 any Critical or failing check; 🟡 any High; else 🟢.
