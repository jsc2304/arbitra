import { describe, it, expect, vi } from 'vitest';
import type { Case, DetectorConfigMap, IntelligenceRun } from '@arbitra/shared';
import {
  IntelligenceService,
  _formatEvidenceSummary,
  parseEvidenceSummary,
  EVIDENCE_SUMMARY_DELIMITER,
} from '../intelligence-service.js';
import { IntelligenceLockHeldError } from '../intelligence-lock.js';
import { makeStubContext } from './test-helpers.js';
import type { Detector, DetectionResult } from '../detector-types.js';
import type { RunHistoryRepository } from '../run-history-repository.js';
import type { DetectorConfigRepository } from '../detector-config-repository.js';

function makeStubRepos(configMap: DetectorConfigMap = {}) {
  const runsCreated: IntelligenceRun[] = [];
  const runHistoryRepository = {
    create: vi.fn(async (run: IntelligenceRun) => {
      runsCreated.push(run);
    }),
    get: vi.fn(async () => undefined),
    list: vi.fn(async () => ({ runs: [] })),
  } as unknown as RunHistoryRepository;

  const detectorConfigRepository = {
    getAll: vi.fn(async () => configMap),
    setEnabled: vi.fn(async () => ({ enabled: true })),
  } as unknown as DetectorConfigRepository;

  return { runHistoryRepository, detectorConfigRepository, runsCreated };
}

function fakeDetection(id: string, targetId: string): DetectionResult {
  return {
    detector_id: id,
    signature: `${id}:case:${targetId}`,
    target_kind: 'case',
    target_id: targetId,
    title: `${id} hit`,
    summary: 'payload',
    evidence: { case_id: targetId },
    severity: 'low',
    project_id: 'proj_1',
    repository_id: 'repo_1',
  };
}

function makeServiceWithSpies(detectors: Detector[], configMap: DetectorConfigMap = {}) {
  const createdCases: Partial<Case>[] = [];
  const caseService = {
    createCase: vi.fn(async (input, actorId) => {
      const c: Case = {
        case_id: 'case_' + Math.random().toString(36).slice(2, 8),
        title: input.title,
        description: input.description,
        source_type: input.source_type,
        source_ref: input.source_ref ?? '',
        project_id: input.project_id,
        repository_id: input.repository_id,
        owner_user_id: actorId,
        status: 'open',
        validation_track: 'direct',
        risk_level: input.risk_level,
        priority: input.priority,
        active_rule_set_refs: [],
        knowledge_context_refs: [],
        decision_ready: false,
        created_at: '',
        updated_at: '',
      };
      createdCases.push({ title: c.title, project_id: c.project_id });
      return c;
    }),
  } as never;
  const evidenceCalls: { case_id: string; type: string }[] = [];
  const evidenceService = {
    registerEvidence: vi.fn(async (input) => {
      evidenceCalls.push({ case_id: input.case_id, type: input.type });
      return { evidence_id: 'ev_1', ...input } as never;
    }),
  } as never;
  const repoUpdates: Record<string, unknown>[] = [];
  const flaggedCases = new Map<string, Case>();
  const caseRepo = {
    update: vi.fn(async (id: string, updates: Partial<Case>) => {
      repoUpdates.push(updates);
      const prev = flaggedCases.get(id) ?? ({ case_id: id } as Case);
      flaggedCases.set(id, { ...prev, ...updates });
      return {} as never;
    }),
    // Phase 1: flagCase() reads the target case before upserting flags.
    // Return a minimal Case so the flag-write path can complete in tests.
    getById: vi.fn(async (id: string) => {
      const existing = flaggedCases.get(id);
      if (existing) return existing;
      return {
        case_id: id,
        title: '',
        description: '',
        source_type: 'manual',
        source_ref: '',
        project_id: 'proj_1',
        repository_id: 'repo_1',
        owner_user_id: 'usr_owner',
        status: 'open',
        validation_track: 'direct',
        risk_level: 'low',
        priority: 'normal',
        active_rule_set_refs: [],
        knowledge_context_refs: [],
        decision_ready: false,
        created_at: '',
        updated_at: '',
      } as Case;
    }),
  } as never;

  const releaseMock = vi.fn(async () => {});
  const lockAcquirer = vi.fn(async () => ({ holder: 'test-holder', release: releaseMock }));
  const workspaceEventRecord = vi.fn(async (input) => ({
    event_id: 'wse_test',
    timestamp: '2026-04-19T00:00:00.000Z',
    ...input,
  }));
  const workspaceEventService = { record: workspaceEventRecord } as never;
  const { runHistoryRepository, detectorConfigRepository, runsCreated } =
    makeStubRepos(configMap);
  const service = new IntelligenceService(
    detectors,
    caseService,
    evidenceService,
    caseRepo,
    '9.9.9',
    lockAcquirer,
    workspaceEventService,
    runHistoryRepository,
    detectorConfigRepository,
  );
  return {
    service,
    createdCases,
    evidenceCalls,
    repoUpdates,
    caseService,
    evidenceService,
    lockAcquirer,
    releaseMock,
    workspaceEventService,
    workspaceEventRecord,
    runHistoryRepository,
    detectorConfigRepository,
    runsCreated,
  };
}

describe('IntelligenceService.run', () => {
  it('flags target case once per detection (no autonomous case creation) and skips existing signatures', async () => {
    const det: Detector = {
      id: 'det-a',
      run: async () => [fakeDetection('det-a', 'case_1'), fakeDetection('det-a', 'case_2')],
    };
    const { service, createdCases, evidenceCalls, repoUpdates } = makeServiceWithSpies([det]);

    const ctx = makeStubContext({ existingSignatures: ['det-a:case:case_1'] });
    const summaries = await service.run(ctx);

    expect(summaries).toHaveLength(1);
    expect(summaries[0].cases_created).toBe(1);
    expect(summaries[0].cases_skipped_existing).toBe(1);
    // Phase 1: detectors never create autonomous cases anymore.
    expect(createdCases).toHaveLength(0);
    expect(evidenceCalls).toHaveLength(0);
    // The non-deduped detection flagged its target case in place.
    expect(repoUpdates).toHaveLength(1);
    expect(repoUpdates[0]).toMatchObject({
      intelligence_flags: expect.arrayContaining([
        expect.objectContaining({
          detector_id: 'det-a',
          signature: 'det-a:case:case_2',
        }),
      ]),
    });
  });

  it('isolates per-detector failures — one detector throwing does not poison others', async () => {
    const bad: Detector = {
      id: 'det-bad',
      run: async () => {
        throw new Error('kaboom');
      },
    };
    const good: Detector = {
      id: 'det-good',
      run: async () => [fakeDetection('det-good', 'case_x')],
    };
    const { service, createdCases } = makeServiceWithSpies([bad, good]);

    const summaries = await service.run(makeStubContext());
    const badSummary = summaries.find((s) => s.detector === 'det-bad')!;
    const goodSummary = summaries.find((s) => s.detector === 'det-good')!;

    expect(badSummary.error).toMatch(/kaboom/);
    expect(badSummary.cases_created).toBe(0);
    expect(goodSummary.error).toBeUndefined();
    expect(goodSummary.cases_created).toBe(1);
    // Phase 1: no autonomous case creation; the good detection flagged its target.
    expect(createdCases).toHaveLength(0);
  });

  it('deduplicates within a single run — two detections with same signature write one flag', async () => {
    const det: Detector = {
      id: 'det-dup',
      run: async () => [
        fakeDetection('det-dup', 'case_a'),
        fakeDetection('det-dup', 'case_a'),
      ],
    };
    const { service, createdCases, repoUpdates } = makeServiceWithSpies([det]);
    const summaries = await service.run(makeStubContext());
    // Phase 1: dedup is now measured by flag-writes, not case-writes.
    expect(createdCases).toHaveLength(0);
    expect(repoUpdates).toHaveLength(1);
    expect(summaries[0].cases_created).toBe(1);
    expect(summaries[0].cases_skipped_existing).toBe(1);
  });

  it('acquires and releases the lock on a successful run', async () => {
    const det: Detector = {
      id: 'det-lock',
      run: async () => [fakeDetection('det-lock', 'case_1')],
    };
    const { service, lockAcquirer, releaseMock } = makeServiceWithSpies([det]);
    await service.run(makeStubContext());
    expect(lockAcquirer).toHaveBeenCalledTimes(1);
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it('releases the lock even when a detector throws', async () => {
    const bad: Detector = {
      id: 'det-bad',
      run: async () => {
        throw new Error('kaboom');
      },
    };
    const { service, releaseMock } = makeServiceWithSpies([bad]);
    await service.run(makeStubContext());
    // per-detector failure is isolated — run() still resolves, but the lock
    // must still be released in finally
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it('emits exactly one workspace_event per run with an aggregated summary', async () => {
    const det: Detector = {
      id: 'det-ws',
      run: async () => [
        fakeDetection('det-ws', 'case_new'),
        fakeDetection('det-ws', 'case_seen'),
      ],
    };
    const { service, workspaceEventRecord } = makeServiceWithSpies([det]);
    await service.run(
      makeStubContext({ existingSignatures: ['det-ws:case:case_seen'] }),
    );
    expect(workspaceEventRecord).toHaveBeenCalledTimes(1);
    const [input] = workspaceEventRecord.mock.calls[0]!;
    expect(input).toMatchObject({
      type: 'intelligence_run',
      actor_user_id: 'system:arbitra-intelligence',
      actor_metadata: { client_name: 'arbitra-intelligence', client_version: '9.9.9' },
    });
    // Summary reports 1 new nudge, 1 dedup, 0 errors.
    expect(input.summary).toMatch(/1 new nudge/);
    expect(input.summary).toMatch(/1 deduped/);
    expect(input.summary).toMatch(/0 error/);
    // Evidence carries the per-detector breakdown.
    const evidence = input.evidence as Record<string, unknown>;
    expect(evidence.cases_created).toBe(1);
    expect(evidence.cases_skipped_existing).toBe(1);
    expect(evidence.errors).toBe(0);
    expect(Array.isArray(evidence.detectors)).toBe(true);
  });

  it('still emits a workspace_event when every detector fails (no cases created)', async () => {
    const bad1: Detector = {
      id: 'det-bad-1',
      run: async () => {
        throw new Error('one');
      },
    };
    const bad2: Detector = {
      id: 'det-bad-2',
      run: async () => {
        throw new Error('two');
      },
    };
    const { service, workspaceEventRecord } = makeServiceWithSpies([bad1, bad2]);
    await service.run(makeStubContext());
    expect(workspaceEventRecord).toHaveBeenCalledTimes(1);
    const [input] = workspaceEventRecord.mock.calls[0]!;
    expect(input.summary).toMatch(/0 new nudges/);
    expect(input.summary).toMatch(/2 errors/);
    const evidence = input.evidence as Record<string, unknown>;
    expect(evidence.errors).toBe(2);
    expect(evidence.cases_created).toBe(0);
  });

  it('workspace_event write failure does not break the run result', async () => {
    const det: Detector = {
      id: 'det-ok',
      run: async () => [fakeDetection('det-ok', 'case_1')],
    };
    const { service, workspaceEventRecord, releaseMock } = makeServiceWithSpies([det]);
    workspaceEventRecord.mockRejectedValueOnce(new Error('firestore down'));

    // Must not throw — activity-feed bookkeeping is never load-bearing.
    const summaries = await service.run(makeStubContext());
    expect(summaries).toHaveLength(1);
    expect(summaries[0].cases_created).toBe(1);
    // Lock must still release even when the workspace_event write errors.
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a second concurrent run with LOCK_HELD and leaves the first untouched', async () => {
    // Simulate: first caller acquires the lock and is mid-flight;
    // second caller tries to acquire while it's still held and must throw.
    const detA: Detector = {
      id: 'det-concurrent',
      run: async () => [fakeDetection('det-concurrent', 'case_first')],
    };
    const detB: Detector = {
      id: 'det-concurrent',
      run: async () => [fakeDetection('det-concurrent', 'case_second')],
    };

    // Shared lock flag toggled by a Firestore-like acquire transaction.
    let locked = false;
    const makeAcquirer = () => async () => {
      if (locked) throw new IntelligenceLockHeldError();
      locked = true;
      return {
        holder: 'h',
        release: async () => {
          locked = false;
        },
      };
    };

    const caseService = {
      createCase: vi.fn(async (input) => ({
        case_id: 'case_' + Math.random().toString(36).slice(2, 8),
        title: input.title,
        description: input.description ?? '',
        source_type: input.source_type,
        source_ref: input.source_ref ?? '',
        project_id: input.project_id,
        repository_id: input.repository_id,
        owner_user_id: 'sys',
        status: 'open',
        validation_track: 'direct',
        risk_level: input.risk_level,
        priority: input.priority,
        active_rule_set_refs: [],
        knowledge_context_refs: [],
        decision_ready: false,
        created_at: '',
        updated_at: '',
      } as Case)),
    } as never;
    const evidenceService = { registerEvidence: vi.fn(async () => ({}) as never) } as never;
    const caseRepo = { update: vi.fn(async () => ({}) as never) } as never;
    const acquirer = makeAcquirer();
    // Shared stub so the concurrent-lock harness doesn't accidentally reach
    // the real Firestore-backed WorkspaceEventService default.
    const wsStub = { record: vi.fn(async () => ({}) as never) } as never;

    // Gate detectorA's run() on a promise that completes only after detectorB
    // has attempted (and failed) to acquire the lock. This simulates true
    // overlap without depending on setTimeout flakiness.
    let releaseA: () => void;
    const aGate = new Promise<void>((r) => {
      releaseA = r;
    });
    const detAGated: Detector = {
      id: 'det-concurrent',
      run: async () => {
        await aGate;
        return detA.run(makeStubContext());
      },
    };

    const reposA = makeStubRepos();
    const reposB = makeStubRepos();
    const serviceA = new IntelligenceService(
      [detAGated],
      caseService,
      evidenceService,
      caseRepo,
      '9.9.9',
      acquirer,
      wsStub,
      reposA.runHistoryRepository,
      reposA.detectorConfigRepository,
    );
    const serviceB = new IntelligenceService(
      [detB],
      caseService,
      evidenceService,
      caseRepo,
      '9.9.9',
      acquirer,
      wsStub,
      reposB.runHistoryRepository,
      reposB.detectorConfigRepository,
    );

    const pA = serviceA.run(makeStubContext());
    // Yield so pA acquires the lock.
    await new Promise((r) => setImmediate(r));

    await expect(serviceB.run(makeStubContext())).rejects.toBeInstanceOf(IntelligenceLockHeldError);

    // Let A finish; it should still succeed and release the lock.
    releaseA!();
    await pA;

    // After A completes, a third call should acquire (lock released).
    const reposC = makeStubRepos();
    const serviceC = new IntelligenceService(
      [detB],
      caseService,
      evidenceService,
      caseRepo,
      '9.9.9',
      acquirer,
      wsStub,
      reposC.runHistoryRepository,
      reposC.detectorConfigRepository,
    );
    await expect(serviceC.run(makeStubContext())).resolves.toBeDefined();
  });

  it('skips disabled detectors — their run() is never invoked and the summary is marked disabled', async () => {
    const enabledRun = vi.fn(async () => [fakeDetection('det-on', 'case_1')]);
    const disabledRun = vi.fn(async () => [fakeDetection('det-off', 'case_2')]);
    const enabled: Detector = { id: 'det-on', run: enabledRun };
    const disabled: Detector = { id: 'det-off', run: disabledRun };

    const { service, runsCreated } = makeServiceWithSpies(
      [enabled, disabled],
      { 'det-off': { enabled: false } },
    );
    await service.run(makeStubContext());

    expect(enabledRun).toHaveBeenCalledTimes(1);
    expect(disabledRun).not.toHaveBeenCalled();

    // Run doc records both detectors, with the disabled one marked
    // `enabled: false` and zero findings.
    expect(runsCreated).toHaveLength(1);
    const run = runsCreated[0]!;
    const onSummary = run.summaries.find((s) => s.detector_id === 'det-on')!;
    const offSummary = run.summaries.find((s) => s.detector_id === 'det-off')!;
    expect(onSummary.enabled).toBe(true);
    expect(onSummary.finding_count).toBe(1);
    expect(offSummary.enabled).toBe(false);
    expect(offSummary.finding_count).toBe(0);
    expect(offSummary.duration_ms).toBe(0);
  });

  it('writes a run doc on success with trigger/triggered_by populated', async () => {
    const det: Detector = {
      id: 'det-trig',
      run: async () => [fakeDetection('det-trig', 'case_1')],
    };
    const { service, runsCreated } = makeServiceWithSpies([det]);
    const result = await service.runForAdmin(
      { trigger: 'manual', triggered_by: 'usr_admin' },
      makeStubContext(),
    );

    expect(runsCreated).toHaveLength(1);
    expect(result.trigger).toBe('manual');
    expect(result.triggered_by).toBe('usr_admin');
    expect(result.findings_total).toBe(1);
    expect(result.detector_count).toBe(1);
    expect(result.run_id).toMatch(/^irun_/);
    expect(result.started_at).toBeTruthy();
    expect(result.finished_at).toBeTruthy();
  });

  it("default trigger is 'scheduler' and triggered_by is absent", async () => {
    const det: Detector = {
      id: 'det-default',
      run: async () => [],
    };
    const { service, runsCreated } = makeServiceWithSpies([det]);
    await service.run(makeStubContext());

    expect(runsCreated).toHaveLength(1);
    expect(runsCreated[0]!.trigger).toBe('scheduler');
    expect(runsCreated[0]!.triggered_by).toBeUndefined();
  });

  it('still writes a run doc when a detector fails — per-detector error is captured in its summary', async () => {
    const bad: Detector = {
      id: 'det-bad',
      run: async () => {
        throw new Error('kaboom');
      },
    };
    const good: Detector = {
      id: 'det-good',
      run: async () => [fakeDetection('det-good', 'case_x')],
    };
    const { service, runsCreated } = makeServiceWithSpies([bad, good]);
    await service.run(makeStubContext());

    expect(runsCreated).toHaveLength(1);
    const run = runsCreated[0]!;
    const badSummary = run.summaries.find((s) => s.detector_id === 'det-bad')!;
    const goodSummary = run.summaries.find((s) => s.detector_id === 'det-good')!;
    expect(badSummary.error).toMatch(/kaboom/);
    expect(badSummary.finding_count).toBe(0);
    expect(goodSummary.error).toBeUndefined();
    expect(goodSummary.finding_count).toBe(1);
  });

  it('persists the full error message, including a Firestore create-index URL, on the summary', async () => {
    const indexUrl =
      'https://console.firebase.google.com/project/demo-arbitra/firestore/indexes?create_composite=Ck9wcm9qZWN0cy9kZW1vLWFyYml0cmEvZGF0YWJhc2VzLw';
    const message = `9 FAILED_PRECONDITION: The query requires an index. You can create it here: ${indexUrl}`;
    const bad: Detector = {
      id: 'det-index-missing',
      run: async () => {
        throw new Error(message);
      },
    };
    const { service, runsCreated } = makeServiceWithSpies([bad]);
    await service.run(makeStubContext());

    const run = runsCreated[0]!;
    const summary = run.summaries.find((s) => s.detector_id === 'det-index-missing')!;
    // The full message (including the URL) is stored — not just a first
    // line — so the observatory drill-down can extract the console link.
    expect(summary.error).toBe(message);
  });

  it('caps a pathologically long detector error message rather than storing it unbounded', async () => {
    const hugeMessage = 'x'.repeat(10_000);
    const bad: Detector = {
      id: 'det-huge-error',
      run: async () => {
        throw new Error(hugeMessage);
      },
    };
    const { service, runsCreated } = makeServiceWithSpies([bad]);
    await service.run(makeStubContext());

    const run = runsCreated[0]!;
    const summary = run.summaries.find((s) => s.detector_id === 'det-huge-error')!;
    expect(summary.error).toBeDefined();
    expect(summary.error!.length).toBeLessThan(hugeMessage.length);
    expect(summary.error!.length).toBeLessThanOrEqual(4000 + '… [truncated]'.length);
    expect(summary.error).toMatch(/\[truncated\]$/);
  });

  it('includes run_id in the workspace_event evidence', async () => {
    const det: Detector = {
      id: 'det-ws-run-id',
      run: async () => [fakeDetection('det-ws-run-id', 'case_1')],
    };
    const { service, workspaceEventRecord, runsCreated } = makeServiceWithSpies([det]);
    await service.run(makeStubContext());

    expect(workspaceEventRecord).toHaveBeenCalledTimes(1);
    const [input] = workspaceEventRecord.mock.calls[0]!;
    const evidence = input.evidence as Record<string, unknown>;
    expect(evidence.run_id).toBe(runsCreated[0]!.run_id);
  });

  it('run doc persist failure does not break the run result', async () => {
    const det: Detector = {
      id: 'det-persist-fail',
      run: async () => [fakeDetection('det-persist-fail', 'case_1')],
    };
    const { service, runHistoryRepository } = makeServiceWithSpies([det]);
    // Swap the create impl to throw.
    (runHistoryRepository.create as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('firestore down'),
    );

    // Must not throw.
    const summaries = await service.run(makeStubContext());
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.cases_created).toBe(1);
  });

  it('unknown detector ids default to enabled (new detector added without config write)', async () => {
    // Config map has an entry for a different detector, but nothing for
    // 'det-fresh'. It must still run.
    const freshRun = vi.fn(async () => []);
    const fresh: Detector = { id: 'det-fresh', run: freshRun };
    const { service } = makeServiceWithSpies([fresh], { 'det-other': { enabled: false } });
    await service.run(makeStubContext());
    expect(freshRun).toHaveBeenCalledTimes(1);
  });
});

describe('evidence summary encoding', () => {
  const baseDetection: DetectionResult = {
    detector_id: 'det-enc',
    signature: 'det-enc:case:case_x',
    target_kind: 'case',
    target_id: 'case_x',
    title: 'Case X needs attention',
    summary: 'Case X',
    evidence: { foo: 'bar' },
    severity: 'low',
    project_id: 'proj_1',
  };

  it('round-trips a plain summary through encode / decode', () => {
    const encoded = _formatEvidenceSummary(baseDetection);
    const parsed = parseEvidenceSummary(encoded);
    expect(parsed.summary).toBe('Case X');
    expect(parsed.payload).toMatchObject({
      detector_id: 'det-enc',
      signature: 'det-enc:case:case_x',
      severity: 'low',
      evidence: { foo: 'bar' },
      client_name: 'arbitra-intelligence',
    });
  });

  it('handles a summary that legitimately contains `---` by splitting on the LAST delimiter', () => {
    // A summary whose body happens to include the `---` marker on its own
    // line. Naive parsers splitting on the FIRST `\n\n---\n` would clip
    // the payload — we document (and test) that consumers MUST split on the
    // last occurrence.
    const trickSummary = 'Intro paragraph.\n\n---\nPost-dash note still in summary.';
    const encoded = _formatEvidenceSummary({ ...baseDetection, summary: trickSummary });

    // Sanity: encoded string contains the delimiter at least twice.
    let count = 0;
    let idx = encoded.indexOf(EVIDENCE_SUMMARY_DELIMITER);
    while (idx !== -1) {
      count++;
      idx = encoded.indexOf(EVIDENCE_SUMMARY_DELIMITER, idx + 1);
    }
    expect(count).toBeGreaterThanOrEqual(2);

    const parsed = parseEvidenceSummary(encoded);
    expect(parsed.summary).toBe(trickSummary);
    expect(parsed.payload.evidence).toEqual({ foo: 'bar' });
  });

  it('parseEvidenceSummary throws when the delimiter is absent', () => {
    expect(() => parseEvidenceSummary('plain text only')).toThrow(/missing JSON payload delimiter/);
  });

  it('parseEvidenceSummary throws when the JSON tail is malformed', () => {
    expect(() => parseEvidenceSummary(`summary${EVIDENCE_SUMMARY_DELIMITER}{not-json}`)).toThrow(
      /JSON tail is invalid/,
    );
  });
});
