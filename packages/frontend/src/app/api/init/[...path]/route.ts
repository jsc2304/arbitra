import { NextRequest, NextResponse } from 'next/server';
import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { isLocalHost } from '@/lib/public-base-url';

export const dynamic = 'force-dynamic';

// Files that can be served via /api/init/<path>
// No auth required — these are public setup files needed before auth is configured.
const ALLOWED_FILES: Record<string, { repoPath: string; contentType: string }> = {
  'ARBITRA-AGENTS.md': { repoPath: 'templates/arbitra/AGENTS.md', contentType: 'text/markdown' },
  'AGENTS-LEGACY-TOOLS.md': { repoPath: 'templates/arbitra/AGENTS-LEGACY-TOOLS.md', contentType: 'text/markdown' },
  'CREATE-CASE.md': { repoPath: 'templates/arbitra/CREATE-CASE.md', contentType: 'text/markdown' },
  'arbitra-create-case.sh': { repoPath: 'templates/arbitra-create-case.sh', contentType: 'application/x-sh' },
  'AGENTS.md': { repoPath: 'templates/repo/AGENTS.md', contentType: 'text/markdown' },
  'PULL_REQUEST_TEMPLATE.md': { repoPath: 'templates/repo/PULL_REQUEST_TEMPLATE.md', contentType: 'text/markdown' },
  'coding-specialist.md': { repoPath: 'templates/cursor/agents/coding-specialist.md', contentType: 'text/markdown' },
  'implementation-reviewer.md': { repoPath: 'templates/cursor/agents/implementation-reviewer.md', contentType: 'text/markdown' },
  'cursor-commands/status.md': { repoPath: 'templates/cursor/commands/status.md', contentType: 'text/markdown' },
  'cursor-commands/create-case.md': { repoPath: 'templates/cursor/commands/create-case.md', contentType: 'text/markdown' },
  'cursor-commands/explore.md': { repoPath: 'templates/cursor/commands/explore.md', contentType: 'text/markdown' },
  'cursor-commands/build.md': { repoPath: 'templates/cursor/commands/build.md', contentType: 'text/markdown' },
  'cursor-commands/review.md': { repoPath: 'templates/cursor/commands/review.md', contentType: 'text/markdown' },
  'cursor-commands/request-changes.md': { repoPath: 'templates/cursor/commands/request-changes.md', contentType: 'text/markdown' },
  'cursor-hooks/hooks.json': { repoPath: 'templates/cursor/hooks.json', contentType: 'application/json' },
  'cursor-hooks/arbitra-context-inject.sh': { repoPath: 'templates/cursor/hooks/arbitra-context-inject.sh', contentType: 'application/x-sh' },
  'cursor-hooks/arbitra-evidence.sh': { repoPath: 'templates/cursor/hooks/arbitra-evidence.sh', contentType: 'application/x-sh' },
};

// Try multiple candidate roots — the standalone Next.js server may run from
// a nested directory, so process.cwd() alone is not reliable.
const ROOT_CANDIDATES = [
  process.cwd(),                    // /app in Docker (WORKDIR)
  join(process.cwd(), '..', '..'),  // if cwd is packages/frontend
  '/app',                           // Docker absolute fallback
];

async function resolveFile(repoPath: string): Promise<string | null> {
  for (const root of ROOT_CANDIDATES) {
    const full = join(/*turbopackIgnore: true*/ root, repoPath);
    try {
      await access(full);
      return readFile(/*turbopackIgnore: true*/ full, 'utf-8');
    } catch {
      // try next candidate
    }
  }
  return null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  const filePath = path.join('/');

  // Serve init.sh — the bootstrapping script rewritten to use curl from this server
  if (filePath === 'init.sh') {
    const envUrl =
      process.env['ARBITRA_PUBLIC_BASE_URL'] ?? process.env['ARBITRA_URL'] ?? process.env['NEXT_PUBLIC_APP_URL'];
    let baseUrl = '';
    if (envUrl) {
      baseUrl = envUrl.replace(/\/+$/, '');
    } else {
      const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? '';
      const proto = request.headers.get('x-forwarded-proto') ?? (isLocalHost(host) ? 'http' : 'https');
      if (host) {
        const derived = `${proto}://${host}`;
        try {
          const parsed = new URL(derived);
          // Only allow http/https and reject suspicious hostnames
          if (
            (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
            /^[a-zA-Z0-9._:-]+$/.test(parsed.host)
          ) {
            baseUrl = `${parsed.protocol}//${parsed.host}`;
          }
        } catch {
          // Invalid URL from headers — leave baseUrl empty (safe fallback)
        }
      }
    }

    const script = generateInitScript(baseUrl);
    return new NextResponse(script, {
      status: 200,
      headers: {
        'Content-Type': 'application/x-sh',
        'Content-Disposition': 'inline; filename="arbitra-init.sh"',
        'Cache-Control': 'no-cache',
      },
    });
  }

  // Serve allowed static files
  const entry = ALLOWED_FILES[filePath];
  if (!entry) {
    return NextResponse.json({ error: { message: 'Not found' } }, { status: 404 });
  }

  const content = await resolveFile(entry.repoPath);
  if (!content) {
    return NextResponse.json(
      { error: { message: 'File not found on server', path: entry.repoPath, cwd: process.cwd() } },
      { status: 404 },
    );
  }
  return new NextResponse(content, {
    status: 200,
    headers: {
      'Content-Type': entry.contentType,
      'Cache-Control': 'public, max-age=300',
    },
  });
}

function generateInitScript(baseUrl: string): string {
  // The script detects its own origin when piped via curl, but we embed a
  // fallback so it also works when downloaded and run locally.
  return `#!/usr/bin/env bash
set -euo pipefail

# Arbitra — Repository Init Script
#
# Sets up any Git repository for use with Arbitra:
#   - Common: .arbitra/ directory, AGENTS.md, case-spec.json, .env template
#   - Per-IDE: Cursor rules+skill+hooks, Claude Code MCP+slash commands,
#     or Codex CLI MCP TOML
#
# Usage:
#   curl -sL ARBITRA_URL/api/init/init.sh | bash -s -- <project_id>
#   curl -sL ARBITRA_URL/api/init/init.sh | bash -s -- --ide claude-code <project_id>
#   curl -sL ARBITRA_URL/api/init/init.sh | bash       # interactive
#
# IDE values: cursor (default) | claude-code (alias: cc) | codex | all
# Backward compatible: omitting --ide preserves today's cursor-only behaviour.
#
# No prerequisites besides curl, git, and bash. Works in Git Bash on Windows.

ARBITRA_BASE="\${ARBITRA_URL:-${baseUrl}}"

usage() {
  cat <<USAGE
Arbitra Init — set up a repository for the Arbitra control plane.

Usage:
  curl -sL $ARBITRA_BASE/api/init/init.sh | bash -s -- [--ide IDE] [--url URL] <project_id>
  curl -sL $ARBITRA_BASE/api/init/init.sh | bash       # interactive

Arguments:
  <project_id>          Required. Arbitra project ID (e.g. proj_1774441281766).

Options:
  --ide IDE             Which IDE to wire up. One of:
                          cursor       Cursor rules + skill + hooks (default)
                          claude-code  Claude Code MCP server + slash commands
                                       (alias: cc)
                          codex        Codex CLI MCP server (prints TOML to paste)
                          all          All three
                        If omitted: prompts when stdin is a tty, otherwise cursor.
  --url URL             Arbitra base URL. Overrides ARBITRA_URL env var.
  -h, --help            Show this help and exit.
  --version             Print script version and exit.

Environment:
  ARBITRA_URL           Same as --url.

Tokens are no longer written to .arbitra/.env — the MCP server obtains them
via the unified Connect flow and stores them in your OS keychain. Run the
first MCP tool call from your IDE and click the printed link to authenticate.
USAGE
}

# --- Argument parsing ------------------------------------------------------
# Note: --token was removed in the device-flow migration. Tokens now live in
# the OS keychain, populated by the unified Connect flow. The flag is silently
# accepted for backward compatibility (so old curl-pipe-bash invocations don't
# crash) but the value is ignored — a one-line warning is printed.
IDE=""
PROJECT_ID=""
CLI_URL=""

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --version)
      echo "arbitra-init.sh (server-generated)"
      exit 0
      ;;
    --ide)
      if [ $# -lt 2 ]; then
        echo "ERROR: --ide requires a value" >&2
        exit 2
      fi
      IDE="$2"
      shift 2
      ;;
    --ide=*)
      IDE="\${1#--ide=}"
      shift
      ;;
    --token)
      # Deprecated: silently warn and accept either form (with or without
      # value). If the next arg looks like a flag or is absent, treat as a
      # bare flag — never exit non-zero just because the legacy value is
      # missing. Tokens are now keychain-managed via the Connect flow.
      echo "  NOTE: --token is deprecated and ignored. Tokens are now stored in your OS keychain via the Connect flow." >&2
      if [ $# -ge 2 ] && [ "\${2#-}" = "$2" ]; then
        shift 2
      else
        shift
      fi
      ;;
    --token=*)
      echo "  NOTE: --token is deprecated and ignored. Tokens are now stored in your OS keychain via the Connect flow." >&2
      shift
      ;;
    --url)
      if [ $# -lt 2 ]; then
        echo "ERROR: --url requires a value" >&2
        exit 2
      fi
      CLI_URL="$2"
      shift 2
      ;;
    --url=*)
      CLI_URL="\${1#--url=}"
      shift
      ;;
    --)
      shift
      break
      ;;
    -*)
      echo "ERROR: Unknown option: $1" >&2
      echo "Run with --help for usage." >&2
      exit 2
      ;;
    *)
      if [ -z "$PROJECT_ID" ]; then
        PROJECT_ID="$1"
        shift
      else
        echo "ERROR: Unexpected extra argument: $1" >&2
        exit 2
      fi
      ;;
  esac
done

# CLI overrides for env vars (CLI wins).
if [ -n "$CLI_URL" ]; then
  ARBITRA_BASE="$CLI_URL"
fi

# Validate ARBITRA_BASE — it gets interpolated into JSON (.claude/settings.json)
# and TOML (codex config) without escaping. Restrict to a conservative ASCII
# allowlist that is safe in both formats: http(s) scheme + hostname/path chars.
if ! printf '%s' "$ARBITRA_BASE" | grep -qE '^https?://[A-Za-z0-9._:/-]+$'; then
  echo "ERROR: ARBITRA_URL must look like http(s)://host[:port][/path] using only [A-Za-z0-9._:/-] (got: $ARBITRA_BASE)" >&2
  exit 2
fi

# --- Interactive prompt helpers -------------------------------------------
#
# When invoked via \`curl … | bash\`, stdin is the pipe, not the terminal —
# so plain \`read\` hangs or gets an empty string. We detect an interactive
# TTY across three channels (stdin, stdout, /dev/tty) and route every prompt
# through /dev/tty explicitly. Fall back to non-interactive behaviour cleanly
# when no TTY is available (CI, Docker build, etc).
ARBITRA_HAS_TTY=0
if [ -r /dev/tty ] && [ -w /dev/tty ]; then
  ARBITRA_HAS_TTY=1
elif [ -t 0 ] || [ -t 1 ]; then
  ARBITRA_HAS_TTY=1
fi

# prompt_line <prompt> <default> → echoes the user's answer (or default) to stdout.
prompt_line() {
  local prompt="$1"
  local default_value="\${2:-}"
  local answer=""
  if [ "$ARBITRA_HAS_TTY" -eq 1 ] && [ -r /dev/tty ]; then
    # shellcheck disable=SC2162
    printf "%s" "$prompt" > /dev/tty
    read answer < /dev/tty || answer=""
  fi
  if [ -z "$answer" ]; then
    answer="$default_value"
  fi
  printf "%s" "$answer"
}

# Note: the hidden-input prompt and token-masking helpers were removed
# alongside the token-resolution block. The Connect flow no longer asks
# for credentials at the shell — they're minted in the browser and stored
# in the OS keychain.

# --- Project ID resolution -------------------------------------------------
if [ -z "$PROJECT_ID" ]; then
  # Try to reuse existing case-spec.json first.
  if [ -f .arbitra/case-spec.json ]; then
    EXISTING_PID="$(grep -E '"project_id"' .arbitra/case-spec.json 2>/dev/null | sed -E 's/.*"project_id"[[:space:]]*:[[:space:]]*"([^"]+)".*/\\1/' | head -n1)"
    if [ -n "$EXISTING_PID" ]; then
      if [ "$ARBITRA_HAS_TTY" -eq 1 ]; then
        REPLY_PID="$(prompt_line "  Existing project_id $EXISTING_PID. Reuse? [Y/n]: " "Y")"
        case "$REPLY_PID" in
          n|N|no|No|NO) PROJECT_ID="" ;;
          *) PROJECT_ID="$EXISTING_PID" ;;
        esac
      else
        PROJECT_ID="$EXISTING_PID"
      fi
    fi
  fi

  # Still empty → prompt, or hard-fail non-interactively.
  if [ -z "$PROJECT_ID" ]; then
    if [ "$ARBITRA_HAS_TTY" -eq 1 ]; then
      PROJECT_ID="$(prompt_line "  Project ID (proj_...): " "")"
    fi
  fi
fi

if [ -z "$PROJECT_ID" ]; then
  echo ""
  echo "  Arbitra Init"
  echo "  ============"
  echo ""
  echo "  Usage: curl -sL $ARBITRA_BASE/api/init/init.sh | bash -s -- <project_id>"
  echo ""
  echo "  Example: curl -sL $ARBITRA_BASE/api/init/init.sh | bash -s -- proj_1774441281766"
  echo ""
  echo "  The project_id comes from Arbitra Settings > Projects."
  echo "  If you don't have one yet, create a project first at:"
  echo "    $ARBITRA_BASE/settings"
  echo ""
  exit 1
fi

# Check we're in a git repo
if ! git rev-parse --git-dir &>/dev/null; then
  echo "ERROR: Not inside a git repository. Run this from your project root."
  exit 1
fi

# --- IDE selection ---------------------------------------------------------
# Default = cursor (preserves today's curl-pipe-bash behaviour). Interactive
# 4-option prompt only when no flag was given AND a TTY is available.
if [ -z "$IDE" ]; then
  if [ "$ARBITRA_HAS_TTY" -eq 1 ]; then
    printf "\n  Which IDE are you setting up?\n" > /dev/tty
    printf "    1) cursor        (default — auto-loaded rules + skill + hooks)\n" > /dev/tty
    printf "    2) claude-code   (MCP server + slash commands)\n" > /dev/tty
    printf "    3) codex         (MCP TOML — paste into ~/.codex/config.toml)\n" > /dev/tty
    printf "    4) all\n\n" > /dev/tty
    CHOICE="$(prompt_line "  Choice [1-4, default 1]: " "1")"
    case "$CHOICE" in
      1|""|cursor) IDE="cursor" ;;
      2|cc|claude-code) IDE="claude-code" ;;
      3|codex) IDE="codex" ;;
      4|all) IDE="all" ;;
      *)
        echo "  WARN: invalid choice '$CHOICE' — defaulting to cursor"
        IDE="cursor"
        ;;
    esac
  else
    IDE="cursor"
  fi
fi

case "$IDE" in
  cc) IDE="claude-code" ;;
  cursor|claude-code|codex|all) ;;
  *)
    echo "ERROR: Invalid --ide value: '$IDE' (expected: cursor | claude-code | cc | codex | all)" >&2
    exit 2
    ;;
esac

echo ""
echo "  Arbitra Init"
echo "  ============"
echo "  Project ID: $PROJECT_ID"
echo "  IDE:        $IDE"
echo "  Repository: $(basename "$(pwd)")"
echo "  Server:     $ARBITRA_BASE"
echo ""

# Helper to download a file from the Arbitra server.
# --connect-timeout bounds TCP connect, --max-time bounds the whole transfer —
# without them a stalled server or cold-start can make the script hang forever.
download() {
  local name="$1"
  local dest="$2"
  echo "  Downloading $name..."
  if ! curl -sfL --connect-timeout 10 --max-time 30 "$ARBITRA_BASE/api/init/$name" -o "$dest"; then
    echo "  WARN: download $name failed (network error or server missing the file)"
    return 1
  fi
}

# Create .arbitra/ directory
mkdir -p .arbitra

# Download agent instructions — never stomp a locally customised copy.
# Mirrors the .cursor/hooks.json guard below: skip and print a one-line
# hint for a manual refresh instead of overwriting on re-run.
if [ ! -f .arbitra/AGENTS.md ]; then
  download "ARBITRA-AGENTS.md" ".arbitra/AGENTS.md"
else
  echo "  .arbitra/AGENTS.md already exists, skipping — fetch $ARBITRA_BASE/api/init/ARBITRA-AGENTS.md to refresh manually"
fi
if [ ! -f .arbitra/AGENTS-LEGACY-TOOLS.md ]; then
  download "AGENTS-LEGACY-TOOLS.md" ".arbitra/AGENTS-LEGACY-TOOLS.md"
else
  echo "  .arbitra/AGENTS-LEGACY-TOOLS.md already exists, skipping — fetch $ARBITRA_BASE/api/init/AGENTS-LEGACY-TOOLS.md to refresh manually"
fi
if [ ! -f .arbitra/CREATE-CASE.md ]; then
  download "CREATE-CASE.md" ".arbitra/CREATE-CASE.md"
else
  echo "  .arbitra/CREATE-CASE.md already exists, skipping — fetch $ARBITRA_BASE/api/init/CREATE-CASE.md to refresh manually"
fi

# --- case-spec.json ---------------------------------------------------
# First run: write the full template. Re-run: preserve user customisations
# (e.g. "\$schema", default_rule_sets, auto_detect) and only refresh the
# project_id field in place — same in-place-update spirit as the
# .arbitra/.env awk block below (portable, no jq dependency).
if [ ! -f .arbitra/case-spec.json ]; then
  cat > .arbitra/case-spec.json << EOF
{
  "version": "1.0",
  "project_id": "$PROJECT_ID",
  "case_creation": {
    "required_fields": ["title", "case_type", "validation_track", "risk_level", "priority"],
    "case_types": {
      "ticket_implementation": { "branch_patterns": ["^feat/", "^feature/"] },
      "bugfix": { "branch_patterns": ["^fix/", "^bugfix/", "^hotfix/"] },
      "refactoring": { "branch_patterns": ["^refactor/", "^chore/"] }
    }
  }
}
EOF
  echo "  Created .arbitra/case-spec.json (project_id: $PROJECT_ID)"
else
  awk -v pid="$PROJECT_ID" '
    /"project_id"[[:space:]]*:/ {
      sub(/"project_id"[[:space:]]*:[[:space:]]*"[^"]*"/, "\\"project_id\\": \\"" pid "\\"")
    }
    { print }
  ' .arbitra/case-spec.json > .arbitra/case-spec.json.tmp && mv .arbitra/case-spec.json.tmp .arbitra/case-spec.json
  echo "  Updated .arbitra/case-spec.json (project_id: $PROJECT_ID, other fields preserved)"
fi

# --- Project pin (.arbitra/.env) -----------------------------------------
# This script no longer writes an access token. Tokens are minted by the
# Connect flow and stored in your OS keychain (macOS Keychain / Windows
# Credential Manager / libsecret) when you first call an MCP tool from your
# IDE. The .env file only pins the server URL and the project id, both of
# which are public, repo-scoped values. See docs:
#   $ARBITRA_BASE/docs#access-tokens
#
# Write atomically (tmpfile + mv) so a partial write cannot leave a broken
# file. If the file already exists, preserve any user-added keys (custom
# env vars, legacy ARBITRA_TOKEN= lines, etc.) — only rewrite the two lines
# this script owns. Legacy ARBITRA_TOKEN= lines are left in place; the MCP
# server warns and ignores them.
if [ ! -f .arbitra/.env ]; then
  cat > .arbitra/.env.tmp << ENVFILE
# Arbitra project pin — personal per developer per repo, do NOT commit
# Generated by the Arbitra Connect flow. Re-run \\\`arbitra-mcp login\\\` to refresh.
ARBITRA_URL=$ARBITRA_BASE
ARBITRA_PROJECT_ID=$PROJECT_ID

# Tokens are stored in your OS keychain (macOS Keychain / Windows Credential
# Manager / libsecret) — never put a token in this file.
ENVFILE
  mv .arbitra/.env.tmp .arbitra/.env
  echo "  Created .arbitra/.env (project pin: $PROJECT_ID)"
else
  # Update the existing file in place: rewrite ARBITRA_URL= and
  # ARBITRA_PROJECT_ID= lines, preserve everything else the user may have
  # added. Uses awk so it works identically on GNU/BSD/Git Bash. Any
  # pre-existing ARBITRA_TOKEN= line is left untouched — the MCP server
  # (post-migration) prints a one-time warning and ignores it.
  awk -v url="$ARBITRA_BASE" -v pid="$PROJECT_ID" '
    BEGIN { saw_url=0; saw_pid=0 }
    /^ARBITRA_URL=/        { print "ARBITRA_URL=" url; saw_url=1; next }
    /^ARBITRA_PROJECT_ID=/ { print "ARBITRA_PROJECT_ID=" pid; saw_pid=1; next }
    { print }
    END {
      if (!saw_url) print "ARBITRA_URL=" url
      if (!saw_pid) print "ARBITRA_PROJECT_ID=" pid
    }
  ' .arbitra/.env > .arbitra/.env.tmp && mv .arbitra/.env.tmp .arbitra/.env
  echo "  Updated .arbitra/.env (project pin: $PROJECT_ID)"
fi

# Ensure per-developer state files are gitignored.
# .mcp.json is per-developer — paths embedded (npx absolute path) differ by
# machine. .arbitra/.env carries the project pin, which is repo-wide but
# also legacy ARBITRA_TOKEN= lines may be present from pre-Connect-flow
# installs; gitignoring keeps those out of version control.
if [ -f .gitignore ]; then
  if ! grep -q '.arbitra/.env' .gitignore; then
    echo '.arbitra/.env' >> .gitignore
    echo "  Added .arbitra/.env to .gitignore"
  fi
  if ! grep -q '.mcp.json' .gitignore; then
    echo '.mcp.json' >> .gitignore
    echo "  Added .mcp.json to .gitignore (per-developer paths)"
  fi
else
  printf '.arbitra/.env\n.mcp.json\n' > .gitignore
  echo "  Created .gitignore with .arbitra/.env and .mcp.json"
fi

# Download CLI script
download "arbitra-create-case.sh" "arbitra-create-case.sh"
chmod +x arbitra-create-case.sh

# --- Per-IDE setup helpers -------------------------------------------------

# Resolve absolute path of npx; fall back to bare 'npx' with a warning.
resolve_npx() {
  local p
  p="$(command -v npx 2>/dev/null || true)"
  if [ -z "$p" ]; then
    printf "npx"
  else
    printf "%s" "$p"
  fi
}

setup_cursor() {
  echo ""
  echo "  --- Cursor IDE integration ---"

  # Always create .cursor/ in the current project directory (git root).
  # Do NOT search parent directories — that would pollute a user's global ~/.cursor/.
  local CURSOR_ROOT
  CURSOR_ROOT="$(pwd)"

  # Cursor agents: coding specialist and implementation reviewer
  mkdir -p "$CURSOR_ROOT/.cursor/agents"
  download "coding-specialist.md" "$CURSOR_ROOT/.cursor/agents/coding-specialist.md"
  download "implementation-reviewer.md" "$CURSOR_ROOT/.cursor/agents/implementation-reviewer.md"
  echo "  Installed .cursor/agents/ (coding-specialist, implementation-reviewer)"

  # Cursor slash commands — /status, /create-case, /explore, /build, /review, /request-changes
  mkdir -p "$CURSOR_ROOT/.cursor/commands"
  for cmd in status create-case explore build review request-changes; do
    download "cursor-commands/$cmd.md" "$CURSOR_ROOT/.cursor/commands/$cmd.md"
  done
  echo "  Installed .cursor/commands/ (/status, /create-case, /explore, /build, /review, /request-changes)"

  # Cursor hooks — sessionStart context inject + afterFileEdit auto-evidence
  # (Cursor 1.7+). No preToolUse hook: Arbitra governs at merge time, never
  # at write time (ADR-0001) — there is nothing here to block a tool call.
  mkdir -p "$CURSOR_ROOT/.cursor/hooks"

  # hooks.json — never stomp a user-customised config. Print a banner
  # telling them how to merge the Arbitra block manually.
  if [ ! -f "$CURSOR_ROOT/.cursor/hooks.json" ]; then
    download "cursor-hooks/hooks.json" "$CURSOR_ROOT/.cursor/hooks.json"
    echo "  Installed .cursor/hooks.json (Arbitra hooks registered)"
  else
    echo "  .cursor/hooks.json already present, skipping — see server's /api/init/cursor-hooks/hooks.json to merge the Arbitra block manually"
  fi

  # Hook scripts — idempotent; overwrite is fine since they evolve with the server.
  download "cursor-hooks/arbitra-context-inject.sh" "$CURSOR_ROOT/.cursor/hooks/arbitra-context-inject.sh"
  download "cursor-hooks/arbitra-evidence.sh" "$CURSOR_ROOT/.cursor/hooks/arbitra-evidence.sh"
  chmod +x "$CURSOR_ROOT/.cursor/hooks/arbitra-context-inject.sh" \\
    "$CURSOR_ROOT/.cursor/hooks/arbitra-evidence.sh"
  echo "  Installed .cursor/hooks/ (arbitra-context-inject, arbitra-evidence)"

  mkdir -p "$CURSOR_ROOT/.cursor/skills/arbitra"
  cat > "$CURSOR_ROOT/.cursor/skills/arbitra/SKILL.md" << 'SKILL'
---
name: arbitra
description: Autonomous case lifecycle management for Arbitra. Use when creating cases, exploring code, building features, submitting code reviews, checking case status, registering evidence, or driving a case through the full governance workflow. Triggers on any mention of cases, reviews, findings, evidence, decisions, or the Arbitra control plane.
---

# Arbitra Skill

You are an autonomous agent operating inside a repository governed by Arbitra. When this skill triggers, you ACT — do not just explain what Arbitra is or list commands.

**CRITICAL:** Read .arbitra/AGENTS.md FIRST — it is the canonical reference for all commands, API calls, lifecycle phases, and hard rules. This skill file is a quick-start summary; AGENTS.md is authoritative.

## Bootstrap (do this FIRST, every time)

Arbitra governs merges, not writes (ADR-0001) — there is no pre-write gate, so implementation may proceed regardless of case state below.

1. Read .arbitra/.env — parse ARBITRA_URL and ARBITRA_PROJECT_ID.
   - Tokens live in your OS keychain, not in .env — the MCP server resolves them automatically. If the MCP server returns a "Connect" markdown link, follow that link to authenticate.
2. Read .arbitra/case-spec.json — note the project_id.
3. Resolve the case bound to the current branch — no local pointer file:
   - GET $ARBITRA_URL/api/cases/resolve?repository_id=<owner/repo>&branch=$(git branch --show-current)
   - No case bound: next action is **Create Case** (optional — tracked work only).

## Action routing

| User says | Action |
|-----------|--------|
| "create a case" | **Create Case** (see AGENTS.md /create-case) |
| "explore", "analyze" | **Explore** (see AGENTS.md /explore) |
| "build", "start build" | **Build** (see AGENTS.md /build) |
| "review", "submit for review" | **Review** (see AGENTS.md /review) |
| "status" | **Status Check** (see AGENTS.md /status) |
| "drive the case", "full lifecycle" | Execute Create → Explore → Build → Review → Wrap-up in sequence |

If the user just says "/arbitra" without specifics: do a **Status Check**. If no case exists, offer to **Create Case**.

## Quick reference

- **All API calls:** the Arbitra MCP server attaches the Bearer credential automatically from the OS keychain. Direct HTTP calls (e.g. for scripts) still need Authorization: Bearer <token> + Content-Type: application/json.
- **Transitions:** POST $ARBITRA_URL/api/cases/$CASE_ID/transition with {"target_status": "..."}
- **Runs:** POST $ARBITRA_URL/api/runs with {"case_id": "$CASE_ID", "run_type": "..."}
- **Comments:** POST $ARBITRA_URL/api/cases/$CASE_ID/comments with {"body": "..."}
- **Evidence:** POST $ARBITRA_URL/api/cases/$CASE_ID/evidence

## Hard rules

- NEVER create a case without user confirmation
- NEVER skip exploration — it documents the approach
- NEVER fabricate evidence or findings
- NEVER merge a PR without explicit user confirmation
- After every pipeline signal (build_run, etc.), always check actual case status before suggesting next step

For complete details on each phase, slash commands, error handling, and the full lifecycle flow, read .arbitra/AGENTS.md.
SKILL
  echo "  Installed .cursor/skills/arbitra/SKILL.md"
}

setup_claude_code() {
  echo ""
  echo "  --- Claude Code integration ---"

  mkdir -p .claude

  local NPX_PATH
  NPX_PATH="$(resolve_npx)"
  if [ "$NPX_PATH" = "npx" ]; then
    echo "  WARN: npx not found on PATH; using bare 'npx' in MCP config." >&2
    echo "        If Claude Code reports ENOENT, set the absolute path manually." >&2
  fi

  # Derive the bin dir holding the user's npx (and therefore node) so we can
  # inject it into the MCP subprocess PATH. Claude Code launched from the
  # macOS app bundle (or as a Cursor extension) spawns MCP servers with a
  # stripped environment — without this, npx finds itself but cannot exec
  # node. Hardcoding /usr/local/node/bin (the system .pkg path) breaks
  # Homebrew, nvm, volta, fnm, and Linux users; deriving it locally works
  # for whatever node the user actually has.
  local NPX_BIN_DIR
  if [ "$NPX_PATH" = "npx" ]; then
    NPX_BIN_DIR=""
  else
    NPX_BIN_DIR="$(dirname "$NPX_PATH")"
  fi
  local MCP_PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  if [ -n "$NPX_BIN_DIR" ] && [ "$NPX_BIN_DIR" != "/usr/local/bin" ] && [ "$NPX_BIN_DIR" != "/usr/bin" ]; then
    MCP_PATH="$NPX_BIN_DIR:$MCP_PATH"
  fi

  # .mcp.json at project root — Claude Code's canonical project-level MCP
  # config location (the Cursor-side MCP lives separately under
  # .cursor/, so the two never collide). Safe-create-only (no jq dep): if
  # the file already exists we leave it alone and print the snippet to
  # merge manually, avoiding stomping any other MCP servers the developer
  # has wired up.
  #
  # ARBITRA_TOKEN is no longer embedded — the MCP server retrieves its
  # credential from the OS keychain on startup, populated by the unified
  # Connect flow on the first tool call.
  #
  # ARBITRA_URL is no longer embedded either — .arbitra/.env is the single
  # source of truth for the host (written above by this script; the MCP
  # server discovers it by walking up from its cwd, and the Cursor hooks /
  # shell gate source the same file). An env-level ARBITRA_URL would
  # override the .env and silently re-pin the repo to whatever instance ran
  # the init — exactly the dev/prod drift this layout avoids.
  if [ -f .mcp.json ]; then
    echo "  .mcp.json already present — not modifying."
    if grep -q '"ARBITRA_URL"' .mcp.json; then
      echo ""
      echo "  WARNING: your existing .mcp.json sets ARBITRA_URL in an env block."
      echo "  That value OVERRIDES .arbitra/.env and can pin this repo to the wrong"
      echo "  Arbitra instance. Remove the \\"ARBITRA_URL\\" line from .mcp.json —"
      echo "  the host is read from .arbitra/.env (just written: $ARBITRA_BASE)."
      echo ""
    fi
    echo "  To wire the Arbitra MCP server, merge this into the file's mcpServers map:"
    echo ""
    echo "      \\"arbitra\\": {"
    echo "        \\"command\\": \\"$NPX_PATH\\","
    echo "        \\"args\\": [\\"-y\\", \\"arbitra-mcp\\"],"
    echo "        \\"env\\": {"
    echo "          \\"PATH\\": \\"$MCP_PATH\\""
    echo "        }"
    echo "      }"
    echo ""
  else
    cat > .mcp.json <<JSON
{
  "mcpServers": {
    "arbitra": {
      "command": "$NPX_PATH",
      "args": ["-y", "arbitra-mcp"],
      "env": {
        "PATH": "$MCP_PATH"
      }
    }
  }
}
JSON
    echo "  Created .mcp.json with arbitra MCP server (PATH derived from local node install: $MCP_PATH)"
    echo "  The Arbitra host is NOT embedded — it comes from .arbitra/.env ($ARBITRA_BASE)."
  fi

  # Lifecycle slash commands — parity with .cursor/commands/*.md.
  # The cursor-commands/*.md files served from this route are byte-identical
  # for both IDEs, so we reuse the same URLs and just write to .claude/commands/.
  # Idempotent: skip any file that already exists to preserve local edits.
  mkdir -p .claude/commands
  for cmd in status create-case explore build review request-changes; do
    if [ -f ".claude/commands/$cmd.md" ]; then
      echo "  .claude/commands/$cmd.md already exists, skipping"
    else
      download "cursor-commands/$cmd.md" ".claude/commands/$cmd.md"
    fi
  done

  # /arbitra umbrella slash command — Claude-Code-specific (no Cursor twin).
  if [ -f .claude/commands/arbitra.md ]; then
    echo "  .claude/commands/arbitra.md already exists, skipping"
  else
    cat > .claude/commands/arbitra.md <<'CCARBCMD'
---
description: Drive the Arbitra case lifecycle for the current change.
---

You are operating in a repository governed by Arbitra. Read \`.arbitra/AGENTS.md\`
and follow the lifecycle exactly as defined there. Arbitra governs merges, not
writes (ADR-0001) — there is no pre-write gate, so implementation may proceed
regardless of case state. Before acting on the request:

1. Confirm the MCP server is reachable. Tokens live in your OS keychain,
   populated by the Connect flow on the first tool call — if a tool call
   returns a Connect link, open it and confirm before retrying.
2. Resolve the case bound to the current branch — \`GET $ARBITRA_URL/api/cases/resolve?repository_id=...&branch=...\`
   (no local pointer file), or create one with user confirmation if none exists.

Then take the action implied by the user's request:

- "create a case" / "register this change" -> Create Case
- "explore" / "analyze" -> Explore
- "build" -> Build (signal \`build_run\` when done)
- "review" -> Review (post diff, handle findings)
- "status" / bare \`/arbitra\` -> Status Check; offer Create Case if none exists
- "drive the case" / "full lifecycle" -> run Create -> Explore -> Build ->
  Review -> Wrap-up in sequence, asking for confirmation only at Create and
  before merging the PR.

Use the Arbitra MCP tools (\`mcp__arbitra__*\`) when available — the server
attaches the Bearer credential automatically from the OS keychain. For direct
HTTP scripting, retrieve the token from the keychain (\`arbitra-mcp doctor\`
prints its location) and pass it as \`Authorization: Bearer <token>\`. Field
schemas, transition rules, evidence expectations, and findings triage all
live in \`.arbitra/AGENTS.md\` — that is the source of truth, not this file.
CCARBCMD
    echo "  Installed .claude/commands/arbitra.md (/arbitra umbrella command)"
  fi
}

setup_codex() {
  echo ""
  echo "  --- Codex CLI integration ---"

  local NPX_PATH
  NPX_PATH="$(resolve_npx)"

  # Same PATH-injection logic as setup_claude_code: when the IDE GUI spawns
  # the MCP subprocess with a stripped environment, npx still needs PATH to
  # find node. Derive the bin dir from the user's local npx so this works
  # for Homebrew, nvm, volta, fnm, system node — no hardcoded path.
  local NPX_BIN_DIR
  if [ "$NPX_PATH" = "npx" ]; then
    NPX_BIN_DIR=""
  else
    NPX_BIN_DIR="$(dirname "$NPX_PATH")"
  fi
  local MCP_PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  if [ -n "$NPX_BIN_DIR" ] && [ "$NPX_BIN_DIR" != "/usr/local/bin" ] && [ "$NPX_BIN_DIR" != "/usr/bin" ]; then
    MCP_PATH="$NPX_BIN_DIR:$MCP_PATH"
  fi

  echo ""
  echo "  Codex CLI reads MCP servers from ~/.codex/config.toml (HOME, not project-local)."
  echo "  This script does NOT modify your home directory. Paste this block into"
  echo "  ~/.codex/config.toml (create the file if it doesn't exist):"
  echo ""
  echo "  -------- 8< -------- copy below this line --------"
  cat <<TOML
[mcp_servers.arbitra]
command = "$NPX_PATH"
args = ["-y", "arbitra-mcp"]
env = { PATH = "$MCP_PATH" }
TOML
  echo "  -------- >8 -------- copy above this line --------"
  echo ""
  echo "  The Arbitra host is NOT embedded in the TOML — the MCP server reads it"
  echo "  from each repo's .arbitra/.env (this repo: $ARBITRA_BASE), so one global"
  echo "  Codex entry serves repos on different Arbitra instances. If your existing"
  echo "  ~/.codex/config.toml block still sets ARBITRA_URL in env, remove it —"
  echo "  it would override every repo's .arbitra/.env."
  echo ""
  echo "  The first MCP tool call will print a one-time link to connect this"
  echo "  project. Open the link, click Confirm, and you're done — no tokens"
  echo "  to copy."
  echo ""

  # Drop a project-local breadcrumb for the next person who clones.
  mkdir -p .codex
  if [ -f .codex/README-arbitra.md ]; then
    echo "  .codex/README-arbitra.md already exists, skipping"
  else
    cat > .codex/README-arbitra.md <<'CODEXMD'
# Codex CLI + Arbitra

Codex CLI does not read project-local config. The MCP server for this repo is
configured in your home directory: \`~/.codex/config.toml\`.

If you have not configured it yet, re-run the Arbitra init script with
\`--ide codex\`. The TOML block to paste into \`~/.codex/config.toml\` is
printed to stdout.

After editing \`~/.codex/config.toml\`, restart Codex.
CODEXMD
    echo "  Wrote .codex/README-arbitra.md (breadcrumb for future contributors)"
  fi
}

# --- IDE dispatch ----------------------------------------------------------
case "$IDE" in
  cursor)       setup_cursor ;;
  claude-code)  setup_claude_code ;;
  codex)        setup_codex ;;
  all)
    setup_cursor
    setup_claude_code
    setup_codex
    ;;
esac

# --- Root AGENTS.md: create-or-append with marker block ---
# Marker tags let us replace the block idempotently on re-init without touching
# anything the user wrote outside the markers.
ARBITRA_MARKER_START='<!-- ARBITRA-GATE-START -->'
ARBITRA_MARKER_END='<!-- ARBITRA-GATE-END -->'

if [ ! -f AGENTS.md ]; then
  download "AGENTS.md" "AGENTS.md"
  echo "  Created AGENTS.md with Arbitra gate block"
elif grep -qF "$ARBITRA_MARKER_START" AGENTS.md && grep -qF "$ARBITRA_MARKER_END" AGENTS.md; then
  # Block present → replace its body in place. Fetch fresh server template,
  # extract the block, and splice it back into the existing file.
  ARBITRA_TMP_TEMPLATE=$(mktemp)
  ARBITRA_TMP_BLOCK=$(mktemp)
  ARBITRA_TMP_MERGED=$(mktemp)
  download "AGENTS.md" "$ARBITRA_TMP_TEMPLATE"
  # Extract marker block (inclusive) from the template.
  awk -v s="$ARBITRA_MARKER_START" -v e="$ARBITRA_MARKER_END" '
    $0 ~ s { inside=1 }
    inside { print }
    $0 ~ e { inside=0 }
  ' "$ARBITRA_TMP_TEMPLATE" > "$ARBITRA_TMP_BLOCK"
  # Splice: copy AGENTS.md verbatim, replace everything between the markers
  # (inclusive) with the freshly downloaded block.
  awk -v s="$ARBITRA_MARKER_START" -v e="$ARBITRA_MARKER_END" -v block="$ARBITRA_TMP_BLOCK" '
    BEGIN { skipping=0 }
    $0 ~ s {
      skipping=1
      while ((getline line < block) > 0) print line
      close(block)
      next
    }
    skipping && $0 ~ e { skipping=0; next }
    !skipping { print }
  ' AGENTS.md > "$ARBITRA_TMP_MERGED"
  mv "$ARBITRA_TMP_MERGED" AGENTS.md
  rm -f "$ARBITRA_TMP_TEMPLATE" "$ARBITRA_TMP_BLOCK"
  echo "  Updated Arbitra gate block inside existing AGENTS.md (markers preserved)"
else
  # No markers → append the block to the end with a leading blank line.
  ARBITRA_TMP_TEMPLATE=$(mktemp)
  ARBITRA_TMP_BLOCK=$(mktemp)
  download "AGENTS.md" "$ARBITRA_TMP_TEMPLATE"
  awk -v s="$ARBITRA_MARKER_START" -v e="$ARBITRA_MARKER_END" '
    $0 ~ s { inside=1 }
    inside { print }
    $0 ~ e { inside=0 }
  ' "$ARBITRA_TMP_TEMPLATE" > "$ARBITRA_TMP_BLOCK"
  # Ensure the existing file ends with a newline before we append.
  if [ -s AGENTS.md ] && [ "$(tail -c 1 AGENTS.md | wc -l)" -eq 0 ]; then
    printf '\n' >> AGENTS.md
  fi
  printf '\n' >> AGENTS.md
  cat "$ARBITRA_TMP_BLOCK" >> AGENTS.md
  rm -f "$ARBITRA_TMP_TEMPLATE" "$ARBITRA_TMP_BLOCK"
  echo "  Appended Arbitra gate block to existing AGENTS.md"
fi

# --- Global CLI install (arbitra-mcp binary for terminal use) ---------------
# Installs arbitra-mcp from npm so 'arbitra-mcp doctor' / 'arbitra-mcp login'
# work in any shell. The same package powers the MCP server invoked via
# 'npx -y arbitra-mcp' in the IDE configs above.
echo ""
echo "==> Installing arbitra-mcp CLI globally..."
if ! command -v npm &>/dev/null; then
  echo "  SKIP: npm not found — cannot install globally."
  echo "        Once npm is available, install manually:"
  echo "          npm install -g arbitra-mcp"
else
  if npm install -g arbitra-mcp >/dev/null 2>&1; then
    if command -v arbitra-mcp &>/dev/null; then
      echo "  OK — arbitra-mcp installed. Run anytime: arbitra-mcp doctor"
    else
      GLOBAL_BIN="\$(npm prefix -g 2>/dev/null)/bin"
      echo "  Installed but 'arbitra-mcp' not found on PATH."
      echo "  Add this to your shell profile (.zshrc / .bashrc), then restart your terminal:"
      echo "    export PATH=\\"\$GLOBAL_BIN:\\$PATH\\""
      echo "  Then verify with: arbitra-mcp doctor"
    fi
  else
    echo "  WARN: npm install -g arbitra-mcp failed — run manually if needed:"
    echo "          npm install -g arbitra-mcp"
  fi
fi

# --- GitHub PR template (only if .github/ already exists; never overwrite) ---
if [ -d .github ]; then
  if [ ! -f .github/PULL_REQUEST_TEMPLATE.md ]; then
    download "PULL_REQUEST_TEMPLATE.md" ".github/PULL_REQUEST_TEMPLATE.md"
    echo "  Installed .github/PULL_REQUEST_TEMPLATE.md"
  else
    echo "  .github/PULL_REQUEST_TEMPLATE.md already exists, skipping"
  fi
else
  echo "  .github/ not present, skipping PR template (not auto-creating)"
fi

echo ""
echo "  Files written:"
echo ""
echo "  .arbitra/"
echo "    AGENTS.md             — IDE agent instructions (canonical reference)"
echo "    AGENTS-LEGACY-TOOLS.md — Pre-2.1.0 tool aliases (historical record)"
echo "    CREATE-CASE.md        — Case creation guide"
echo "    case-spec.json        — Project config (project_id: $PROJECT_ID)"
echo ""

if [ "$IDE" = "cursor" ] || [ "$IDE" = "all" ]; then
  echo "  .cursor/"
  echo "    hooks.json                          — Cursor hooks config (context inject + evidence)"
  echo "    hooks/arbitra-context-inject.sh     — sessionStart hook (injects case context)"
  echo "    hooks/arbitra-evidence.sh           — afterFileEdit hook (auto file_edit evidence)"
  echo "    skills/arbitra/SKILL.md             — Auto-triggered lifecycle skill"
  echo "    agents/coding-specialist.md         — Primary implementation agent"
  echo "    agents/implementation-reviewer.md   — Post-implementation review agent"
  echo "    commands/                           — /status /create-case /explore /build /review /request-changes"
  echo ""
fi

if [ "$IDE" = "claude-code" ] || [ "$IDE" = "all" ]; then
  echo "  Root:"
  echo "    .mcp.json                           — Claude Code project MCP config (mcpServers.arbitra, with PATH)"
  echo "  .claude/"
  echo "    commands/arbitra.md                 — /arbitra umbrella slash command"
  echo "    commands/                           — /status /create-case /explore /build /review /request-changes"
  echo ""
fi

if [ "$IDE" = "codex" ] || [ "$IDE" = "all" ]; then
  echo "  .codex/"
  echo "    README-arbitra.md                   — Breadcrumb pointing at ~/.codex/config.toml"
  echo ""
fi

echo "  Root:"
echo "    AGENTS.md                           — Agent contract (marker block inserted/updated)"
echo "    arbitra-create-case.sh              — CLI script for case creation"
if [ -d .github ]; then
  echo "    .github/PULL_REQUEST_TEMPLATE.md    — PR template with Arbitra checklist"
fi
echo ""
echo "  Next steps:"
echo "    1. Open your IDE and call any Arbitra MCP tool (e.g. /status,"
echo "       /create-case, or 'list arbitra projects'). The first call prints"
echo "       a one-time link — click it to connect this project. No tokens"
echo "       to copy. No env vars to set."
echo ""

if [ "$IDE" = "cursor" ] || [ "$IDE" = "all" ]; then
  echo "    Cursor:"
  echo "      • Commit:  git add .arbitra/ .cursor/ AGENTS.md arbitra-create-case.sh .gitignore"
  if [ -d .github ]; then
    echo "                 git add .github/PULL_REQUEST_TEMPLATE.md"
  fi
  echo "      • The .cursor/ folder must sit at the workspace root that Cursor opens."
  echo "      • The Arbitra skill auto-triggers when you mention cases, reviews, or the workflow."
  echo "      • Agents available via @ mention: @coding-specialist, @implementation-reviewer."
  echo ""
fi

if [ "$IDE" = "claude-code" ] || [ "$IDE" = "all" ]; then
  echo "    Claude Code:"
  echo "      • Restart Claude Code after first install — no hot-reload for MCP config."
  echo "      • Works for the standalone CLI/macOS app AND the Claude Code Cursor extension."
  echo "      • PATH for the MCP subprocess is auto-injected from your local node install"
  echo "        (so Homebrew, nvm, volta, system node all work — no manual edit needed)."
  echo "      • If .mcp.json was already present, merge the printed JSON block manually."
  echo "      • Tokens are minted by the Connect flow on the first tool call — no manual paste."
  echo "      • Verify: in Claude Code, ask \\"list arbitra projects\\" — the MCP server should reply."
  echo "      • Slash commands: /arbitra (umbrella), /status, /create-case, /explore, /build, /review, /request-changes."
  echo "      • Migrating? Older versions of this script wrote mcpServers.arbitra into"
  echo "        .claude/settings.json. Claude Code does not read that file for MCP — delete"
  echo "        the stale arbitra entry there to avoid confusion."
  echo ""
fi

if [ "$IDE" = "codex" ] || [ "$IDE" = "all" ]; then
  echo "    Codex CLI:"
  echo "      • PASTE the TOML block printed above into ~/.codex/config.toml (create if missing)."
  echo "      • Tokens are minted by the Connect flow on the first tool call — no manual paste."
  echo "      • Restart Codex (no hot-reload for MCP config)."
  echo "      • Verify: ask Codex \\"list arbitra projects\\" — the MCP server should reply."
  echo ""
fi

echo "  Arbitra governs merges, not writes (ADR-0001) — no gate script to wire up,"
echo "  no client-side blocking of any kind. Nothing here stops an edit."
echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  Arbitra setup complete!                                     ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "  Project:     $PROJECT_ID"
echo "  Arbitra URL: $ARBITRA_BASE"
echo "  Verify:      arbitra-mcp doctor"
echo ""
`;
}
