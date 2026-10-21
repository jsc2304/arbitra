import { describe, expect, it, vi } from 'vitest';
import type { Evidence } from '@arbitra/shared';
import { ASSISTANT_TASK_RESULT_SCHEMA } from '@arbitra/shared';

const mockArtifactsGet = vi.fn();
vi.mock('../../lib/firestore.js', () => ({
  collections: {
    artifacts: () => ({ doc: () => ({ get: mockArtifactsGet }) }),
  },
}));

import { AssistantAnswerLookup } from './assistant-answer-lookup.js';

function evidenceRow(over: Partial<Evidence>): Evidence {
  return {
    evidence_id: 'ev_1',
    case_id: 'case_1',
    type: 'task_result',
    source_type: 'automated',
    machine_readable: true,
    validation_track: 'direct',
    created_at: '2026-08-01T10:00:00.000Z',
    created_by: 'system:assistant',
    ...over,
  } as Evidence;
}

function minimalResultDataUrl(answer: string): string {
  const document = {
    schema: ASSISTANT_TASK_RESULT_SCHEMA,
    answer,
    model: 'gemini-2.5-flash',
    steps: 1,
    finish_reason: 'stop',
    duration_ms: 100,
    reads_withheld: false,
    reads_withheld_reason: null,
    tool_calls: [],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    assistant_tool_policy: {
      schema_version: 1,
      task_kind: 'arbitra_data_question',
      enabled_tools: [],
      tool_selection_reason: 'requester_scoped_read_registry',
    },
  };
  const bytes = Buffer.from(JSON.stringify(document), 'utf-8').toString('base64');
  return `data:application/json;base64,${bytes}`;
}

function makeLookup(opts: {
  evidence: Evidence[];
  artifactDoc?: { exists: boolean; data?: () => { storage_path: string } };
  readContent?: (storagePath: string) => Promise<string>;
}) {
  const evidenceRepo = { getByCaseId: vi.fn(async () => opts.evidence) } as never;
  const artifactService = {
    readContent: vi.fn(opts.readContent ?? (async () => { throw new Error('unexpected read'); })),
  } as never;
  mockArtifactsGet.mockReset();
  mockArtifactsGet.mockResolvedValue(opts.artifactDoc ?? { exists: false });
  return { lookup: new AssistantAnswerLookup(evidenceRepo, artifactService), artifactService };
}

describe('AssistantAnswerLookup.getAnswerForCase', () => {
  it('returns the decoded answer for a well-formed artifact', async () => {
    const { lookup } = makeLookup({
      evidence: [evidenceRow({ artifact_ref: 'art_1' })],
      artifactDoc: { exists: true, data: () => ({ storage_path: 'path/to/art_1' }) },
      readContent: async (storagePath) => {
        expect(storagePath).toBe('path/to/art_1');
        return minimalResultDataUrl('the final answer');
      },
    });

    const answer = await lookup.getAnswerForCase('case_1');

    expect(answer).toBe('the final answer');
  });

  it('returns null when there is no task_result evidence yet', async () => {
    const { lookup } = makeLookup({ evidence: [] });

    expect(await lookup.getAnswerForCase('case_1')).toBeNull();
  });

  it('returns null when the artifact doc does not exist', async () => {
    const { lookup } = makeLookup({
      evidence: [evidenceRow({ artifact_ref: 'art_missing' })],
      artifactDoc: { exists: false },
    });

    expect(await lookup.getAnswerForCase('case_1')).toBeNull();
  });

  it('returns null (never throws) when the stored bytes are malformed', async () => {
    const { lookup } = makeLookup({
      evidence: [evidenceRow({ artifact_ref: 'art_bad' })],
      artifactDoc: { exists: true, data: () => ({ storage_path: 'path/to/art_bad' }) },
      readContent: async () => 'data:application/json;base64,bm90LWpzb24=', // "not-json"
    });

    await expect(lookup.getAnswerForCase('case_1')).resolves.toBeNull();
  });

  it('picks the newest task_result row when several exist', async () => {
    const { lookup } = makeLookup({
      evidence: [
        evidenceRow({ evidence_id: 'ev_old', artifact_ref: 'art_old', created_at: '2026-08-01T09:00:00.000Z' }),
        evidenceRow({ evidence_id: 'ev_new', artifact_ref: 'art_new', created_at: '2026-08-01T12:00:00.000Z' }),
      ],
      artifactDoc: { exists: true, data: () => ({ storage_path: 'path/to/art_new' }) },
      readContent: async (storagePath) => {
        expect(storagePath).toBe('path/to/art_new');
        return minimalResultDataUrl('newest answer');
      },
    });

    expect(await lookup.getAnswerForCase('case_1')).toBe('newest answer');
  });
});
