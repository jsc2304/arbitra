# Observe by default, enforce by policy

Status: accepted (2026-08-26)

## Context

Arbitra's original model required a case to exist before any code was written, enforced by a client-side pre-write hook. In practice the gate demanded effort before it delivered any value, a pre-write block cannot be enforced reliably on the client, and a stale case pointer silently disarmed the gate anyway. Developers routinely wanted to work around it.

## Decision

Observation is the default and enforcement is the escalation. Arbitra learns about work from session signals and pull request webhooks and records it as observed cases. Project policy and risk heuristics escalate individual cases into the enforced lifecycle. In the enforced lifecycle the blocking point is the merge (GitHub checks plus the `arbitra/case` commit status), never the act of writing code.

## Considered options

- **Keep gate-first, reduce ceremony.** Rejected. The failure was that the gate demanded effort before delivering value, and a pre-write block is unenforceable on the client.
- **Project-wide switch (a project is either observed or enforced).** Rejected in favour of per-case escalation. Risk varies per change, not per project, and risk heuristics and evidence policies already exist per case.
- **Observation only, no enforcement.** Rejected. Without escalation Arbitra degrades to an audit log, and its governance core (evidence requirements, four-eyes approval, the courtroom) has no effect.

## Consequences

- The pre-write client hook and the local active-case pointer no longer exist. Case identity derives from the branch.
- Manual case creation remains possible for planned work but is no longer the primary entry point.
- Clients without session instrumentation (for example plain Cursor) get a degraded, webhook-only view. This is accepted.
