# Arbitra Intelligence

Arbitra Intelligence scans the workspace once a day and flags operational problems that the normal review lifecycle does not catch on its own. It uses deterministic detectors only; no model is involved. Detectors never create cases. A finding about a case is written onto that case, and a finding about a branch or a project is recorded as a workspace event.

## Detectors

| Detector id | Fires when | Threshold | Severity | Target |
|-------------|------------|-----------|----------|--------|
| `aging-pending-merge` | A case has been in `pending_merge` longer than the threshold. | 7 days | medium | case |
| `stale-open` | A non-terminal case (other than `pending_merge`) has had no activity. | 7 days | low | case |
| `orphan-branch` | A remote branch has no recent commit and no non-terminal case references it. | 30 days | low | branch |
| `repeated-rework` | A non-terminal case was sent back with `request_changes` at least N times. | 3 times | medium | case |
| `high-risk-without-four-eyes` | A `done` case with risk `high` or `critical` has fewer than N distinct human approvers. | 2 approvers | medium | case |
| `incomplete-repo-setup` | A repository has never delivered a signed webhook event, delivers push events but no `pull_request` events, or has no stored GitHub token. | none | medium | project |

`orphan-branch` needs a hook that lists remote branches (`listRemoteBranches` on the detector context). No implementation of that hook ships, so the detector returns nothing until one is added; it skips a repository silently when the hook is absent.

Thresholds are constants in `packages/backend/src/services/intelligence/config.ts`. There is no setting to change them at runtime.

## How a run works

1. `POST /api/intelligence/run` (scheduled) or `POST /api/intelligence/run-admin` (an admin clicks Run now in the Observatory) calls `IntelligenceService`.
2. The service takes a Firestore lock (`intelligence_locks/run:intelligence`, 10-minute expiry). A second call while a run is active gets HTTP 409 with `intelligence_run_in_progress`. A crashed run cannot hold the lock for longer than the expiry.
3. It reads the detector enable flags from `intelligence_config/detectors` (a missing entry means enabled) and loads the signatures of findings that are still live.
4. Each enabled detector runs in its own try/catch. One failing detector does not stop the others; its error is stored in the run summary.
5. A detection whose signature is already live is skipped. Otherwise it is persisted (below).
6. The service stores an `IntelligenceRun` document in `intelligence_runs` and records one `intelligence_run` workspace event, even when nothing was detected, so the activity feed shows that the scheduler ran.

Every write uses the system actor `system:arbitra-intelligence`.

### Signatures and deduplication

A signature is `{detector_id}:{target_kind}:{target_id}`, for example `aging-pending-merge:case:case_abc123`. A signature counts as live while it is attached to a flag on a non-terminal case or to an unresolved `intelligence_nudge` workspace event. If a user resolves the finding and the condition persists, the next run raises it again.

### Where findings are stored

- Case-targeted detections are appended to `case.intelligence_flags[]` as `{ detector_id, signature, severity, summary, evidence, flagged_at }`.
- Branch- and project-targeted detections are written as `workspace_events` of type `intelligence_nudge`. Their `evidence` holds the detector id, signature, severity, summary, target kind and id, project and repository ids, and the detector's own evidence.

The Case Detail view has no panel for `intelligence_flags` yet. Nudges appear in the Activity feed and can be dismissed there per user. A design for flag badges and a Signals section is in [`specs/intelligence-flags-and-nudges-ui-spec.md`](./specs/intelligence-flags-and-nudges-ui-spec.md).

## Scheduling

Call the run endpoint once a day with the shared secret or a Google OIDC token, as described under [Scheduled jobs](./deployment.md#scheduled-jobs):

```bash
curl -fsS -X POST https://arbitra.example.com/api/intelligence/run \
  -H "Authorization: Bearer $ARBITRA_CRON_SECRET"
```

Response:

```json
{
  "status": "ok",
  "summaries": [
    { "detector": "aging-pending-merge", "cases_created": 2, "cases_skipped_existing": 1, "duration_ms": 58 },
    { "detector": "stale-open", "cases_created": 0, "cases_skipped_existing": 0, "duration_ms": 41 }
  ],
  "total": { "cases_created": 2, "cases_skipped_existing": 1, "errors": 0 }
}
```

The field name `cases_created` is historical. It counts new flags and nudges.

## Observatory and admin API

The Observatory page `/observatory/intelligence` (admin only) shows the run history, each detector's last result and error, and a Run now button. An admin can switch a detector off there. The same functions are available through admin-only endpoints:

| Endpoint | Purpose |
|----------|---------|
| `GET /api/intelligence/detectors` | Registered detectors with their enable flag and last-run summary. |
| `PATCH /api/intelligence/detectors/:detectorId` | Enable or disable a detector. |
| `GET /api/intelligence/runs`, `GET /api/intelligence/runs/:runId` | Run history and one run. |
| `POST /api/intelligence/run-admin` | Start a manual run. |

## Cost

A run reads every non-terminal case and, for the `high-risk-without-four-eyes` detector, every case, plus events and decisions for candidate cases. On a large workspace this is a noticeable number of Firestore reads; once a day keeps it small.

## Adding a detector

Implement the `Detector` interface from `services/intelligence/detector-types.ts`, add it to `ALL_DETECTORS` in `services/intelligence/index.ts`, and cover it with a test next to the existing detector tests. A detector reads through the `DetectorContext` and returns `DetectionResult` objects; it never writes.
