---
name: codebase-health
description: Full-repo health audit. Runs frontend, backend, security and test reviewers in parallel and writes a dated report to docs/health/YYYY-MM-DD.md with verdict, per-area health, Critical/High findings, trend and next tasks. Use for /codebase-health or when asked for an overall code-quality audit.
---

# Codebase health audit

Report-only. No agent edits code during this audit.

## 1. Gather context (yourself, before launching agents)

- Read `CLAUDE.md`.
- `git log --oneline -20`
- TODO/FIXME count: Grep `TODO|FIXME|HACK|XXX` across `apps/` and `packages/` (exclude `node_modules`, `dist`, `.next`) — record count and top files.
- Find the previous report: newest file in `docs/health/` (if any) — keep its verdict and findings for the trend.
- Today's date → report path `docs/health/YYYY-MM-DD.md` (append `-2`, `-3` if it exists).

## 2. Launch IN PARALLEL (single message, four Agent calls)

| Agent | Prompt |
|---|---|
| `frontend-reviewer` | Full frontend audit of `apps/web`, `apps/docs`, `packages/ui` using the frontend-review skill. Report only. |
| `backend-reviewer` | Full backend audit of `apps/api` using the backend-review skill. Report only. |
| `security-reviewer` | Full-repo security audit incl. `pnpm audit`. Report only. |
| `test-runner` | **Report-only mode: do NOT edit any file.** Run lint, typecheck, tests, build for all workspaces; report pass/fail per command. |

Pass any `$ARGUMENTS` focus (e.g. "focus on consents") to every agent.

## 3. Merge into `docs/health/YYYY-MM-DD.md`

```
# Codebase health — YYYY-MM-DD

**Overall:** 🟢 | 🟡 | 🔴 — one-sentence verdict

## Health by part
| Part | Health | Key issue |
|---|---|---|
| Frontend (web/docs/ui) | | |
| Backend (api) | | |
| Security | | |
| Tests & build | | |

## Critical / High findings (deduplicated)
| Sev | Location | Issue | Fix | Source |
|---|---|---|---|---|
| Critical | file:line | … | … | backend, security |

(Merge duplicates reported by several agents into one row; list all sources.)

## Checks
| Command | Result |
|---|---|

## Trend vs previous report (<date> or "first report")
- Verdict: 🟡 → 🟢
- Resolved: …
- New: …
- Still open: …
- TODO/FIXME: N (was M)

## Next 5 PR-sized tasks
1. **Title** — scope, files, acceptance criteria (≤ 1 day each, highest risk first)
2. …

## Medium/Low (summary)
- counts per area + notable items
```

Overall: 🔴 if any Critical or any failing check; 🟡 if any High; else 🟢.

## 4. Finish

- Print the verdict, the parts table and the 5 tasks in chat, with the report path.
- Offer: "Want me to turn these tasks into an implementation plan with superpowers writing-plans (saved to docs/plans/)?" Do not start without a yes.
