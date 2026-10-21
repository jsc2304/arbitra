import type {
  Case,
  IntelligenceFlag,
  IntelligenceRun,
  IntelligenceRunTrigger,
  DetectorRunSummary as SharedDetectorRunSummary,
  DetectorConfigMap,
} from '@arbitra/shared';
import { NotFoundError } from '@arbitra/shared';
import { CaseService } from '../case/case-service.js';
import { EvidenceService } from '../evidence/evidence-service.js';
import { CaseRepository } from '../case/case-repository.js';
import { WorkspaceEventService } from '../workspace-event/workspace-event-service.js';
import { FirestoreDetectorContext } from './firestore-context.js';
import { INTELLIGENCE_ACTOR_ID, INTELLIGENCE_CLIENT_NAME } from './config.js';
import type {
  Detector,
  DetectionResult,
  DetectorContext,
  DetectorRunSummary,
} from './detector-types.js';
import { intelligenceActorMetadata } from './detector-types.js';
import {
  acquireIntelligenceRunLock,
  type IntelligenceLockHandle,
} from './intelligence-lock.js';
import { RunHistoryRepository } from './run-history-repository.js';
import { DetectorConfigRepository } from './detector-config-repository.js';
import { generateId } from '../../lib/ids.js';

/**
 * Injectable acquirer — production uses the Firestore-backed implementation;
 * tests pass a stub to simulate contention without touching firebase-admin.
 */
export type IntelligenceLockAcquirer = () => Promise<IntelligenceLockHandle>;

const DEFAULT_CLIENT_VERSION = '1.0.0';

/**
 * Max length for a persisted per-detector error message. Detector failures
 * (e.g. a Firestore FAILED_PRECONDITION whose message carries a
 * `console.firebase.google.com/.../create_composite=...` index-creation
 * URL) are stored in full on the `IntelligenceRun` summary so the
 * observatory drill-down can render the complete message and extract the
 * link — capped defensively so a pathological error (a huge stack trace
 * concatenated into `.message`) can't bloat the run document.
 */
const MAX_DETECTOR_ERROR_LENGTH = 4000;

/** Truncate an error message to `MAX_DETECTOR_ERROR_LENGTH`, marking cuts. */
function capDetectorErrorMessage(message: string): string {
  if (message.length <= MAX_DETECTOR_ERROR_LENGTH) return message;
  return `${message.slice(0, MAX_DETECTOR_ERROR_LENGTH)}… [truncated]`;
}

/** Options accepted by `run()` / `runForAdmin()`. */
export interface IntelligenceRunOptions {
  trigger?: IntelligenceRunTrigger;
  triggered_by?: string;
}

/**
 * Orchestrates a scheduled intelligence run:
 *   1. Build a DetectorContext (Firestore-backed by default).
 *   2. Load existing non-terminal `intelligence_signature` values for dedup.
 *   3. Read detector enable flags from `intelligence_config/detectors`.
 *   4. Run each enabled detector in its own try/catch — one detector's
 *      failure never poisons the whole run.
 *   5. For each DetectionResult whose signature is NOT already live, persist
 *      it as either an in-place `intelligence_flags[]` entry on the target
 *      case or a workspace-level `intelligence_nudge` event.
 *   6. Persist an `IntelligenceRun` record with per-detector summaries; emit
 *      the workspace_event heartbeat (best-effort, never aborts the run).
 *
 * Dedup semantics:
 *   Signatures are only considered "live" when attached to a non-terminal
 *   case flag or unresolved workspace nudge. If the operator dismisses or
 *   resolves the signal and the underlying issue persists, the next run can
 *   surface it again.
 */
export class IntelligenceService {
  private readonly runHistoryRepository: RunHistoryRepository;
  private readonly detectorConfigRepository: DetectorConfigRepository;

  constructor(
    private readonly detectors: Detector[],
    // Phase 1: caseService / evidenceService are no longer used by the service
    // — detectors flag the target case in place or emit a nudge. The
    // constructor still accepts them so positional callers/tests don't break.
    _caseService = new CaseService(),
    _evidenceService = new EvidenceService(),
    private readonly caseRepo = new CaseRepository(),
    private readonly clientVersion: string = DEFAULT_CLIENT_VERSION,
    /**
     * Lock acquirer — defaults to the Firestore-backed implementation. Tests
     * pass a stub that either resolves to a fake handle or throws
     * IntelligenceLockHeldError to simulate contention.
     */
    private readonly lockAcquirer: IntelligenceLockAcquirer = () => acquireIntelligenceRunLock(),
    /**
     * Emits a workspace-level event after every completed run so the
     * scheduler's activity is visible in /activity even when no cases are
     * created. Injectable for tests.
     */
    private readonly workspaceEventService: WorkspaceEventService = new WorkspaceEventService(),
    runHistoryRepository?: RunHistoryRepository,
    detectorConfigRepository?: DetectorConfigRepository,
  ) {
    this.runHistoryRepository = runHistoryRepository ?? new RunHistoryRepository();
    this.detectorConfigRepository = detectorConfigRepository ?? new DetectorConfigRepository();
  }

  /**
   * Legacy entrypoint — returns per-detector legacy summaries
   * (`detector` / `cases_created` / `cases_skipped_existing` / ...). The
   * secret-gated `/api/intelligence/run` route uses this signature and the
   * HTTP response shape is covered by existing tests.
   *
   * New callers (admin UI, observatory) should prefer `runForAdmin()` which
   * returns the richer `IntelligenceRun` record.
   */
  async run(
    ctxOverride?: DetectorContext,
    options: IntelligenceRunOptions = {},
  ): Promise<DetectorRunSummary[]> {
    const { legacySummaries } = await this.runCore(ctxOverride, options);
    return legacySummaries;
  }

  /**
   * Admin entrypoint — returns the fully-built `IntelligenceRun` record
   * (already persisted). Used by the admin-auth run-now route so the
   * observatory UI can render the run's detail page without a second
   * round-trip.
   */
  async runForAdmin(
    options: IntelligenceRunOptions = {},
    ctxOverride?: DetectorContext,
  ): Promise<IntelligenceRun> {
    const { run } = await this.runCore(ctxOverride, options);
    return run;
  }

  /**
   * Shared core for both public entrypoints. Holds the lock, executes the
   * detector loop, persists the `IntelligenceRun`, and emits the
   * workspace_event.
   *
   * Wraps the whole run in a Firestore lock (`intelligence_locks/run:intelligence`)
   * so two concurrent invocations can't both snapshot existingSignatures and
   * double-write cases. The second call throws IntelligenceLockHeldError;
   * the endpoint maps that to 409.
   */
  private async runCore(
    ctxOverride: DetectorContext | undefined,
    options: IntelligenceRunOptions,
  ): Promise<{ run: IntelligenceRun; legacySummaries: DetectorRunSummary[] }> {
    const trigger: IntelligenceRunTrigger = options.trigger ?? 'scheduler';
    const triggered_by = options.triggered_by;

    const lock = await this.lockAcquirer();
    const runId = generateId('intelligenceRun');
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    const legacySummaries: DetectorRunSummary[] = [];
    const sharedSummaries: SharedDetectorRunSummary[] = [];
    let runError: string | undefined;

    try {
      // Load config up-front — a single Firestore read for the whole run.
      // Any error here is fatal for the run (we need to know which detectors
      // to skip); falling back to "all enabled" on error would be surprising.
      let configMap: DetectorConfigMap;
      try {
        configMap = await this.detectorConfigRepository.getAll();
      } catch (cfgErr) {
        console.error('[intelligence] detector config read failed:', cfgErr);
        // Treat as empty (all enabled) rather than aborting the run —
        // config unavailability shouldn't silently disable detectors.
        configMap = {};
      }

      const ctx: DetectorContext = ctxOverride ?? new FirestoreDetectorContext();
      const existingSignatures = await ctx.getExistingSignatures();

      for (const detector of this.detectors) {
        // Unknown detector ids default to enabled (true) — a newly-added
        // detector should run without requiring a prior config write.
        const enabled = configMap[detector.id]?.enabled ?? true;

        if (!enabled) {
          legacySummaries.push({
            detector: detector.id,
            cases_created: 0,
            cases_skipped_existing: 0,
            duration_ms: 0,
          });
          sharedSummaries.push({
            detector_id: detector.id,
            enabled: false,
            finding_count: 0,
            duration_ms: 0,
          });
          continue;
        }

        const started = Date.now();
        let casesCreated = 0;
        let skippedExisting = 0;
        let errorMessage: string | undefined;

        try {
          const detections = await detector.run(ctx);
          for (const d of detections) {
            if (existingSignatures.has(d.signature)) {
              skippedExisting++;
              continue;
            }
            try {
              await this.persistDetection(d);
              existingSignatures.add(d.signature);
              casesCreated++;
            } catch (persistErr) {
              console.error(
                `[intelligence] persist failed for detector=${detector.id} signature=${d.signature}:`,
                persistErr,
              );
              errorMessage = errorMessage ?? `persist failed: ${(persistErr as Error).message}`;
            }
          }
        } catch (runErr) {
          errorMessage = (runErr as Error).message || String(runErr);
          console.error(`[intelligence] detector ${detector.id} failed:`, runErr);
        }

        const duration_ms = Date.now() - started;
        const cappedError = errorMessage ? capDetectorErrorMessage(errorMessage) : undefined;
        legacySummaries.push({
          detector: detector.id,
          cases_created: casesCreated,
          cases_skipped_existing: skippedExisting,
          duration_ms,
          ...(cappedError ? { error: cappedError } : {}),
        });
        sharedSummaries.push({
          detector_id: detector.id,
          enabled: true,
          finding_count: casesCreated,
          duration_ms,
          ...(cappedError ? { error: cappedError } : {}),
        });
      }
    } catch (coreErr) {
      // Something outside the per-detector try/catch blew up (e.g. context
      // init, existingSignatures read). Record it on the run row; callers
      // still get whatever summaries accumulated.
      runError = (coreErr as Error).message || String(coreErr);
      console.error('[intelligence] run core failed:', coreErr);
    }

    const finishedAtMs = Date.now();
    const durationMs = finishedAtMs - startedAtMs;
    const run: IntelligenceRun = {
      run_id: runId,
      started_at: startedAt,
      finished_at: new Date(finishedAtMs).toISOString(),
      duration_ms: durationMs,
      trigger,
      ...(triggered_by ? { triggered_by } : {}),
      detector_count: this.detectors.length,
      findings_total: sharedSummaries.reduce((acc, s) => acc + s.finding_count, 0),
      summaries: sharedSummaries,
      ...(runError ? { error: runError } : {}),
    };

    // Persist the run record — best-effort; a Firestore write failure here
    // should never abort the run result. Logging at warn keeps ops aware.
    try {
      await this.runHistoryRepository.create(run);
    } catch (persistErr) {
      console.warn('[intelligence] run history persist failed:', persistErr);
    }

    // Emit a workspace event for every run — success or failure — so the
    // scheduler's heartbeat is visible in /activity even when no cases are
    // created. Failures here are swallowed: the caller's run result should
    // not depend on activity-feed bookkeeping.
    try {
      await this.emitRunWorkspaceEvent(legacySummaries, durationMs, runId);
    } catch (emitErr) {
      console.error('[intelligence] workspace_event emit failed:', emitErr);
    }
    // Best-effort release — don't mask the original error if delete fails.
    try {
      await lock.release();
    } catch (releaseErr) {
      console.error('[intelligence] lock release failed:', releaseErr);
    }

    return { run, legacySummaries };
  }

  /**
   * Build and write the per-run WorkspaceEvent. Runs after the detector
   * loop so it fires even when the detector loop exits abnormally (context
   * init failure, etc.). `summaries` may therefore be empty.
   *
   * The `run_id` is included in the evidence payload so the Signal-Feed
   * drawer (PR 2) and future observatory deep-links can navigate to run
   * detail without a secondary lookup.
   */
  private async emitRunWorkspaceEvent(
    summaries: DetectorRunSummary[],
    durationMs: number,
    runId: string,
  ): Promise<void> {
    const casesCreated = summaries.reduce((acc, s) => acc + s.cases_created, 0);
    const casesSkipped = summaries.reduce((acc, s) => acc + s.cases_skipped_existing, 0);
    const errors = summaries.filter((s) => !!s.error).length;

    const summary =
      `Ran ${summaries.length} detector${summaries.length === 1 ? '' : 's'}` +
      ` — ${casesCreated} new nudge${casesCreated === 1 ? '' : 's'},` +
      ` ${casesSkipped} deduped,` +
      ` ${errors} error${errors === 1 ? '' : 's'}` +
      ` (duration ${durationMs}ms)`;

    await this.workspaceEventService.record({
      type: 'intelligence_run',
      actor_user_id: INTELLIGENCE_ACTOR_ID,
      actor_metadata: intelligenceActorMetadata(this.clientVersion),
      summary,
      evidence: {
        run_id: runId,
        cases_created: casesCreated,
        cases_skipped_existing: casesSkipped,
        errors,
        duration_ms: durationMs,
        detectors: summaries.map((s) => ({
          detector: s.detector,
          cases_created: s.cases_created,
          cases_skipped_existing: s.cases_skipped_existing,
          duration_ms: s.duration_ms,
          ...(s.error ? { error: s.error } : {}),
        })),
      },
    });
  }

  /**
   * Phase 1 of the detector refactor: detectors never create autonomous cases.
   * Case-targeted detections flag the case in place; branch/project-targeted
   * detections emit a workspace_event nudge. Dedup at the call site
   * (existingSignatures) prevents redundant writes within a single run; the
   * detector self-skip on `intelligence_flags` (defense-in-depth) prevents
   * detectors from observing their own flags as fresh signal.
   */
  private async persistDetection(d: DetectionResult): Promise<void> {
    if (d.target_kind === 'case') {
      await this.flagCase(d);
      return;
    }
    await this.emitNudge(d);
  }

  /** Upsert an IntelligenceFlag onto the target case (drop existing entry with
   * matching signature, append new). Skips silently when the case is missing —
   * an intelligence finding shouldn't fail the run just because the target was
   * deleted between detection and persist. */
  private async flagCase(d: DetectionResult): Promise<void> {
    let target: Case;
    try {
      target = await this.caseRepo.getById(d.target_id);
    } catch (err) {
      if (err instanceof NotFoundError) {
        console.warn(
          `[intelligence] flagCase: target case missing detector=${d.detector_id} case_id=${d.target_id}`,
        );
        return;
      }
      throw err;
    }

    const flaggedAt = new Date().toISOString();
    const nextFlag: IntelligenceFlag = {
      detector_id: d.detector_id,
      signature: d.signature,
      severity: d.severity,
      summary: d.summary,
      evidence: d.evidence,
      flagged_at: flaggedAt,
    };
    const existing = target.intelligence_flags ?? [];
    const intelligence_flags = [
      ...existing.filter((f) => f.signature !== d.signature),
      nextFlag,
    ];

    await this.caseRepo.update(target.case_id, {
      intelligence_flags,
      updated_at: flaggedAt,
    });
  }

  /** Emit a workspace_event nudge for branch/project-targeted detections. */
  private async emitNudge(d: DetectionResult): Promise<void> {
    await this.workspaceEventService.record({
      type: 'intelligence_nudge',
      actor_user_id: INTELLIGENCE_ACTOR_ID,
      actor_metadata: intelligenceActorMetadata(this.clientVersion),
      summary: d.title,
      evidence: {
        detector_id: d.detector_id,
        signature: d.signature,
        severity: d.severity,
        summary: d.summary,
        target_kind: d.target_kind,
        target_id: d.target_id,
        project_id: d.project_id,
        ...(d.repository_id ? { repository_id: d.repository_id } : {}),
        ...d.evidence,
      },
    });
  }
}

/**
 * Delimiter between the human-readable summary and the JSON payload tail.
 * Consumers MUST split on the LAST occurrence — a summary legitimately
 * containing `---` on its own line would otherwise clip the payload.
 */
export const EVIDENCE_SUMMARY_DELIMITER = '\n\n---\n';

/**
 * The evidence payload is encoded into `summary` as a JSON tail delimited by
 * `EVIDENCE_SUMMARY_DELIMITER`. This keeps the human-readable summary on top
 * and lets programmatic consumers (including the intelligence dashboard,
 * future) parse the detection payload deterministically without needing a
 * schema change to the Evidence type.
 */
function formatEvidenceSummary(d: DetectionResult): string {
  const payload = {
    detector_id: d.detector_id,
    signature: d.signature,
    severity: d.severity,
    evidence: d.evidence,
    client_name: INTELLIGENCE_CLIENT_NAME,
  };
  return `${d.summary}${EVIDENCE_SUMMARY_DELIMITER}${JSON.stringify(payload)}`;
}

export interface ParsedEvidenceSummary {
  summary: string;
  payload: {
    detector_id: string;
    signature: string;
    severity: string;
    evidence: Record<string, unknown>;
    client_name: string;
  };
}

/**
 * Decode a `detection_report` evidence `summary` back into the human-readable
 * head and the structured payload tail. Throws when the input doesn't carry a
 * payload tail or the tail isn't valid JSON — callers should treat a thrown
 * result as "this evidence wasn't produced by the intelligence scheduler".
 *
 * The split is always on the LAST occurrence of the delimiter so a summary
 * that legitimately contains `---` on its own line still round-trips.
 */
export function parseEvidenceSummary(raw: string): ParsedEvidenceSummary {
  const idx = raw.lastIndexOf(EVIDENCE_SUMMARY_DELIMITER);
  if (idx === -1) {
    throw new Error('evidence summary missing JSON payload delimiter');
  }
  const summary = raw.slice(0, idx);
  const jsonTail = raw.slice(idx + EVIDENCE_SUMMARY_DELIMITER.length);
  let payload: ParsedEvidenceSummary['payload'];
  try {
    payload = JSON.parse(jsonTail) as ParsedEvidenceSummary['payload'];
  } catch (err) {
    throw new Error(`evidence summary JSON tail is invalid: ${(err as Error).message}`);
  }
  return { summary, payload };
}

/** Exported for unit tests. */
export const _formatEvidenceSummary = formatEvidenceSummary;

/** Exported for unit tests. */
export const _capDetectorErrorMessage = capDetectorErrorMessage;
export const _MAX_DETECTOR_ERROR_LENGTH = MAX_DETECTOR_ERROR_LENGTH;

/** Assert-only helper used to satisfy TS exhaustiveness elsewhere. */
export type _CaseForTest = Case;
