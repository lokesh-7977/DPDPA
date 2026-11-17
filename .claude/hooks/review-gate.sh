#!/usr/bin/env bash
# Stop hook: block finishing a turn until changed code has been reviewed.
# Exit 0 = allow stop. Exit 2 = block; stderr is fed back to Claude.
set -u

input="$(cat)"

# Already continuing because of this hook -> don't loop.
if printf '%s' "$input" | grep -Eq '"stop_hook_active"[[:space:]]*:[[:space:]]*true'; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

untracked="$(git ls-files --others --exclude-standard)"
if git rev-parse --verify -q HEAD >/dev/null; then
  tracked="$(git diff HEAD --binary 2>/dev/null)"
else
  tracked="$(git diff --cached --binary 2>/dev/null; git diff --binary 2>/dev/null)"
fi

if [ -z "$tracked" ] && [ -z "$untracked" ]; then
  exit 0
fi

hash_cmd() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256
  else cksum
  fi
}

# Fingerprint = tracked diff + every untracked file's path and contents.
hash="$(
  {
    printf '%s\n' "$tracked"
    printf '%s\n' "$untracked" | while IFS= read -r f; do
      [ -n "$f" ] || continue
      printf '== %s\n' "$f"
      [ -f "$f" ] && cat -- "$f"
    done
  } | hash_cmd | cut -d' ' -f1
)"

state=".claude/.last-review"
if [ -f "$state" ] && [ "$(cat "$state")" = "$hash" ]; then
  exit 0
fi

mkdir -p .claude
printf '%s\n' "$hash" > "$state"

echo "Code changed and has not been reviewed. Launch in parallel code-reviewer plus frontend-reviewer/backend-reviewer for their areas (and security-reviewer if auth/input/secrets changed), fix all Critical and High findings, run test-runner, then summarize what changed, review verdict, and test results." >&2
exit 2
