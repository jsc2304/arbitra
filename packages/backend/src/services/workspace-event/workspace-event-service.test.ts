import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkspaceEvent } from '@arbitra/shared';

// Deterministic id so we can assert the exact document the service writes.
vi.mock('../../lib/ids.js', () => ({
  generateId: (prefix: string) => `${prefix}_fixed`,
}));

// In-memory Firestore stub. `set` records the doc for later assertion; `doc`
// validates that the id used to name the document matches `event_id` on the
// payload (guards against regression where the id was generated twice).
const setSpy = vi.fn<(value: WorkspaceEvent) => Promise<void>>(async () => {});
const getSpy = vi.fn<() => Promise<{ exists: boolean; data: () => WorkspaceEvent | undefined }>>();
const docSpy = vi.fn<(id: string) => { set: typeof setSpy; get: typeof getSpy }>(() => ({
  set: setSpy,
  get: getSpy,
}));

vi.mock('../../lib/firestore.js', () => ({
  collections: {
    workspaceEvents: () => ({ doc: docSpy }),
  },
}));

import { WorkspaceEventService } from './workspace-event-service.js';

describe('WorkspaceEventService.record', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes a well-formed WorkspaceEvent with a generated event_id and a timestamp', async () => {
    const service = new WorkspaceEventService();
    const before = Date.now();

    const recorded = await service.record({
      type: 'intelligence_run',
      actor_user_id: 'system:arbitra-intelligence',
      actor_metadata: { client_name: 'arbitra-intelligence', client_version: '9.9.9' },
      summary: 'Ran 3 detectors — 0 new nudges, 0 deduped, 0 errors',
      evidence: { detectors: [], cases_created: 0, errors: 0 },
    });

    expect(recorded.event_id).toBe('workspaceEvent_fixed');
    expect(recorded.type).toBe('intelligence_run');
    expect(recorded.actor_user_id).toBe('system:arbitra-intelligence');
    expect(recorded.actor_metadata).toEqual({
      client_name: 'arbitra-intelligence',
      client_version: '9.9.9',
    });
    expect(recorded.summary).toMatch(/Ran 3 detectors/);

    // Timestamp defaults to now(); bound check avoids flakiness on slow CI.
    const ts = Date.parse(recorded.timestamp);
    expect(Number.isNaN(ts)).toBe(false);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(Date.now() + 1000);

    // The doc must be named by event_id so there's exactly one Firestore
    // document per event — a mismatch would risk duplicate writes.
    expect(docSpy).toHaveBeenCalledWith('workspaceEvent_fixed');
    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(setSpy).toHaveBeenCalledWith(recorded);
  });

  it('honors an explicit timestamp (used by backfills / tests)', async () => {
    const service = new WorkspaceEventService();
    const recorded = await service.record({
      type: 'intelligence_run',
      actor_user_id: 'system:arbitra-intelligence',
      summary: 's',
      timestamp: '2026-04-19T12:00:00.000Z',
    });
    expect(recorded.timestamp).toBe('2026-04-19T12:00:00.000Z');
  });

  it('omits actor_metadata / evidence when caller does not supply them', async () => {
    const service = new WorkspaceEventService();
    const recorded = await service.record({
      type: 'intelligence_run',
      actor_user_id: 'system:arbitra-intelligence',
      summary: 's',
    });
    expect(recorded).not.toHaveProperty('actor_metadata');
    expect(recorded).not.toHaveProperty('evidence');
  });
});

describe('WorkspaceEventService.recordInTransaction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stages exactly one transaction.set() call for the same doc ref record() would use, and returns the built event synchronously', () => {
    const txSet = vi.fn();
    const tx = { set: txSet } as unknown as FirebaseFirestore.Transaction;
    const service = new WorkspaceEventService();

    const event = service.recordInTransaction(tx, {
      type: 'chat_identity_cleared',
      actor_user_id: 'usr_admin',
      summary: 'Cleared Chat identity mapping for user usr_target',
      evidence: { target_user_id: 'usr_target' },
    });

    // Synchronous return, no await — a caller can use the result to build a
    // response before the enclosing runTransaction has resolved.
    expect(event.event_id).toBe('workspaceEvent_fixed');
    expect(event.type).toBe('chat_identity_cleared');

    // No direct Firestore write — only staged onto the caller's transaction.
    expect(setSpy).not.toHaveBeenCalled();
    expect(docSpy).toHaveBeenCalledWith('workspaceEvent_fixed');
    expect(txSet).toHaveBeenCalledTimes(1);
    expect(txSet).toHaveBeenCalledWith(expect.anything(), event);
  });
});

describe('WorkspaceEventService.get', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when the document does not exist', async () => {
    getSpy.mockResolvedValueOnce({ exists: false, data: () => undefined });
    const service = new WorkspaceEventService();
    const result = await service.get('workspaceEvent_missing');
    expect(result).toBeNull();
    expect(docSpy).toHaveBeenCalledWith('workspaceEvent_missing');
  });

  it('returns the stored WorkspaceEvent when the document exists', async () => {
    const stored: WorkspaceEvent = {
      event_id: 'workspaceEvent_hit',
      type: 'intelligence_run',
      actor_user_id: 'system:arbitra-intelligence',
      timestamp: '2026-04-20T10:00:00.000Z',
      summary: 'Ran 2 detectors',
      evidence: { detectors: [] },
    };
    getSpy.mockResolvedValueOnce({ exists: true, data: () => stored });
    const service = new WorkspaceEventService();
    const result = await service.get('workspaceEvent_hit');
    expect(result).toEqual(stored);
    expect(docSpy).toHaveBeenCalledWith('workspaceEvent_hit');
  });
});
