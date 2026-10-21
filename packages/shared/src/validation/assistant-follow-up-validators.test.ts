import { describe, expect, it } from 'vitest';
import { createCaseSchema, updateCaseSchema } from './case-validators.js';
import { webAssistantFollowUpSchema } from './assistant-validators.js';

describe('webAssistantFollowUpSchema', () => {
  it('requires a retry-safe key and rejects browser-supplied provenance', () => {
    expect(() => webAssistantFollowUpSchema.parse({ text: 'continue' })).toThrow();
    expect(() => webAssistantFollowUpSchema.parse({
      text: 'continue',
      idempotency_key: 'turn-2',
      parent_case_id: 'case_forged',
    })).toThrow();
  });
});

describe('assistant_thread ownership', () => {
  const forged = {
    schema_version: 1,
    root_case_id: 'case_root',
    parent_case_id: 'case_parent',
    prior_run_id: 'run_parent',
    prior_result_evidence_id: 'evidence_parent',
    prior_result_artifact_id: 'artifact_parent',
    depth: 1,
  };

  it('cannot be written through public Case create or update payloads', () => {
    const created = createCaseSchema.parse({
      title: 'forged',
      description: '',
      source_type: 'manual',
      project_id: 'proj_1',
      repository_id: 'repo_1',
      risk_level: 'low',
      priority: 'normal',
      assistant_thread: forged,
    });
    const updated = updateCaseSchema.parse({ title: 'changed', assistant_thread: forged });

    expect(created).not.toHaveProperty('assistant_thread');
    expect(updated).not.toHaveProperty('assistant_thread');
  });
});
