import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Case, Evidence, CreateEvidenceInput } from '@arbitra/shared';

// ---------------------------------------------------------------------------
// Round-trip test: EvidenceService.registerEvidence must apply
// normalizeActorMetadata before persisting (trim + lowercase client_name &
// model, drop empties, strip unknown keys at the schema layer upstream).
// ---------------------------------------------------------------------------

let __idCounter = 0;
vi.mock('../../lib/ids.js', () => ({
  generateId: (prefix: string) => `${prefix}_test_${++__idCounter}`,
}));

import { EvidenceService } from './evidence-service.js';

function makeCase(overrides: Partial<Case> = {}): Case {
  return {
    case_id: 'case_1',
    title: 'Test',
    description: '',
    source_type: 'manual',
    source_ref: '',
    project_id: 'p1',
    repository_id: 'r1',
    owner_user_id: 'usr_owner',
    status: 'in_build',
    validation_track: 'direct',
    risk_level: 'medium',
    priority: 'normal',
    active_rule_set_refs: [],
    knowledge_context_refs: [],
    decision_ready: false,
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

function makeService() {
  const store = new Map<string, Evidence>();
  const lastCreated: { value: Evidence | null } = { value: null };
  const evidenceRepo = {
    create: vi.fn(async (e: Evidence) => {
      // Persist exactly what the service hands us so dedupe lookups
      // return the same `evidence_id` the caller saw.
      const stored = { ...e };
      store.set(e.evidence_id, stored);
      lastCreated.value = stored;
    }),
    getByCaseId: vi.fn(async () => [] as Evidence[]),
    findFileEditByArtifact: vi.fn(async (caseId: string, artifactRef: string) => {
      for (const ev of store.values()) {
        if (
          ev.case_id === caseId &&
          ev.type === 'file_edit' &&
          ev.artifact_ref === artifactRef
        ) {
          return ev;
        }
      }
      return null;
    }),
    incrementEditCount: vi.fn(async (id: string, updatedAt: string) => {
      const ev = store.get(id);
      if (!ev) return;
      store.set(id, {
        ...ev,
        edit_count: (ev.edit_count ?? 1) + 1,
        updated_at: updatedAt,
      });
    }),
  } as never;
  const completenessEvaluator = {
    evaluate: vi.fn(async () => ({ satisfied: false, missing: [] })),
  } as never;
  const eventService = { emit: vi.fn(async () => ({})) } as never;
  const caseRepo = {
    getById: vi.fn(async () => makeCase()),
    update: vi.fn(async () => undefined),
  } as never;
  const service = new EvidenceService(
    evidenceRepo,
    completenessEvaluator,
    eventService,
    caseRepo,
  );
  return { service, lastCreated, evidenceRepo, eventService, store };
}

describe('EvidenceService.registerEvidence — actor_metadata normalization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lowercases client_name and model, trims client_version on persist', async () => {
    const { service, lastCreated } = makeService();
    const input: CreateEvidenceInput = {
      case_id: 'case_1',
      type: 'ci_result',
      source_type: 'automated',
      actor_metadata: {
        client_name: '  Claude-Code  ',
        client_version: '  1.2.3  ',
        model: 'Claude-Opus-4-7',
      },
    };

    await service.registerEvidence(input, 'user_1');

    expect(lastCreated.value?.actor_metadata).toEqual({
      client_name: 'claude-code',
      client_version: '1.2.3',
      model: 'claude-opus-4-7',
    });
  });

  it('omits actor_metadata when input has none', async () => {
    const { service, lastCreated } = makeService();
    const input: CreateEvidenceInput = {
      case_id: 'case_1',
      type: 'ci_result',
      source_type: 'automated',
    };

    await service.registerEvidence(input, 'user_1');

    expect(lastCreated.value).not.toBeNull();
    expect(lastCreated.value?.actor_metadata).toBeUndefined();
  });

  it('collapses all-empty actor_metadata to undefined on persist', async () => {
    const { service, lastCreated } = makeService();
    const input: CreateEvidenceInput = {
      case_id: 'case_1',
      type: 'ci_result',
      source_type: 'automated',
      actor_metadata: { client_name: '   ', client_version: '', model: '   ' },
    };

    await service.registerEvidence(input, 'user_1');

    expect(lastCreated.value?.actor_metadata).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// file_edit dedupe: repeated `(case_id, artifact_ref)` saves collapse onto
// a single row with an incrementing `edit_count`. Cursor's afterFileEdit
// hook fires per save and otherwise drowns the timeline in noise.
// ---------------------------------------------------------------------------
describe('EvidenceService.registerEvidence — file_edit dedupe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('first file_edit creates a new row with edit_count=1 and emits an event', async () => {
    const { service, store, evidenceRepo, eventService } = makeService();

    const result = await service.registerEvidence(
      {
        case_id: 'case_1',
        type: 'file_edit',
        source_type: 'agent',
        artifact_ref: 'src/foo.tsx',
      },
      'user_1',
    );

    expect(store.size).toBe(1);
    expect(result.edit_count).toBe(1);
    expect(evidenceRepo.incrementEditCount).not.toHaveBeenCalled();
    expect(eventService.emit).toHaveBeenCalledTimes(1);
  });

  it('second file_edit for same artifact_ref updates the same row, increments edit_count, no event', async () => {
    const { service, store, evidenceRepo, eventService } = makeService();

    const first = await service.registerEvidence(
      {
        case_id: 'case_1',
        type: 'file_edit',
        source_type: 'agent',
        artifact_ref: 'src/foo.tsx',
      },
      'user_1',
    );

    // ensure observable timestamp progression
    await new Promise((r) => setTimeout(r, 2));

    const second = await service.registerEvidence(
      {
        case_id: 'case_1',
        type: 'file_edit',
        source_type: 'agent',
        artifact_ref: 'src/foo.tsx',
      },
      'user_1',
    );

    expect(store.size).toBe(1);
    expect(second.evidence_id).toBe(first.evidence_id);
    expect(second.edit_count).toBe(2);
    expect(second.updated_at).toBeDefined();
    expect(second.updated_at).not.toBe(first.created_at);
    expect(evidenceRepo.incrementEditCount).toHaveBeenCalledTimes(1);
    // Only the first create emits an event
    expect(eventService.emit).toHaveBeenCalledTimes(1);
  });

  it('different artifact_ref values produce separate rows', async () => {
    const { service, store } = makeService();

    await service.registerEvidence(
      {
        case_id: 'case_1',
        type: 'file_edit',
        source_type: 'agent',
        artifact_ref: 'src/foo.tsx',
      },
      'user_1',
    );
    await service.registerEvidence(
      {
        case_id: 'case_1',
        type: 'file_edit',
        source_type: 'agent',
        artifact_ref: 'src/bar.tsx',
      },
      'user_1',
    );

    expect(store.size).toBe(2);
  });

  it('non-file_edit types never dedupe even with matching artifact_ref', async () => {
    const { service, store, evidenceRepo, eventService } = makeService();

    await service.registerEvidence(
      {
        case_id: 'case_1',
        type: 'unit_test_result',
        source_type: 'automated',
        artifact_ref: 'src/foo.tsx',
      },
      'user_1',
    );
    await service.registerEvidence(
      {
        case_id: 'case_1',
        type: 'unit_test_result',
        source_type: 'automated',
        artifact_ref: 'src/foo.tsx',
      },
      'user_1',
    );

    expect(store.size).toBe(2);
    expect(evidenceRepo.findFileEditByArtifact).not.toHaveBeenCalled();
    expect(evidenceRepo.incrementEditCount).not.toHaveBeenCalled();
    // Both creates emit events
    expect(eventService.emit).toHaveBeenCalledTimes(2);
  });

  it('file_edit without artifact_ref does not dedupe', async () => {
    const { service, store, evidenceRepo } = makeService();

    await service.registerEvidence(
      {
        case_id: 'case_1',
        type: 'file_edit',
        source_type: 'agent',
      },
      'user_1',
    );
    await service.registerEvidence(
      {
        case_id: 'case_1',
        type: 'file_edit',
        source_type: 'agent',
      },
      'user_1',
    );

    expect(store.size).toBe(2);
    expect(evidenceRepo.findFileEditByArtifact).not.toHaveBeenCalled();
  });
});
