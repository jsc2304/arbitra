# Intelligence flags and nudges: UI surfacing

Status: Design document; parts may differ from the code. The backend writes the flags and nudges described here (see [`../intelligence.md`](../intelligence.md)). The UI surfaces and the dismiss endpoint below are not implemented.

**Goal.** Render `intelligence_flags[]` on cases and `intelligence_nudge` workspace events so detector signals are visible without adding cases to the case list.

## Context

Detectors never create cases. Each detection is written in one of two ways:

- **Flag** on the target case (`case.intelligence_flags[]`) for detectors with `target_kind: 'case'`: `stale-open`, `aging-pending-merge`, `high-risk-without-four-eyes`, `repeated-rework`.
- **Nudge** as a `WorkspaceEvent` with `type: 'intelligence_nudge'` for detectors with `target_kind: 'branch'` or `'project'`: `orphan-branch`, `incomplete-repo-setup`.

Nudges reach the activity feed through the generic workspace-event path and can be dismissed per user. Flags have no UI at all.

## Scope

In scope:

- Case list: a row-level badge when `intelligence_flags.length > 0`. One badge per case, coloured by the highest severity. Hover or click opens the flag detail.
- Case detail: a Signals section that lists each flag with detector id, summary, evidence preview, `flagged_at` and a dismiss button.
- Activity feed: render `intelligence_nudge` events next to the existing `intelligence_run` heartbeats, with the same dismiss and resolve behaviour as other workspace events.
- A dismiss path for flags.

Out of scope: bulk flag operations, flag history beyond `flagged_at`, notifications for new flags, a separate findings collection.

## Data shape

```ts
export interface IntelligenceFlag {
  detector_id: string;
  signature: string;
  severity: 'low' | 'medium';
  summary: string;
  evidence: Record<string, unknown>;
  flagged_at: string;
}
```

Severity is `low` or `medium`; no current detector produces a higher level.

## UI surfaces

### 1. Case list row

Add an `IntelligenceFlagBadge` to the badge row of the case list item.

- No flags: no badge.
- One or more flags: a badge labelled with the count (`2 signals`) or, for a single flag, the detector name. Low is neutral, medium is amber.
- A click opens the case detail at the Signals section.

### 2. Case detail: Signals section

A new section below the case header and above the evidence panel, collapsed when there are no flags. It shows one card per flag with:

- the detector id and a short headline (for example `stale-open`, 7 days idle),
- the flag date,
- the summary text,
- a preview of the evidence fields,
- a dismiss control.

Dismissing a flag removes it from the case (see below).

### 3. Activity feed: nudges

`intelligence_run` heartbeats already render in the activity feed. Extend the same path for `intelligence_nudge`:

- Icon: a signal glyph, different from the heartbeat.
- Title: `{detector_id} · {target_kind}:{target_id_short}`.
- Body: `evidence.summary`.
- The existing per-user `WorkspaceEventDismissal` applies. An admin or tech lead can hide an event for everyone with the existing `resolved_at` mechanism.

## Backend additions

- `PATCH /api/cases/{caseId}/flags/{signature}/dismiss` removes the flag entry from `intelligence_flags[]`. It requires write access to the case and is idempotent (200 if the flag is already absent).
- No new collection. Dismissal is destructive: the next detector run raises the flag again if the condition persists. The service-level deduplication reads `intelligence_flags[*].signature`, so a dismissed signature is no longer live. This is intended: "I dealt with it; if it comes back, show it again." The endpoint's documentation must say so.

## Open questions

1. **Severity ceiling.** Whether combinations (for example `stale-open` together with `aging-pending-merge`) should raise a case to `high`.
2. **Auto-clear.** A flag stays until dismissed. When a case reaches a terminal status the detectors stop reporting it, but the flag entry stays on the document. Options: (A) manual dismissal only, (B) remove a flag whose signature was absent from the last N runs, which needs last-seen tracking per signature. Option A is simpler and predictable; revisit if accumulated flags become noise.
3. **Flag history.** Whether dismissed flags are kept for audit. The default is deletion; the per-run `intelligence_run` event already records that runs happened.

## Tests

- Component tests for `IntelligenceFlagBadge` (no flags renders nothing, mixed severities show the highest).
- Component tests for the Signals section (renders flags, calls the dismiss handler).
- API test for the dismiss endpoint (authorization, idempotency).
- End-to-end: a detector run flags a case, the user dismisses the flag, the next run flags it again.
