#!/usr/bin/env bash
#
# arbitra-evidence.sh — Cursor afterFileEdit hook.
#
# Fire-and-forget evidence registration: every time Cursor edits a file
# that looks like real source (not infra / node_modules / dotfiles),
# post a file_edit evidence item to the active Arbitra case.
#
# Contract (https://cursor.com/docs/hooks):
#   stdin:  JSON { file_path, edits, ... }
#   stdout: ignored (observational hook)
#   exit:   0 (always — advisory only)
#
# Evidence shape — conforms to createEvidenceSchema in
# packages/shared/src/validation/evidence-validators.ts:
#   { case_id, type: "file_edit", source_type: "agent",
#     summary: "<basename>", artifact_ref: "<file_path>" }

set -u

# Always exit 0 — afterFileEdit is observational.
trap 'exit 0' EXIT

# 1. Load creds.
if [ -f .arbitra/.env ]; then
  # shellcheck disable=SC1091
  set -a
  . .arbitra/.env
  set +a
fi
[ -n "${ARBITRA_URL:-}" ] || exit 0
[ -n "${ARBITRA_TOKEN:-}" ] || exit 0
[ "${ARBITRA_TOKEN}" != "arb_paste_your_token_here" ] || exit 0
command -v curl >/dev/null 2>&1 || exit 0
command -v git >/dev/null 2>&1 || exit 0
command -v jq >/dev/null 2>&1 || exit 0

# 1a. Resolve the case bound to the current branch — no
# local pointer file. Nothing bound → nothing to attach evidence to.
BRANCH=$(git branch --show-current 2>/dev/null || true)
[ -n "$BRANCH" ] || exit 0
REMOTE_URL=$(git remote get-url origin 2>/dev/null || true)
REPOSITORY_ID=$(printf '%s' "$REMOTE_URL" \
  | sed -E 's#^(https://[^/]+/|git@[^:]+:)##; s#\.git$##')
[ -n "$REPOSITORY_ID" ] || exit 0
RESOLVE_RESPONSE=$(curl -sfL --connect-timeout 5 --max-time 10 \
  -H "Authorization: Bearer $ARBITRA_TOKEN" \
  -G --data-urlencode "repository_id=$REPOSITORY_ID" --data-urlencode "branch=$BRANCH" \
  "$ARBITRA_URL/api/cases/resolve" 2>/dev/null || true)
[ -n "$RESOLVE_RESPONSE" ] || exit 0
CASE_ID=$(printf '%s' "$RESOLVE_RESPONSE" | jq -r '.case.case_id // empty' 2>/dev/null || true)
[ -n "$CASE_ID" ] || exit 0

# 3. Extract file_path from stdin.
INPUT=$(cat)
FILE_PATH=""
if command -v jq >/dev/null 2>&1; then
  FILE_PATH=$(printf '%s' "$INPUT" | jq -r '.file_path // empty' 2>/dev/null || true)
fi
if [ -z "$FILE_PATH" ]; then
  FILE_PATH=$(printf '%s' "$INPUT" \
    | grep -o '"file_path"[[:space:]]*:[[:space:]]*"[^"]*"' \
    | head -n1 \
    | sed -e 's/.*"file_path"[[:space:]]*:[[:space:]]*"//' -e 's/"$//')
fi
[ -n "$FILE_PATH" ] || exit 0

# 4. Path filter — skip infra churn. Matches both absolute and relative paths.
#    We check against the basename path components, not the full path, so
#    /Users/.../arbitra-app/.arbitra/foo still matches ".arbitra/".
case "$FILE_PATH" in
  */.arbitra/*|.arbitra/*) exit 0 ;;
  */.cursor/*|.cursor/*) exit 0 ;;
  */.github/*|.github/*) exit 0 ;;
  */node_modules/*|node_modules/*) exit 0 ;;
  */dist/*|dist/*) exit 0 ;;
  */build/*|build/*) exit 0 ;;
esac

# Skip dotfiles at repo root (e.g. .gitignore, .env, .prettierrc).
# We only reject when the basename starts with a dot AND the path has no
# intermediate directory components beyond the repo root. A path like
# "src/.config/foo" is still allowed.
BASENAME=$(basename "$FILE_PATH")
case "$BASENAME" in
  .*)
    # Dotfile — allow only if nested under a non-dot parent dir.
    PARENT=$(dirname "$FILE_PATH")
    case "$PARENT" in
      .|./|"") exit 0 ;;
      */*) : ;;  # nested, let it through
      *) exit 0 ;;  # single-level parent that's the repo root itself
    esac
    ;;
esac

# 5. JSON-escape file_path and basename for the payload.
escape_json() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr -d '\n\r'
}
FP_ESC=$(escape_json "$FILE_PATH")
BN_ESC=$(escape_json "$BASENAME")

PAYLOAD=$(printf '{"type":"file_edit","source_type":"agent","summary":"cursor edit: %s","artifact_ref":"%s"}' \
  "$BN_ESC" "$FP_ESC")

# 6. Fire-and-forget. Swallow all errors.
curl -sfL -X POST \
  --connect-timeout 5 --max-time 10 \
  -H "Authorization: Bearer $ARBITRA_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  "$ARBITRA_URL/api/cases/$CASE_ID/evidence" \
  >/dev/null 2>&1 || true

exit 0
