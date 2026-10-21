# Arbitra -- IDE Agent Instructions

> For Claude Code, Cursor, Copilot, or any IDE agent.

Canonical reference for driving an Arbitra case through its lifecycle. Every Arbitra interaction goes through the MCP tools below.

**See also:**
- **[`AGENTS.md`](../AGENTS.md)** — Project conventions, repository structure, build commands, PR workflow

Sibling files: `.arbitra/CREATE-CASE.md` (case creation, `/create-case`) and `.arbitra/AGENTS-LEGACY-TOOLS.md` (pre-2.1.0 tool aliases; off the hot path).

---

## Preflight: verify MCP is connected

Before doing anything else, confirm the `arbitra` MCP tools are available. Look for tools whose names start with `mcp__arbitra__` or `arbitra.` (for example `get_case_context`, `progress_case`).

- **If you see them:** proceed. Every Arbitra interaction MUST go through those tools. Do NOT use `curl`, do NOT read `.arbitra/.env`, do NOT call HTTP endpoints directly.
- **If you do NOT see them:** stop and tell the user: "I cannot see the Arbitra MCP server in this session. Please ensure the `arbitra` MCP server is configured, then retry." Do not attempt curl on your own initiative.

Arbitra governs merges, not writes (ADR-0001). There is no pre-write gate and no local case pointer — nothing here blocks an edit. Case tracking is for visibility and review, not a precondition for implementing.

**`next_action` is the source of truth.** After every MCP tool response, inspect `structuredContent.next_action`. Shape: `{ "tool_to_call": "...", "why": "...", "expected_payload_keys": [...] }`. If `tool_to_call` is set, that is your next step — call that tool with the keys listed in `expected_payload_keys`. The status→action table later in this file is reference material for debugging and filling in payload details; it is not the flow-chart you follow.

---

## Canonical sequence — one call per common need

Resolve each need with the SINGLE call below. Do not chain redundant lookups.

- **Need `project_id`, `repository_id`, reviewer pool, evidence policy, or preconditions for an existing case** → `get_case_context(case_id)`. Returns all of them in one call. This is the right starting point for nearly every active-case task.
- **Need to enumerate projects** → `list_projects()`. Only when you do not yet have a case (e.g. the user is about to run `/create-case`).
- **Need to enumerate repositories in a project** → `list_repositories(project_id)`. Only when registering a new case in a project you just chose.

**Anti-pattern to avoid.** Calling `list_repositories()` with no `project_id` (which returns empty), then `list_projects()`, then `list_repositories(project_id)` to recover. If you have a `case_id`, skip the chain entirely — `get_case_context` already carries `repository_id`. If you don't, start at `list_projects` and pass the project through.

---

## The Loop

If you discover a problem after a forward transition, use the Loopback (`create_decision(type: request_changes)`) — this is documented below and is not a failure, it's the intended recovery path.

Four steps, repeated until the case reaches `pending_merge` or a terminal state:

1. **Resolve the case bound to the current branch.** No local pointer file — a case is bound to exactly one (repository, branch) pair. Resolve it via `GET $ARBITRA_URL/api/cases/resolve?repository_id=...&branch=$(git branch --show-current)` (or `list_cases` and match `current_branch`). No case bound (or status is `done`/`rejected`)? Propose `/create-case`. Implementation may proceed either way — case tracking is not a precondition for editing.
2. **Get context.** `get_case_context(case_id)` — read `status`, `next_action`, `preconditions`, `return_context`.
3. **Follow `next_action.tool_to_call`.** Usually `progress_case(case_id, ...)` with the keys listed in `expected_payload_keys`. It dispatches based on current status (see table below).
4. **Handle the payload.** If status is `in_build`, run the in-build checklist before calling `progress_case` again. Otherwise poll `get_case_context` until `next_action` changes.

### Branch-keyed identity — parallel work is the default

Case identity derives from the branch: one branch, one case. Two IDE-agent sessions on two different branches — including two git worktrees on the same checkout — never collide, because each resolves its own case by its own branch. There is no shared mutable local state (no pointer file, no gate cache) to race on:

```
git worktree add ../repo-case-A feat/case-A
git worktree add ../repo-case-B feat/case-B
```

Two sessions on the *same* branch still share one case, by design — that is what "one case per branch" means.

---

## `get_case_context(case_id)`

Returns the full case state. Fields you will read most often:

- `status` — current lifecycle status (one of the 12 in the status reference).
- `next_action` — the pointer to the single tool you should call next.
- `preconditions` — per-outgoing-transition `{satisfied, reason?}`; explains what blocks the next move.
- `return_context` — present only when the case was sent back via `request_changes`; contains `reason` and `open_findings`.
- `project.lifecycle_profile` — `autonomous | standard | strict` + per-gate overrides; predicts if transitions auto-fire or wait for human confirmation.
- `case.pending_gate` — set when a confirm gate is currently blocking an auto-transition.

Always call this first on every loop iteration.

---

## `progress_case(case_id, summary?, branch?, pr_url?, evidence?, force_target?)`

State-driven dispatcher. Reads the current status and routes to the correct backend call.

| Current status | What it does | Required args |
|----------------|--------------|---------------|
| `open`, `exploration` | Posts exploration summary to `/api/agent/explore`; case auto-advances to `ready_for_build` | `case_id`, `summary` |
| `ready_for_build` | Transitions to `in_build` | `case_id` |
| `in_build` | Signals build-complete with summary/branch/pr_url/evidence | `case_id`, `summary` (+ optional `branch`, `pr_url`, `evidence`) |
| `in_validation`, `in_review`, `approved`, `pending_merge` | No-op; returns current context. Poll `get_case_context` until status moves. If issues found at `in_validation` / `in_review` / `pending_merge`: use `create_decision(type: request_changes)` instead of `progress_case` (see Loopback section). | `case_id` |
| `needs_human_decision`, `verification_pending` | No-op; directs the user to the Courtroom UI. If issues force a code-level fix: use `create_decision(type: request_changes)` to return to `in_build` (see Loopback section). | `case_id` |
| `done`, `rejected` | Structured error: terminal. | — |

Parameters:

| Parameter | Required | Description |
|-----------|----------|-------------|
| `case_id` | Yes | The case ID |
| `summary` | When advancing from `open`/`exploration`/`in_build` | Markdown summary. Sign it the same way you sign comments — see "Signing comments and summaries" below. |
| `branch` | No (meaningful at `in_build`) | Git branch name |
| `pr_url` | No (meaningful at `in_build`) | Pull request URL |
| `evidence` | No (meaningful at `in_build`) | Array of evidence items (see below) |
| `force_target` | No | Escape hatch: bypass dispatch and call `/api/cases/:id/transition` directly |

When called at `in_build`, `progress_case` updates the case with branch/PR, registers evidence, posts the summary, and signals `build_run`. The case then auto-advances through validation, review, and approval.

---

## Loopback — `create_decision(type: "request_changes")`

**Purpose.** Return any post-`in_build` case to `in_build` when you discover a problem — wrong branch, broken build, missing evidence, stale assumptions, PR went sideways. This is the intended recovery path, not a failure mode.

**When to use:**

- `in_validation` — validator run surfaces a problem the build didn't catch.
- `in_review` — reviewer's own self-check contradicts the submission.
- `needs_human_decision` — human rejects a finding's proposed waiver.
- `verification_pending` — manual verification turned up an issue that needs more code work.
- `pending_merge` — discover after approval that the PR is wrong/missing/on the wrong branch.

**How to call:**

```
create_decision({
  case_id: "case-...",
  type: "request_changes",
  rationale: "<specific, actionable reason — not generic>"
})
```

Real example: `rationale: "PR #412 targets branch feat/old-case, not feat/case-XYZ. Need to re-open on the correct branch before merge."`

**Effect.** Case transitions back to `in_build`, preconditions re-evaluate, `return_context` is populated with your rationale and open findings. Fix the problem and re-progress via `progress_case` at `in_build` — the existing PR on the right branch can be updated in place (no need for a new branch unless the previous one was itself the problem).

---

## Evidence format

Structured array of objects, one per discrete evidence item:

```json
[
  { "type": "unit_test_result", "summary": "All 42 tests pass" },
  { "type": "lint_result", "summary": "No warnings" },
  { "type": "ci_result", "summary": "Build green" }
]
```

Each item requires `type` (non-empty string; backend validates against its canonical enum) and `summary` (short human description). Optional: `artifact_ref`, `run_id`, `machine_readable`, `source_type` (`automated | manual | webhook | api`). Do NOT pass markdown reports as evidence — use the top-level `summary` for prose; evidence items are for discrete, typed pieces. The legacy comma-separated string format was removed in arbitra-mcp 2.0.0 and fails Zod validation.

---

## In-build checklist

When status is `in_build`, run these steps before calling `progress_case` again:

1. **Create a fresh feature branch from `main`** (one case, one branch — see rule below).
   ```bash
   git checkout main && git pull --ff-only
   git checkout -b feat/$CASE_ID
   ```
2. **Implement the change** — edit files, write tests.
3. **Self-review before committing.** Spawn a sub-agent to review your diff (correctness, edge cases). If issues are found, fix them and re-run the review. Only proceed when it passes clean.
4. **Commit via heredoc** so real newlines are preserved (never the literal string `\n`). Stage specific files only — never `git add .`. The commit message doubles as the PR body.
   ```bash
   git commit -m "$(cat <<'EOF'
   feat: short imperative subject line

   ## Summary
   - what changed (1-2 bullets)

   ## Changes
   - file/area A: one line
   - file/area B: one line

   ## Evidence
   - `npm run build` passes
   - `npm test` passes

   Refs: CASE_ID
   EOF
   )"
   ```
5. **Push and create the PR — always `--fill`, never `--body "..."`.**
   ```bash
   git push -u origin <branch>
   gh pr create --fill
   ```
   `--fill` reads title and body from the commit message. Inline `--body "Summary\n\n- item"` leaves literal `\n` in the GitHub UI. If a multi-commit branch makes `--fill` awkward, use `--body-file <path>` — never inline `--body`.
6. **Collect required evidence.** Call `get_evidence_requirements(case_id)`. For every missing required type, collect it (`ci_result`, `unit_test_result`, `lint_result`, `manual_confirmation`). If a required type genuinely does not apply (e.g., docs-only change with no CI), register it with a summary explaining why. Never leave required evidence unregistered.
7. **Re-check context.** `get_case_context(case_id)` — confirm status is still `in_build` and all required evidence is satisfied.
8. **Present the completion summary** to the user:
   > Implementation complete. Branch: `<branch>`. PR: `<pr-url>`. Changes: `<1-2 sentences>`. Evidence: `<list>`.
9. **Decide whether to ask for confirmation** based on the case/project state you just re-fetched in step 7:
   - If `case.pending_gate` is set → STOP. A confirm gate is actively blocking this transition; tell the user what the gate is and wait. Do not call `progress_case` until the gate clears.
   - Else if `project.lifecycle_profile.preset === 'autonomous'` → skip the confirmation question and proceed directly. The `autonomous` preset is the project's explicit opt-in to agent-driven signaling; asking anyway is noise.
   - Else (`standard` / `strict` preset, or preset is missing) → ask the user: *"Shall I signal build completion to Arbitra?"* Wait for explicit confirmation before continuing.
10. **Call `progress_case(case_id, summary, branch, pr_url, evidence)`** — include ALL collected evidence in the `evidence` parameter.

After success, the case auto-advances: `in_validation → in_review → approved → pending_merge`. Then ask the user: "Case approved. Merge the PR?" Merging triggers `done` via webhook.

**Your task is NOT complete until `progress_case` from `in_build` returns success.** Stopping after commit leaves the case stuck forever.

---

## Hard Rules

- **Never sign off a case as ready for review or merge** on work that wasn't actually done in `in_build` — Arbitra does not mechanically block edits at any status (ADR-0001), but the lifecycle discipline below still matters for the audit trail.
- **Never signal build completion** without explicit user confirmation — **unless** `project.lifecycle_profile.preset === 'autonomous'` AND `case.pending_gate` is unset. Autonomous preset opts the project in to agent-driven signaling; other presets still require the human in the loop.
- **Never merge the PR** before the case reaches `pending_merge`.
- **Never use `git add .`** — stage specific files only (risk of committing `.arbitra/.env`).
- **Never commit `.arbitra/.env`** — it contains secrets.
- **Never skip exploration** — it documents the approach.
- **Never fabricate evidence** — only register what you verified.
- **Never skip evidence collection** — call `get_evidence_requirements` before build-complete.
- **Never skip self-review** — spawn a review sub-agent before committing.
- **Never stop after committing** — push, PR, and `progress_case` from `in_build` are required.
- **Never reuse a branch from another case** — see "One Case, One Branch" below.
- **Merge order:** `build_run → validation → review → approval → pending_merge → THEN merge PR`.

---

## One Case, One Branch

**Every case gets a fresh branch from `main`.** Never reuse a branch from a previous case, even if the change feels related. Branch names MUST contain the case ID (e.g. `feat/case-foo-bar-XYZ`). This keeps close-on-merge PR→case linkage trivial and audit trails clean.

**Anti-pattern:** do NOT `git checkout <existing-branch>` when that branch already belongs to another case — a single PR merge would close only one case ambiguously, evidence attribution breaks, and the audit trail corrupts. Either finish the other case first and merge it, or move the work into the right existing case and cancel the wrong one. The backend hard-enforces this: moving a case to `in_build` (or signaling build-complete) on a branch already claimed by another non-terminal case in the same repo is rejected with a structured error.

---

## Re-entry: case sent back for rework

If your case was previously reviewed and bounced back to `in_build` via `request_changes`:

1. `get_case_context(case_id)` — read `return_context.reason` (reviewer rationale) and `return_context.open_findings` (issues to fix).
2. Engage with each finding on its merits — findings are **charges to answer, not orders to obey**. You own this change and you tested it. Fix the real ones; for any finding that is off-base, out of scope for this case, or already handled, defend it with a rationale (`add_comment` / `create_decision`) so a human reviewer can waive it at the gate. Address every finding — an unanswered finding blocks the case.
3. Re-run the in-build checklist from step 3 (self-review) onward. If a PR already exists, pushing updates it — no need to create a new one.

`return_context` is only present when the case was returned via `request_changes`. Absent field means the case was not sent back. The context API tells you exactly what to fix — do not start from scratch.

### User reports a bug during testing

If the user tells you they found a bug while the case is past `in_build` (typically in `pending_merge`, but also `in_validation` / `in_review` / `verification_pending`):

1. `transition_case(case_id, target_status='in_build')` — rewinds the case. The backend invalidates stale evidence and approvals from the previous iteration automatically.
2. `add_comment(case_id, body=<bug description from the user>)` — record why the case was sent back so the audit trail is intact.
3. Fix the bug in code on the existing branch (the PR stays open; pushing updates it).
4. Re-run the in-build checklist from step 3 (self-review) onward.

This is an informal agent-initiated rewind, not a formal reviewer `request_changes` decision. Use the Courtroom UI for reviewer-driven request-changes when a four-eyes audit trail is required.

---

## Status reference

Reference only — follow `next_action` from the runtime, not this table. Use the table for debugging and for filling in `progress_case` payload details.

| Status | One-liner |
|--------|-----------|
| `open` | Call `progress_case(case_id, summary)` to submit exploration. |
| `exploration` | Wait for auto-transition (or submit summary via `progress_case`). |
| `ready_for_build` | Call `progress_case(case_id)` to advance to `in_build`. |
| `in_build` | Run the in-build checklist; end with `progress_case(case_id, summary, branch, pr_url, evidence)`. Ask user to confirm first — **except** when `project.lifecycle_profile.preset === 'autonomous'` (skip the ask) or when `case.pending_gate` is set (stop, gate is blocking). |
| `in_validation` | Wait. Request-changes can loop back to `in_build`. |
| `in_review` | Wait for auto-review. |
| `needs_human_decision` | Tell user to open the Courtroom in the UI. |
| `verification_pending` | Tell user manual validation is needed in the UI. |
| `approved` | Auto-transitions to `pending_merge`. Exception: a case with NO PR ref and NO branch (implementation outside the repo) auto-completes to `done` with a system-attached `merge_not_applicable` decision. |
| `pending_merge` | Ask user to merge the PR. Request-changes can loop back. If the case has no PR and never will (implementation outside the repo, e.g. ops configuration), record `create_decision(type: "merge_not_applicable", rationale)` to complete the case — rejected when a PR reference exists. |
| `done` | Case finished. Propose `/create-case` for new work. |
| `rejected` | Terminal. Propose `/create-case` for new work. |

---

## Additional MCP Tools

| Tool | Purpose |
|------|---------|
| `transition_case(case_id, target_status)` | Transition case to a new status (escape hatch; prefer `progress_case`) |
| `create_decision(case_id, type, rationale, finding_id?)` | File a **formal** reviewer decision (`approve` / `reject` / `request_changes` / `merge_not_applicable`) with a recorded rationale. Creates an audit-trail entry. `merge_not_applicable` completes a `pending_merge` case that has no PR and never will (implementation outside the repo); it is rejected when the case has a PR reference. Sign the rationale — see "Signing comments and summaries" below. See also "Formal decisions vs. informal rewind". |
| `add_comment(case_id, body)` | Post a Markdown comment on a case. Sign the body — see "Signing comments and summaries" below. |
| `get_case(case_id)` | Get full case details |
| `list_cases(status?, project_id?, limit?)` | List cases with optional filters |
| `get_evidence_requirements(case_id)` | Check what evidence is required |
| `list_findings(case_id)` | List review findings for a case |
| `search(query)` | Search across cases, findings, and knowledge |
| `update_case(case_id, ...)` | Update case fields |

### Signing comments and summaries

Every Markdown body you write into Arbitra — `add_comment` bodies, the `summary` argument to `progress_case` (exploration and build), and the `rationale` on `create_decision` — MUST end with a one-line signature identifying **who you are**: the agent client and the specific model.

Format: `— <client> · <model>`. Examples:

- `— claude-code · Claude Opus 4.7`
- `— cursor · Codex 5.3`
- `— cline · Claude Sonnet 4.5`

If you do not know the exact model, name the provider instead: `— cursor · OpenAI`, `— gemini-cli · Google`. Do not guess a version number.

This signature lives in the audit trail next to the structured `actor_metadata` (which the MCP client attaches automatically). The structured field powers UI badges; the human-readable signature gives reviewers reading the timeline the model context they need to weigh the reasoning. Both are required — they are not redundant.

### Formal decisions vs. informal rewind

`create_decision` and `transition_case` look similar but target different workflows:

- **`create_decision(case_id, type, rationale, finding_id?)`** — use when the user asks you to act as a **reviewer** on their behalf: "approve this case", "reject it with this rationale", "request changes because of X". Creates a persisted `Decision` row with your `actor_metadata` attached and shows up in the case timeline / Courtroom UI. The backend enforces anti-gaming (no self-approval unless the effective evidence-policy cell permits it), so the user must have reviewer standing on the case. Types exposed to agents: `approve`, `reject`, `request_changes`. `waive`, gate confirmations, and escalations stay UI-only.
- **`transition_case(case_id, target_status='in_build')` + `add_comment`** — use for the **informal rewind** flow already covered under *User reports a bug during testing*. No audit trail, no reviewer role check — just move the case back to `in_build` and record why in a comment. Appropriate when the user spots a bug post-build and wants a quick loop, not a formal review action.

If the user's intent is ambiguous ("can you reject this?"), ask whether they want a formal decision recorded or just a rewind.

---

## Error codes

- **401** — Token expired. Regenerate in Settings > Access Tokens.
- **400** — Preconditions not met. Call `get_case_context` to see what's blocking (check `preconditions`).
- **404** — Wrong case ID. Re-resolve via `GET $ARBITRA_URL/api/cases/resolve?repository_id=...&branch=...`.

