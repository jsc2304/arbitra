import { describe, expect, it } from 'vitest';
import {
  isSystemActorId,
  splitActorRows,
} from '../observatory-actor-split';

describe('observatory-actor-split', () => {
  describe('isSystemActorId', () => {
    it('flags the bare "system" sentinel', () => {
      expect(isSystemActorId('system')).toBe(true);
    });

    it('flags namespaced "system:*" sentinels', () => {
      expect(isSystemActorId('system:webhook')).toBe(true);
      expect(isSystemActorId('system:auto-approve')).toBe(true);
    });

    it('does not flag human user ids', () => {
      expect(isSystemActorId('user-123')).toBe(false);
      expect(isSystemActorId('alex@example.com')).toBe(false);
      expect(isSystemActorId('SYSTEM')).toBe(false); // case-sensitive
      expect(isSystemActorId('systematic')).toBe(false); // prefix only on system:
    });
  });

  describe('splitActorRows', () => {
    it('partitions rows by actor cohort, preserving input order', () => {
      const rows = [
        { user_id: 'system', count: 12 },
        { user_id: 'alice', count: 9 },
        { user_id: 'system:webhook', count: 5 },
        { user_id: 'bob', count: 4 },
      ];

      const result = splitActorRows(rows);

      expect(result.human.map((r) => r.user_id)).toEqual(['alice', 'bob']);
      expect(result.system.map((r) => r.user_id)).toEqual([
        'system',
        'system:webhook',
      ]);
    });

    it('handles all-human and all-system inputs', () => {
      expect(splitActorRows([{ user_id: 'a' }, { user_id: 'b' }])).toEqual({
        human: [{ user_id: 'a' }, { user_id: 'b' }],
        system: [],
      });

      expect(
        splitActorRows([{ user_id: 'system' }, { user_id: 'system:webhook' }]),
      ).toEqual({
        human: [],
        system: [{ user_id: 'system' }, { user_id: 'system:webhook' }],
      });
    });

    it('returns empty cohorts for an empty input', () => {
      expect(splitActorRows([])).toEqual({ human: [], system: [] });
    });

    it('reranks humans when a system actor was previously top of the list', () => {
      // Caller sorts by metric desc before splitting; the post-split order is
      // what the UI uses for ranks. Here system was rank-1 in mixed order;
      // after split, alice (the previously-2nd-place human) becomes rank-1.
      const mixedSortedDesc = [
        { user_id: 'system', cases: 100 },
        { user_id: 'alice', cases: 20 },
        { user_id: 'bob', cases: 5 },
      ];

      const { human, system } = splitActorRows(mixedSortedDesc);

      expect(human[0]?.user_id).toBe('alice');
      expect(human[1]?.user_id).toBe('bob');
      expect(system[0]?.user_id).toBe('system');
    });
  });
});
