---
description: Submit the current branch for Arbitra LLM review
---

Follow the `/review` instructions in `.arbitra/AGENTS.md`.

1. Determine the base branch from the default remote HEAD, not by assuming `main`:
   `BASE=$(git symbolic-ref refs/remotes/origin/HEAD | sed 's|refs/remotes/origin/||')` (fallback: `main`)
2. Collect the diff: `git diff $(git merge-base HEAD "origin/$BASE")..HEAD`
3. MCP `signal_build_complete` with the diff (or whatever tool the current `structuredContent.next_action` points at)

The pipeline auto-approves or escalates to a human decision based on findings. Check the returned `next_action` for the follow-up tool.
