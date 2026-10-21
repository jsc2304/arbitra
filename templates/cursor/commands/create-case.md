---
description: Create a new Arbitra case from the current git context
---

Follow the `/create-case` instructions in `.arbitra/AGENTS.md` (and `.arbitra/CREATE-CASE.md` for the full flow).

1. Collect git context: current branch, remote URL, `git diff main..HEAD` (or against the default remote branch), associated PR if any
2. Auto-detect `case_type` from branch prefix: `feat/` → `ticket_implementation`, `fix/`|`bugfix/`|`hotfix/` → `bugfix`, `refactor/`|`chore/` → `refactoring`
3. Present a short proposal to the user (title, case_type, validation_track, risk_level, priority) and wait for explicit confirmation — NEVER create a case without user approval
4. After confirmation: call MCP `create_case` with the confirmed fields
5. Report the returned `case_id` to the user — Arbitra resolves this case for future calls by (repository, branch), no local pointer file to maintain

Inspect `structuredContent.next_action` on the response for the next step.
