---
name: frontend-review
description: Checklist and report format for reviewing frontend code (Next.js/React in apps/web, apps/docs, packages/ui). Use when reviewing UI changes or auditing the frontend — covers correctness, data/state, structure, accessibility, performance, styling/UX and tests.
---

# Frontend review

Scope: `apps/web/**`, `apps/docs/**`, `packages/ui/**` (Next.js 16 App Router, React 19). Read-only: report, never edit.

## 1. Gather

- Changed files: `git diff HEAD --name-only` + `git ls-files --others --exclude-standard`, filtered to the scope above. For a full audit, review the whole scope.
- Read `CLAUDE.md` conventions first.
- Run checks (report results, don't fix):
  - `pnpm --filter web lint` / `pnpm --filter web check-types`
  - same for `docs` and `@repo/ui` if touched
  - `pnpm --filter web build` only for full audits (slow)

## 2. Checklist

### Correctness
- `useEffect`: complete deps, cleanup (subscriptions, timers, AbortController), no effect used for derived state or event handling.
- Lists have stable, unique `key`s (never array index for reorderable data).
- Every async view handles **loading, empty and error** states.
- Forms: controlled/uncontrolled used consistently, validation messages, disabled submit while pending, no double-submit, server errors surfaced.
- Server vs client components: `"use client"` only where needed; no server-only code/secrets in client components.

### Data & state
- One fetching layer: API calls go through `apps/web/lib/api.ts` (typed `hc<AppType>` client) — no ad-hoc `fetch` to the API.
- No duplicated state (derive instead of syncing copies); state lives at the lowest common owner.
- Types match the API: use `InferResponseType`/`InferRequestType`, no hand-written duplicates or `any`.
- No secrets in client env vars (`NEXT_PUBLIC_*` is public). Tokens not in `localStorage` if avoidable.

### Structure
- Small, single-purpose components; extract when > ~150 lines or multiple responsibilities.
- No business logic in JSX (move to hooks/helpers); no deeply nested ternaries.
- No dead code, unused exports, commented-out blocks, stray `console.log`.
- Shared primitives belong in `packages/ui`.

### Accessibility
- Real `<button>`/`<a>` (no clickable `div`s); links navigate, buttons act.
- Every input has a `<label>` (or `aria-label`); errors linked via `aria-describedby`.
- Meaningful `alt` on images (`alt=""` if decorative); `next/image` used.
- Keyboard: all interactive elements reachable, visible focus, focus managed in dialogs/menus.
- Color contrast ≥ 4.5:1 text; don't convey meaning by color alone.

### Performance
- No heavy work in render (sort/filter big arrays → `useMemo` or server); no new object/function props breaking memoized children unnecessarily.
- Long lists virtualized.
- Code splitting: `next/dynamic` for heavy, below-the-fold or client-only widgets.
- Bundle size: no whole-library imports (`lodash`, icon packs), prefer server components for static content.

### Styling / UX
- Use design tokens / CSS variables, not magic hex values and pixel soup.
- Responsive at phone width; no horizontal scroll.
- No layout shift: sized images, skeletons matching final layout, fonts via `next/font`.
- DPDPA UX: consent notices clear, withdrawal as easy as granting, language choice shown.

### Tests
- Components tested with Testing Library querying **by role/label/text**, not test IDs or class names.
- Critical flows (grant/withdraw consent) covered. Flag absence of a frontend test setup as a finding.

## 3. Report format

```
## Frontend review — <scope>

**Health:** 🟢 | 🟡 | 🔴

| Area | Status | Notes |
|---|---|---|
| Correctness | 🟢/🟡/🔴 | … |
| Data & state | | |
| Structure | | |
| Accessibility | | |
| Performance | | |
| Styling/UX | | |
| Tests | | |

### Findings
- [Critical] apps/web/app/page.tsx:42 — issue — fix
- [High] …
- [Medium] …
- [Low] …

### Checks
| Check | Result |
|---|---|
| lint | ✅ / ❌ (summary) |
| typecheck | |
| build | (skipped / ✅ / ❌) |

### Top 3 fixes
1. …
2. …
3. …
```

Severity guide: **Critical** = security leak, data loss, broken core flow. **High** = bug users will hit, a11y blocker, wrong data shown. **Medium** = maintainability/perf debt. **Low** = style/nits.
Health: 🔴 any Critical or failing check; 🟡 any High; else 🟢.
