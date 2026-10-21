#!/usr/bin/env bash
set -euo pipefail

# Arbitra — Create Case from CLI
# Usage: ./scripts/arbitra-create-case.sh [--auto]
#
# Prerequisites:
#   ARBITRA_URL  — Base URL (default: http://localhost:3000)
#   ARBITRA_TOKEN — Bearer token, optional in demo mode. For CI / scripted use
#                  mint a service token via Settings → Connections → Advanced
#                  → Create CI service token. For human IDE use, prefer the
#                  unified Connect flow (token lives in the OS keychain — this
#                  shell script doesn't read the keychain, so set the env var
#                  here only when calling from a terminal session).
#
# This script collects git context, calls the detection API for smart defaults,
# and creates a case after user confirmation.

ARBITRA_URL="${ARBITRA_URL:-http://localhost:3000}"
AUTH_HEADER=""
if [ -n "${ARBITRA_TOKEN:-}" ]; then
  AUTH_HEADER="Authorization: Bearer $ARBITRA_TOKEN"
fi

# Dependency check — this script shells out to jq (payload building / response
# parsing) and curl (API calls) throughout. With `set -euo pipefail` a missing
# tool would otherwise kill the script mid-run with a cryptic
# "command not found", so fail up front with a clear message instead.
for tool in jq curl; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "arbitra-create-case: ERROR $tool not installed" >&2
    echo "  Install it first, e.g.: brew install $tool  /  apt-get install $tool" >&2
    exit 2
  fi
done

echo "==> Collecting git context..."

BRANCH=$(git branch --show-current 2>/dev/null || echo "")
REMOTE_URL=$(git remote get-url origin 2>/dev/null || echo "")
COMMIT_SHA=$(git rev-parse HEAD 2>/dev/null || echo "")
REPO_NAME=$(echo "$REMOTE_URL" | sed -E 's/.*[:/]([^/]+\/[^/.]+)(\.git)?$/\1/')

# Changed files relative to main/master
BASE_BRANCH="main"
git rev-parse --verify "$BASE_BRANCH" >/dev/null 2>&1 || BASE_BRANCH="master"
CHANGED_FILES=$(git diff "$BASE_BRANCH"..HEAD --name-only 2>/dev/null | head -50 | jq -R . | jq -s .)

# PR info (if gh CLI available)
PR_TITLE=""
PR_URL=""
if command -v gh &>/dev/null; then
  PR_TITLE=$(gh pr view --json title -q '.title' 2>/dev/null || echo "")
  PR_URL=$(gh pr view --json url -q '.url' 2>/dev/null || echo "")
fi

echo "  Branch:  $BRANCH"
echo "  Repo:    $REPO_NAME"
echo "  Commit:  ${COMMIT_SHA:0:8}"
[ -n "$PR_TITLE" ] && echo "  PR:      $PR_TITLE"
echo ""

# Step 2: Call detection API
echo "==> Detecting case fields..."
DETECT_PAYLOAD=$(jq -n \
  --arg branch "$BRANCH" \
  --arg remote_url "$REMOTE_URL" \
  --arg commit_sha "$COMMIT_SHA" \
  --arg pr_ref "$PR_URL" \
  --arg pr_title "$PR_TITLE" \
  --argjson changed_files "$CHANGED_FILES" \
  '{
    git_context: {
      branch: $branch,
      remote_url: $remote_url,
      commit_sha: $commit_sha,
      pr_ref: $pr_ref,
      pr_title: $pr_title
    },
    changed_files: $changed_files
  }')

DETECT_RESULT=$(curl -s -X POST "$ARBITRA_URL/api/cases/detect" \
  -H "Content-Type: application/json" \
  ${AUTH_HEADER:+-H "$AUTH_HEADER"} \
  -d "$DETECT_PAYLOAD")

CASE_TYPE=$(echo "$DETECT_RESULT" | jq -r '.case_type // "other"')
RISK_LEVEL=$(echo "$DETECT_RESULT" | jq -r '.risk_level // "medium"')
PRIORITY=$(echo "$DETECT_RESULT" | jq -r '.priority // "normal"')
TRACK=$(echo "$DETECT_RESULT" | jq -r '.validation_track // "direct"')
SUGGESTED_TITLE=$(echo "$DETECT_RESULT" | jq -r '.suggested_title // empty')
JIRA_REFS=$(echo "$DETECT_RESULT" | jq '.jira_refs // []')

TITLE="${PR_TITLE:-$SUGGESTED_TITLE}"
[ -z "$TITLE" ] && TITLE="$BRANCH"

echo ""
echo "  Proposed case:"
echo "  ─────────────────────────────────────"
echo "  Title:     $TITLE"
echo "  Type:      $CASE_TYPE"
echo "  Risk:      $RISK_LEVEL"
echo "  Priority:  $PRIORITY"
echo "  Track:     $TRACK"
echo "  Branch:    $BRANCH"
[ -n "$PR_URL" ] && echo "  PR:        $PR_URL"
[ "$JIRA_REFS" != "[]" ] && echo "  JIRA:      $JIRA_REFS"
echo "  ─────────────────────────────────────"
echo ""

# Step 3: Confirm
if [ "${1:-}" != "--auto" ]; then
  read -rp "Create this case? [Y/n] " CONFIRM
  if [[ "${CONFIRM:-Y}" =~ ^[Nn] ]]; then
    echo "Cancelled."
    exit 0
  fi
fi

# Step 4: Create the case
echo "==> Creating case..."
CREATE_PAYLOAD=$(jq -n \
  --arg title "$TITLE" \
  --arg description "Created from CLI. Branch: $BRANCH" \
  --arg source_ref "$PR_URL" \
  --arg project_id "${ARBITRA_PROJECT_ID:-proj_demo}" \
  --arg repository_id "$REPO_NAME" \
  --arg validation_track "$TRACK" \
  --arg risk_level "$RISK_LEVEL" \
  --arg priority "$PRIORITY" \
  --arg case_type "$CASE_TYPE" \
  --arg branch "$BRANCH" \
  --arg remote_url "$REMOTE_URL" \
  --arg commit_sha "$COMMIT_SHA" \
  --arg pr_ref "$PR_URL" \
  --argjson jira_refs "$JIRA_REFS" \
  '{
    title: $title,
    description: $description,
    source_type: "git",
    source_ref: $source_ref,
    project_id: $project_id,
    repository_id: $repository_id,
    validation_track: $validation_track,
    risk_level: $risk_level,
    priority: $priority,
    case_type: $case_type,
    jira_refs: $jira_refs,
    git_context: {
      branch: $branch,
      remote_url: $remote_url,
      commit_sha: $commit_sha,
      pr_ref: $pr_ref
    }
  }')

RESULT=$(curl -s -X POST "$ARBITRA_URL/api/cases" \
  -H "Content-Type: application/json" \
  ${AUTH_HEADER:+-H "$AUTH_HEADER"} \
  -d "$CREATE_PAYLOAD")

CASE_ID=$(echo "$RESULT" | jq -r '.case_id // empty')

if [ -n "$CASE_ID" ]; then
  echo ""
  echo "  Case created: $CASE_ID"
  echo "  URL: $ARBITRA_URL/cases/$CASE_ID"
  echo ""

  # Offer to export CASE_ID for subsequent commands
  echo "  To use this case ID in follow-up commands, run:"
  echo "    export CASE_ID=$CASE_ID"
  echo ""

  # No local pointer file to write — IDE agents resolve the case bound to
  # this branch via GET $ARBITRA_URL/api/cases/resolve?repository_id=...&branch=...
  # whenever they need it again.

  echo ""
  echo "  Next steps:"
  echo "    - export CASE_ID=$CASE_ID"
  echo "    - Transition to exploration: curl -s -X POST \"\$ARBITRA_URL/api/cases/\$CASE_ID/transition\" -H 'Content-Type: application/json' ${AUTH_HEADER:+-H '$AUTH_HEADER'} -d '{\"target_status\": \"exploration\"}'"
  echo "    - Or use IDE agent commands: /explore, /build, /review"
else
  echo "  ERROR: Failed to create case"
  echo "$RESULT" | jq .
  exit 1
fi
