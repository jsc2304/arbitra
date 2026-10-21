---
description: Send the active case back to in_build when you've spotted a problem post-submission
---

Follow the `/request-changes` pattern in `.arbitra/AGENTS.md` (Loopback section).

1. Resolve the case_id for the current branch (MCP `get_case_context`, or `GET $ARBITRA_URL/api/cases/resolve?repository_id=...&branch=...` — no local pointer file)
2. Determine why you're sending it back — include a **specific, actionable reason**, not "please fix"
3. Call MCP `create_decision` with:
   - `case_id`: from the branch resolution above
   - `type`: "request_changes"
   - `rationale`: your specific reason
4. Case transitions back to `in_build`. Inspect `structuredContent.next_action` on the response for what to do next (usually: fix the problem then `progress_case` again).

Valid from: in_validation, in_review, needs_human_decision, verification_pending, pending_merge.
