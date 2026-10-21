# AGENTS.md

Agent contract for this repository.

<!-- ARBITRA-GATE-START -->
## Arbitra

This repo is tracked by Arbitra. Arbitra governs merges, not writes — there is no pre-write gate, and no case is required before editing a file.

1. Resolve the case bound to the current branch via MCP (`mcp__arbitra__get_case_context` after locating it), or `GET $ARBITRA_URL/api/cases/resolve?repository_id=...&branch=...` — no local pointer file to read or write.
2. No case bound yet? Create one via `./arbitra-create-case.sh` if you want this work tracked. It is optional, not a precondition for implementing.
3. Drive the case you did create through its lifecycle (explore → build → signal completion) per `.arbitra/AGENTS.md`, so evidence and review land on the right case.

Full contract: see `.arbitra/AGENTS.md`.
<!-- ARBITRA-GATE-END -->
