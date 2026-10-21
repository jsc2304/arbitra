---
description: Start Arbitra exploration — analyze the codebase and complete the exploration run
---

Follow the `/explore` instructions in `.arbitra/AGENTS.md`.

1. MCP `progress_case` to the `exploration` status (or follow `structuredContent.next_action` if it points elsewhere)
2. Analyze the affected local files: read them, map dependencies, formulate a change strategy
3. MCP `signal_exploration_complete` with your exploration summary

The pipeline auto-transitions the case to `ready_for_build` when the exploration run completes. After each tool call, inspect `structuredContent.next_action` to decide the next step.
