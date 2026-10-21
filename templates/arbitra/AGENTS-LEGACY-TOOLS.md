# Arbitra -- Legacy MCP Tools

> Historical record for integrations hardcoding pre-2.1.0 tool names. Off the hot path — **new integrations should use `progress_case` and `get_case_context`** (see `.arbitra/AGENTS.md`). These aliases will be removed in arbitra-mcp 3.0.0.

## Deprecated tools

| Legacy tool | Status | Drop-in replacement |
|-------------|--------|---------------------|
| `signal_exploration_complete(case_id, summary)` | DEPRECATED | `progress_case(case_id, summary)` at `open`/`exploration` |
| `signal_build_complete(case_id, summary, branch?, pr_url?, evidence?)` | DEPRECATED | `progress_case(case_id, summary, branch?, pr_url?, evidence?)` at `in_build` |
| `register_evidence(case_id, type, summary?, source_type?)` | DEPRECATED | Pass an `evidence` array to `progress_case` |
| `get_agent_instructions(case_id)` | DEPRECATED | `get_case_context(case_id)` — read `next_action` |

All legacy handlers continue to hit the same backend endpoints they did before 2.1.0, so existing installs keep working. Nothing breaks for currently-running agents — but prefer the canonical verbs in anything new.
