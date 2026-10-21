---
description: Check Arbitra case status and suggest next actions
---

Follow the `/status` instructions in `.arbitra/AGENTS.md`.

Resolve the case bound to the current branch (MCP `get_case_context` after locating it via `.arbitra/AGENTS.md`'s branch-resolution flow — no local pointer file). Call `get_case_context` and report:
- Current status + lifecycle_profile
- Any pending_gate or blocking findings
- The suggested next-action tool from `structuredContent.next_action` in the response

Do not attempt curl or read `.arbitra/.env` when MCP is available.
