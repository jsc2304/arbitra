---
description: Check whether the Arbitra plugin is connected and show the case bound to the current branch
---

Confirm the Arbitra MCP server (`mcp__arbitra__*` tools) is reachable:

1. Call `mcp__arbitra__get_case_context` for the case bound to the current repository and branch. If no case id is known yet, resolve one via `GET $ARBITRA_URL/api/cases/resolve?repository_id=...&branch=...` (find the repository id with `mcp__arbitra__list_repositories`).
2. If the tool call returns a Connect link instead of data, this is a first run — report that link to the user and stop; do not fabricate status.
3. On success, report: current case status (or "no case yet — this repository/branch pair is unobserved"), any pending gate or blocking findings, and the `share_url` from the response.

This command works in any repository the Arbitra MCP server is configured for. It does not require a local `.arbitra/` directory, but the session-signal hooks only report sessions in repositories that have one.
