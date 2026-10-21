import { describe, expect, it } from 'vitest';
import { sessionSignalEventSchema } from '../validation/session-signal-validators.js';

const base = {
  event_id: 'evt-1',
  schema_version: 1,
  event_type: 'heartbeat',
  agent_name: 'claude-code',
  repository: 'https://github.com/acme/widgets',
  branch: 'feat/x',
  session_id: '3f6c2a0e-1b2c-4d5e-8f90-123456789abc',
};

describe('sessionSignalEventSchema', () => {
  it('accepts a regular event', () => {
    expect(sessionSignalEventSchema.safeParse(base).success).toBe(true);
  });

  /** Reverts: documentIdSchema on session_id / event_id (a `/` became a Firestore path error, HTTP 500). */
  it('rejects ids that are not valid Firestore document ids', () => {
    for (const bad of ['a/b', '.', '..']) {
      expect(sessionSignalEventSchema.safeParse({ ...base, session_id: bad }).success).toBe(false);
      expect(sessionSignalEventSchema.safeParse({ ...base, event_id: bad }).success).toBe(false);
    }
  });
});
