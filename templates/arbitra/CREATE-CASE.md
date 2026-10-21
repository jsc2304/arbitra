# Arbitra — Create Case Instructions

> This document is a machine-readable guide for IDE agents (Claude Code, Cursor, Copilot, etc.)
> to create Arbitra cases from a developer's working directory.

## Overview

Arbitra manages AI-assisted code changes through a governed lifecycle. Every significant code change
should be tracked as a **Case** — Arbitra reviews it, evaluates rules, collects evidence, and
guides it to approval or rejection.

> **Case-First Principle**
> If the user asked you to both implement something and create a case in the same message,
> complete case creation first. Do not write code, edit files, or begin implementation until
> you have a confirmed case ID. Never run both in parallel.

> **One Case, One Branch**
> Every case gets its own fresh feature branch from `main`. If the current working branch
> already belongs to another non-terminal case (check Arbitra before creating), do NOT create
> a second case that reuses it — either finish the first case or start from `main` with a
> new branch. The backend rejects `in_build` transitions when two non-terminal cases share
> the same branch in the same repo. See `AGENTS.md` → "One Case, One Branch".

> **Branch guard: code-producing case types cannot use `main`/`master`.**
> `create_case` rejects case types that produce code changes
> (`ticket_implementation`, `bugfix`, `refactoring`, `security_review`)
> when `git_branch` is `main` or `master`. Create a feature branch first
> (`feat/<slug>`, `fix/<slug>`, `refactor/<slug>`, `security/<slug>`) and retry.
> `detect_case_fields` returns a `suggested_branch` slug when it sees this
> situation — use it as the proposed branch name.

**Method selection:** If you have the `arbitra` MCP server connected, use MCP tools (primary flow below). If not, use the curl commands in the [Appendix: Curl Fallback](#appendix-curl-fallback-no-mcp) at the bottom.

When a developer asks you to create a case (e.g., `/create-case`), follow this flow.

---

## Flow (MCP — Primary)

### Step 0: Locate the Repository

If your working directory is not a git repository (i.e., `git rev-parse --git-dir` fails),
find the Arbitra-managed repo in subdirectories:

```bash
REPO_DIR=$(find . -maxdepth 2 -name "case-spec.json" -path "*/.arbitra/*" -print -quit 2>/dev/null | sed 's|/.arbitra/case-spec.json||')
```

If found, use `$REPO_DIR` as the base for all paths and run git commands with `git -C "$REPO_DIR"`.
If not found, ask the user which directory contains the repository.
If you are already in a git repo, set `REPO_DIR="."` and proceed normally.

### Step 1: Collect Git Context

Run these commands silently to gather context (use `git -C "$REPO_DIR"` if `REPO_DIR` is not `.`):

```bash
# Repository info
git -C "$REPO_DIR" remote get-url origin     # -> remote_url
git -C "$REPO_DIR" branch --show-current     # -> branch
git -C "$REPO_DIR" rev-parse HEAD            # -> commit_sha

# What changed
git -C "$REPO_DIR" log main..HEAD --oneline  # -> commit summary
git -C "$REPO_DIR" diff main..HEAD --stat    # -> changed files overview
git -C "$REPO_DIR" diff main..HEAD --shortstat  # -> lines added/removed

# Open PR (if gh CLI available, run from repo dir)
cd "$REPO_DIR" && gh pr view --json url,title,body,labels 2>/dev/null  # -> PR info

# JIRA refs (extract from branch name and commits)
# Pattern: 2-10 uppercase letters followed by dash and digits (e.g., ARB-123)
```

**repository_id:** Extract from the git remote URL — take the last two path segments, strip `.git`.
Example: `https://github.com/org/repo.git` -> `org/repo`

### Step 2: Read the Case Spec

Read `$REPO_DIR/.arbitra/case-spec.json` in the repository root. It defines:
- Required fields for case creation
- Auto-detection heuristics for case_type, risk_level, priority
- File patterns that indicate risk levels
- Evidence requirements per track and risk level

### Step 3: Auto-Detect Fields

Call the MCP tool to auto-detect case fields from git context:

```
detect_case_fields(
  prompt: "<summarize: branch name, commit messages, changed files, diff stats>",
  project_id: "proj_demo"   // from case-spec.json
)
```

The tool returns suggested `case_type`, `risk_level`, `priority`, `validation_track`, and `title`.
Use these as defaults in Step 4.

**Fallback (if detect fails):** Detect fields manually using branch name patterns and the case-spec.json heuristics:

| Field | How to detect |
|-------|---------------|
| **title** | From PR title, or summarize branch name / commit messages |
| **description** | From PR body, or summarize the diff and commit messages |
| **case_type** | Match branch name against `case_types[*].branch_patterns` in spec |
| **risk_level** | Match changed file paths against `risk_heuristics` in spec. Use the highest matching level. |
| **priority** | From JIRA ticket priority (if extractable), or branch prefix (hotfix -> urgent) |
| **validation_track** | Default `direct`. Use `manual` only if the change targets a non-CI-accessible system. |
| **jira_refs** | Extract ticket IDs matching the patterns in `auto_detect.jira_refs.patterns` |
| **source_type** | `git` if from PR, `jira` if JIRA ref present, `manual` otherwise |

### Step 4: Present Proposal to User

Show the proposed case to the developer and ask for confirmation:

```
I'd like to create the following Arbitra case:

  Title:        Fix race condition in state machine transitions
  Type:         bugfix
  Risk:         high (reason: changes core state machine in services/)
  Priority:     urgent (from JIRA ARB-107)
  Track:        direct (CI-testable)
  Branch:       fix/transition-race-condition
  PR:           https://github.com/org/arbitra/pull/47
  JIRA:         ARB-107
  Description:  [2-3 sentence summary]

Does this look right? Would you like to change anything?
```

If no branch, PR, or JIRA ref exists yet (greenfield), omit those fields from the proposal:

```
I'd like to create the following Arbitra case:

  Title:        Add dark mode toggle to settings page
  Type:         ticket_implementation
  Risk:         low (no sensitive files changed)
  Priority:     normal
  Track:        direct
  Description:  [2-3 sentence summary]

Does this look right?
```

**Important:** Always ask. Never create a case silently. The developer may want to adjust
risk level, add context to the description, or correct the detected type.

### Step 5: Create the Case

Call the MCP tool with the confirmed fields:

```
create_case(
  title: "Fix race condition in state machine transitions",
  description: "...",
  project_id: "proj_demo",
  repository_id: "org/arbitra",
  case_type: "bugfix",
  risk_level: "high",
  priority: "urgent",
  validation_track: "direct",
  git_branch: "fix/transition-race-condition",
  git_remote_url: "https://github.com/org/arbitra.git",
  source_type: "git",
  source_ref: "ARB-107",
  jira_refs: "ARB-107"
)
```

**Optional fields:** Omit `source_ref`, `jira_refs`, `git_branch`, and `git_remote_url` when they don't exist. The API will accept the case without them.

### Step 6: Report Back

Tell the developer:
```
Case created: case_1711234567890
  Status: open
  URL: ${ARBITRA_URL}/cases/case_1711234567890

Next steps (follow AGENTS.md):
  1. Call progress_case(case_id, summary) to submit exploration
  2. Implement when status reaches in_build
  3. Push, create PR, and call progress_case(case_id, summary, branch, pr_url, evidence)
  Your task is NOT complete until progress_case from in_build returns success.
```

---

## Field Reference

### case_type

| Value | When to use |
|-------|-------------|
| `ticket_implementation` | Implementing a JIRA ticket or feature (branch: `feat/*`, `feature/*`) |
| `bugfix` | Fixing a bug (branch: `fix/*`, `bugfix/*`, `hotfix/*`) |
| `refactoring` | Restructuring without functional changes (branch: `refactor/*`, `chore/*`) |
| `pr_review` | Reviewing an external/third-party PR |
| `manual_verification` | Changes requiring manual testing (remote desktop, hardware, GUI) |
| `security_review` | Security-focused review (branch: `security/*`) |

### risk_level

| Level | Indicators |
|-------|------------|
| `critical` | Migrations, deploy configs, infrastructure, CI/CD pipeline |
| `high` | Auth, security, middleware, API routes, dependency updates |
| `medium` | Business logic, services, new features |
| `low` | Docs, tests only, style/formatting |

### validation_track

| Track | When |
|-------|------|
| `direct` | Default. Target system is testable via CI/API. |
| `manual` | Target system requires manual testing (remote desktop, VPN, hardware). |

---

## Authentication

### MCP Agents
Credentials are configured in your MCP server connection. You do not need to manage tokens manually.

### Demo Mode
No authentication required. The API accepts unauthenticated requests.

### Production
Generate a **Personal Access Token** in the Arbitra UI:
1. Go to Settings -> Access Tokens
2. Click "Generate Token"
3. Copy the token (shown only once)
4. Set as environment variable: `export ARBITRA_TOKEN=arb_...`

The token is sent as a Bearer token in API requests:
```bash
curl -H "Authorization: Bearer $ARBITRA_TOKEN" ${ARBITRA_URL}/api/cases
```

## Configuration

| Environment Variable | Purpose |
|----------------------|---------|
| `ARBITRA_URL` | Base URL of the Arbitra instance (default: `http://localhost:3000`) |
| `ARBITRA_TOKEN` | API authentication token |
| `ARBITRA_PROJECT_ID` | Override project_id from case-spec.json |

---

## Appendix: Curl Fallback (No MCP)

Use these curl commands if the `arbitra` MCP server is not available. The flow is the same (Steps 0-2 and 4-6 are identical). Only Steps 3 and 5 differ.

### Step 3 (Curl): Auto-Detect Fields

```bash
curl -X POST "${ARBITRA_URL}/api/cases/detect" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${ARBITRA_TOKEN}" \
  -d '{
    "git_context": {
      "branch": "'$(git -C "$REPO_DIR" branch --show-current)'",
      "remote_url": "'$(git -C "$REPO_DIR" remote get-url origin)'",
      "commit_sha": "'$(git -C "$REPO_DIR" rev-parse HEAD)'"
    },
    "changed_files": []
  }'
```

The API returns suggested `case_type`, `risk_level`, `priority`, `validation_track`, and `suggested_title`.
Use these as defaults when presenting the proposal.

### Step 5 (Curl): Create the Case

```bash
curl -X POST "${ARBITRA_URL}/api/cases" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${ARBITRA_TOKEN}" \
  -d '{
    "title": "Fix race condition in state machine transitions",
    "description": "...",
    "source_type": "git",
    "source_ref": "ARB-107",
    "project_id": "proj_demo",
    "repository_id": "org/arbitra",
    "validation_track": "direct",
    "risk_level": "high",
    "priority": "urgent",
    "case_type": "bugfix",
    "jira_refs": ["ARB-107"],
    "git_context": {
      "branch": "fix/transition-race-condition",
      "remote_url": "https://github.com/org/arbitra.git",
      "commit_sha": "abc123...",
      "pr_ref": "https://github.com/org/arbitra/pull/47"
    }
  }'
```

**Optional fields:** Omit `source_ref`, `jira_refs`, and `git_context.pr_ref` when they don't exist. The API will accept the case without them.

The API will:
- Auto-fill `current_branch` and `current_pr_ref` from `git_context`
- Derive `repository_id` from `remote_url` if not explicitly set
- Apply auto-detection heuristics for any fields not provided
- Create the case with status `open`
