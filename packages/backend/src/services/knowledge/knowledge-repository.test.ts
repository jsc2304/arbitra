import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { KnowledgeAsset } from '@arbitra/shared';

// In-memory Firestore stand-in for `collections.knowledgeAssets()` — array-
// backed (not keyed by doc id) so a fixture can deliberately place two rows
// under the same `knowledge_id` but different `scope_type`/`scope_ref`
// pairs, which is exactly the shape `listForReviewScope`'s de-dup-by-id Map
// has to collapse back down to one entry.
let store: KnowledgeAsset[] = [];

function makeQuery(predicates: Array<(a: KnowledgeAsset) => boolean>) {
  return {
    where: (field: keyof KnowledgeAsset, _op: string, value: unknown) =>
      makeQuery([...predicates, (a: KnowledgeAsset) => a[field] === value]),
    get: async () => ({
      docs: store
        .filter((a) => predicates.every((p) => p(a)))
        .map((a) => ({ data: () => a })),
    }),
  };
}

vi.mock('../../lib/firestore.js', () => ({
  collections: {
    knowledgeAssets: () => ({
      where: (field: keyof KnowledgeAsset, op: string, value: unknown) =>
        makeQuery([]).where(field, op, value),
    }),
  },
}));

import { KnowledgeRepository } from './knowledge-repository.js';

function makeAsset(overrides: Partial<KnowledgeAsset> = {}): KnowledgeAsset {
  return {
    knowledge_id: 'know_default',
    type: 'precedent',
    title: 'Asset',
    summary: 'Summary',
    body: 'Body',
    scope_type: 'project',
    scope_ref: 'proj-1',
    status: 'verified',
    version: 1,
    trust_level: 1,
    source_case_refs: [],
    source_decision_refs: [],
    tags: [],
    artifact_refs: [],
    created_by: 'usr_author',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('KnowledgeRepository.listForReviewScope', () => {
  beforeEach(() => {
    store = [];
  });

  it('merges project-scoped and repo-scoped assets into one list', async () => {
    const projectAsset = makeAsset({
      knowledge_id: 'know_project',
      scope_type: 'project',
      scope_ref: 'proj-1',
    });
    const repoAsset = makeAsset({
      knowledge_id: 'know_repo',
      scope_type: 'repo',
      scope_ref: 'repo-1',
    });
    store = [projectAsset, repoAsset];

    const repo = new KnowledgeRepository();
    const result = await repo.listForReviewScope('proj-1', 'repo-1');

    const ids = result.map((a) => a.knowledge_id).sort();
    expect(ids).toEqual(['know_project', 'know_repo']);
  });

  it('excludes assets scoped to a different project/repo', async () => {
    store = [
      makeAsset({ knowledge_id: 'know_other_project', scope_type: 'project', scope_ref: 'proj-999' }),
      makeAsset({ knowledge_id: 'know_other_repo', scope_type: 'repo', scope_ref: 'repo-999' }),
      makeAsset({ knowledge_id: 'know_global', scope_type: 'global', scope_ref: 'global' }),
    ];

    const repo = new KnowledgeRepository();
    const result = await repo.listForReviewScope('proj-1', 'repo-1');

    expect(result).toEqual([]);
  });

  it('dedups by knowledge_id when the same id is returned by both the project and repo query', async () => {
    // Same `knowledge_id`, two distinct rows — one matching the project
    // query, one matching the repo query. This should not happen with a
    // well-formed single doc (a doc has exactly one scope_type/scope_ref),
    // but the Map-based merge in `listForReviewScope` is a defensive
    // de-dup-by-id regardless of how the duplicate arose, so exercise it
    // directly rather than relying on it being merely "true by construction".
    const projectRow = makeAsset({
      knowledge_id: 'know_shared',
      scope_type: 'project',
      scope_ref: 'proj-1',
      title: 'Project-scoped copy',
    });
    const repoRow = makeAsset({
      knowledge_id: 'know_shared',
      scope_type: 'repo',
      scope_ref: 'repo-1',
      title: 'Repo-scoped copy',
    });
    const uniqueProjectAsset = makeAsset({
      knowledge_id: 'know_unique',
      scope_type: 'project',
      scope_ref: 'proj-1',
    });
    store = [projectRow, repoRow, uniqueProjectAsset];

    const repo = new KnowledgeRepository();
    const result = await repo.listForReviewScope('proj-1', 'repo-1');

    // Exactly one entry per distinct knowledge_id — the duplicate collapsed.
    const ids = result.map((a) => a.knowledge_id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);

    // Merge order is `[...projectAssets, ...repoAssets]` fed into a Map keyed
    // by knowledge_id, so the later (repo-scoped) row wins the collision.
    const shared = result.find((a) => a.knowledge_id === 'know_shared');
    expect(shared?.title).toBe('Repo-scoped copy');
  });
});
