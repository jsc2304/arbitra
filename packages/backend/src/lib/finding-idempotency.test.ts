import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Finding } from '@arbitra/shared';

/**
 * Issue #739. `persistFinding` is the create-or-reactivate primitive both
 * `rule-service.ts` and `review-service.ts` now write findings through at a
 * deterministic (`deriveFindingId`) doc id, instead of read-then-write with
 * a random id. These tests exercise the primitive directly, isolated from
 * either call site.
 */

const findingsStore = new Map<string, Finding>();

function docApi(id: string) {
  return {
    get: async () => ({ exists: findingsStore.has(id), data: () => findingsStore.get(id) }),
    set: async (data: Finding) => {
      findingsStore.set(id, data);
    },
    update: async (patch: Record<string, unknown>) => {
      const current = findingsStore.get(id);
      if (!current) return;
      const next: Record<string, unknown> = { ...current };
      for (const [key, value] of Object.entries(patch)) {
        // Mirror Firestore's FieldValue.delete() sentinel handling well
        // enough for these tests: a delete-transform removes the key.
        if (value && typeof value === 'object' && 'isDeleteTransform' in (value as object)) {
          delete next[key];
        } else {
          next[key] = value;
        }
      }
      findingsStore.set(id, next as Finding);
    },
  };
}

vi.mock('./firestore.js', () => ({
  collections: {
    findings: () => ({ doc: (id: string) => docApi(id) }),
  },
  // No real optimistic-concurrency enforcement — `persistFinding` itself
  // never calls `tx.create` on a doc it just saw exist (it branches on
  // `tx.get` first), so a plain callback-runner is sufficient here.
  getDb: () => ({
    runTransaction: async (
      fn: (tx: {
        get: (ref: ReturnType<typeof docApi>) => Promise<unknown>;
        create: (ref: ReturnType<typeof docApi>, data: unknown) => void;
        update: (ref: ReturnType<typeof docApi>, data: unknown) => void;
      }) => Promise<unknown>,
    ) =>
      fn({
        get: (ref) => ref.get(),
        create: (ref, data) => void ref.set(data as Finding),
        update: (ref, data) => void ref.update(data as Record<string, unknown>),
      }),
  }),
}));

// Marks the object returned by `FieldValue.delete()` so the fake `update`
// above can recognize and strip it, without depending on firebase-admin's
// actual sentinel shape.
vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { delete: () => ({ isDeleteTransform: true }) },
}));

import { persistFinding } from './finding-idempotency.js';

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    finding_id: 'fnd_abc123',
    case_id: 'case_1',
    category: 'rule_override_conflict',
    severity: 'low',
    confidence: 1,
    status: 'open',
    title: 'Conflict',
    description: 'desc',
    origin_type: 'rule_engine',
    source_refs: [],
    evidence_refs: [],
    rule_refs: [],
    signature: 'sig_1',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('persistFinding', () => {
  beforeEach(() => {
    findingsStore.clear();
  });

  it('creates the doc and returns "created" when no doc exists at the id yet', async () => {
    const finding = makeFinding();

    const outcome = await persistFinding(finding);

    expect(outcome).toBe('created');
    expect(findingsStore.get('fnd_abc123')).toEqual(finding);
  });

  it('returns "skipped" and leaves the doc untouched when it already exists and is open', async () => {
    const original = makeFinding({ title: 'Original title', updated_at: '2026-01-01T00:00:00Z' });
    findingsStore.set('fnd_abc123', original);

    const outcome = await persistFinding(makeFinding({ title: 'Different title, same id' }));

    expect(outcome).toBe('skipped');
    expect(findingsStore.get('fnd_abc123')).toEqual(original);
  });

  it('creates exactly one document when two callers race on the same deterministic id', async () => {
    // This fake transaction has no compare-and-swap-on-commit / automatic
    // retry (real Firestore transactions do — see `waiver-completion.ts`'s
    // doc comment on the same pattern), so both racing `tx.get`s here can
    // observe "not exists" and both report 'created'. What this DOES prove,
    // realistically, is the property #739 is actually about: because both
    // writes target the SAME deterministic doc id, the second write
    // overwrites rather than duplicates — one document survives either way.
    // The full "one created, one skipped" per-caller outcome depends on
    // Firestore's real retry-on-conflict and is NOT exercised by any test in
    // this repo — the service-level tests fake runTransaction the same way.
    // Covering it needs an emulator-backed integration test (tracked in the
    // repo issue filed with PR #924's review).
    const finding = makeFinding();

    const outcomes = await Promise.all([persistFinding(finding), persistFinding(finding)]);

    expect(outcomes).toEqual(['created', 'created']);
    expect(findingsStore.size).toBe(1);
  });

  it.each(['resolved', 'fixed'] as const)(
    'reactivates a %s doc at the same id instead of leaving it terminal',
    async (terminalStatus) => {
      findingsStore.set(
        'fnd_abc123',
        makeFinding({
          status: terminalStatus,
          title: 'Stale title',
          description: 'stale description',
          resolution: 'Closed previously.',
          created_at: '2020-01-01T00:00:00Z',
          updated_at: '2020-06-01T00:00:00Z',
        }),
      );
      const fresh = makeFinding({
        title: 'Fresh title',
        description: 'fresh description',
        updated_at: '2026-02-01T00:00:00Z',
      });

      const outcome = await persistFinding(fresh);

      expect(outcome).toBe('reactivated');
      const stored = findingsStore.get('fnd_abc123')!;
      expect(stored.status).toBe('open');
      expect(stored.title).toBe('Fresh title');
      expect(stored.description).toBe('fresh description');
      // `created_at` is preserved from the original doc — reactivation
      // reopens the same audit record, it doesn't start a new one.
      expect(stored.created_at).toBe('2020-01-01T00:00:00Z');
      expect(stored.updated_at).toBe('2026-02-01T00:00:00Z');
      // Stale resolution text must not survive the reopen.
      expect(stored.resolution).toBeUndefined();
    },
  );

  it('does not reactivate a doc in a non-terminal status other than open (e.g. waived)', async () => {
    const waived = makeFinding({ status: 'waived' });
    findingsStore.set('fnd_abc123', waived);

    const outcome = await persistFinding(makeFinding({ title: 'New observation' }));

    expect(outcome).toBe('skipped');
    expect(findingsStore.get('fnd_abc123')).toEqual(waived);
  });
});
