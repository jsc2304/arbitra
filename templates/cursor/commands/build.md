---
description: Start Arbitra build phase — transition case to in_build
---

Follow the `/build` instructions in `.arbitra/AGENTS.md`.

MCP `progress_case` to advance the case to `in_build`. The pipeline auto-transitions through `in_validation` → `in_review` when preconditions (evidence, passing rules) are met.

After each tool response inspect `structuredContent.next_action` — if `tool_to_call` is set, that is your next step. Do NOT edit files before the case is confirmed in `in_build`.
