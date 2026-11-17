---
description: Review uncommitted changes with code-reviewer plus area and security reviewers in parallel
---

Review the uncommitted changes in this repo. $ARGUMENTS

1. Run `git status --short`, `git diff HEAD --name-only` and `git ls-files --others --exclude-standard`. If nothing changed, say so and stop.
2. Classify changed files:
   - frontend: `apps/web/**`, `apps/docs/**`, `packages/ui/**`
   - backend: `apps/api/**`
   - security-relevant: auth/middleware, input schemas/validation, env/config, CORS/headers, uploads, payments, secrets, dependencies (`package.json`, lockfile)
3. In ONE message, launch in parallel:
   - `code-reviewer` (always)
   - `frontend-reviewer` if any frontend files changed
   - `backend-reviewer` if any backend files changed
   - `security-reviewer` if any security-relevant files changed
   Tell each agent the exact file list for its area.
4. Merge all reports into one list grouped by severity (Critical → High → Medium → Low/Nits). Deduplicate findings that point at the same file:line/issue and note which reviewers raised them.
5. Show: overall verdict (APPROVE / CHANGES NEEDED), per-reviewer health, merged findings as `file:line — issue — fix`, and check results.
6. **Ask me before fixing anything.** Suggest fixing Critical/High first.
