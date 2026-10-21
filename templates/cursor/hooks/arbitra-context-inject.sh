#!/usr/bin/env bash
#
# arbitra-context-inject.sh — Cursor sessionStart hook.
#
# Prepends a short block to every session describing the case bound to the
# current branch (resolved via GET /api/cases/resolve, no
# local pointer file) so the agent never has to guess. Completely
# non-blocking: on any failure, emits an empty context so the session isn't
# poisoned with error text.
#
# Contract (https://cursor.com/docs/hooks):
#   stdin:  JSON { session_id, composer_mode, cwd, ... }
#   stdout: JSON { additional_context: "..." }
#   exit:   0

set -u

emit() {
  # $1 = raw markdown-ish string. Emit as JSON-escaped additional_context.
  local raw="${1:-}"
  local escaped
  escaped=$(printf '%s' "$raw" \
    | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' \
    | awk 'BEGIN{ORS="\\n"} {print}')
  # Trim trailing literal \n to keep output tight.
  escaped="${escaped%\\n}"
  printf '{"additional_context":"%s"}\n' "$escaped"
  exit 0
}

# 1. Load creds. Missing → best-effort: emit nothing rather than guess.
if [ -f .arbitra/.env ]; then
  # shellcheck disable=SC1091
  set -a
  . .arbitra/.env
  set +a
fi

if [ -z "${ARBITRA_URL:-}" ] || [ -z "${ARBITRA_TOKEN:-}" ] \
  || [ "${ARBITRA_TOKEN}" = "arb_paste_your_token_here" ] \
  || ! command -v curl >/dev/null 2>&1; then
  emit "## Arbitra
- case: (credentials not set — cannot resolve by branch)
- next: follow structuredContent.next_action on MCP tool responses; long-form contract in .arbitra/AGENTS.md"
fi

# 2. Resolve the current branch, then the case bound to (repository, branch)
# via the branch-keyed resolution endpoint — no local
# pointer file involved.
BRANCH=""
if command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  BRANCH=$(git branch --show-current 2>/dev/null || true)
fi
if [ -z "$BRANCH" ]; then
  emit "## Arbitra
- case: (detached HEAD or unknown branch — cannot resolve)
- next: follow structuredContent.next_action on MCP tool responses; long-form contract in .arbitra/AGENTS.md"
fi

# repository_id is the last two path segments of the git remote URL
# (org/repo), matching how create_case/detect_case_fields derive it —
# see .arbitra/CREATE-CASE.md Step 1.
REMOTE_URL=$(git remote get-url origin 2>/dev/null || true)
REPOSITORY_ID=$(printf '%s' "$REMOTE_URL" \
  | sed -E 's#^(https://[^/]+/|git@[^:]+:)##; s#\.git$##')
if [ -z "$REPOSITORY_ID" ]; then
  emit "## Arbitra
- case: (no git remote 'origin' — cannot resolve by branch)
- next: follow structuredContent.next_action on MCP tool responses; long-form contract in .arbitra/AGENTS.md"
fi

RESOLVE_RESPONSE=$(curl -sfL --connect-timeout 5 --max-time 10 \
  -H "Authorization: Bearer $ARBITRA_TOKEN" \
  -G --data-urlencode "repository_id=$REPOSITORY_ID" --data-urlencode "branch=$BRANCH" \
  "$ARBITRA_URL/api/cases/resolve" 2>/dev/null || true)

if [ -z "$RESOLVE_RESPONSE" ]; then
  emit ""
fi

CASE_ID=""
if command -v jq >/dev/null 2>&1; then
  CASE_ID=$(printf '%s' "$RESOLVE_RESPONSE" | jq -r '.case.case_id // empty' 2>/dev/null || true)
fi
if [ -z "$CASE_ID" ]; then
  emit "## Arbitra
- case: (none bound to branch '$BRANCH')
- next: run /create-case to start a case"
fi

# 3. Fetch the case.
RESPONSE=$(curl -sfL --connect-timeout 5 --max-time 10 \
  -H "Authorization: Bearer $ARBITRA_TOKEN" \
  "$ARBITRA_URL/api/cases/$CASE_ID" 2>/dev/null || true)

if [ -z "$RESPONSE" ]; then
  emit ""
fi

# 4. Parse status + pending_gate (jq preferred, fallback regex).
STATUS=""
PENDING_GATE=""
if command -v jq >/dev/null 2>&1; then
  STATUS=$(printf '%s' "$RESPONSE" | jq -r '.status // empty' 2>/dev/null || true)
  PENDING_GATE=$(printf '%s' "$RESPONSE" | jq -r '.pending_gate // empty' 2>/dev/null || true)
fi
if [ -z "$STATUS" ]; then
  STATUS=$(printf '%s' "$RESPONSE" \
    | grep -o '"status"[[:space:]]*:[[:space:]]*"[^"]*"' \
    | head -n1 \
    | sed -e 's/.*"status"[[:space:]]*:[[:space:]]*"//' -e 's/"$//')
fi
if [ -z "$PENDING_GATE" ]; then
  PENDING_GATE=$(printf '%s' "$RESPONSE" \
    | grep -o '"pending_gate"[[:space:]]*:[[:space:]]*"[^"]*"' \
    | head -n1 \
    | sed -e 's/.*"pending_gate"[[:space:]]*:[[:space:]]*"//' -e 's/"$//')
fi

if [ -z "$STATUS" ]; then
  emit ""
fi

PENDING_DISPLAY="${PENDING_GATE:-none}"

emit "## Arbitra
- case: $CASE_ID (branch: $BRANCH)
- status: $STATUS
- pending_gate: $PENDING_DISPLAY
- next: follow structuredContent.next_action on MCP tool responses; long-form contract in .arbitra/AGENTS.md"
