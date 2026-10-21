import { describe, expect, it } from 'vitest';
import type { AssistantTaskSummary } from './api-client';
import { groupAssistantTasksByThread } from './assistant-task-grouping';

function task(over: Partial<AssistantTaskSummary> & { case_id: string }): AssistantTaskSummary {
  return {
    title: 'A task',
    status: 'done',
    created_at: '2026-08-01T10:00:00.000Z',
    updated_at: '2026-08-01T10:00:00.000Z',
    ...over,
  };
}

describe('groupAssistantTasksByThread', () => {
  it('renders a case with no thread link standalone', () => {
    const tasks = [task({ case_id: 'case_a' })];

    expect(groupAssistantTasksByThread(tasks)).toEqual([
      { kind: 'standalone', task: tasks[0] },
    ]);
  });

  it('collapses a follow-up under its root when both are in the list', () => {
    const root = task({ case_id: 'case_root', updated_at: '2026-08-01T09:00:00.000Z' });
    const followUp = task({
      case_id: 'case_followup',
      updated_at: '2026-08-01T10:00:00.000Z',
      assistant_thread: { root_case_id: 'case_root' },
    });

    const entries = groupAssistantTasksByThread([followUp, root]);

    expect(entries).toEqual([
      { kind: 'thread', group: { root, followUps: [followUp] } },
    ]);
  });

  it('sorts a thread by its newest activity, not the root\'s own updated_at', () => {
    // The root went `done` days ago; a follow-up answered minutes ago should
    // still pull the whole thread to the top of the list.
    const staleRoot = task({
      case_id: 'case_root',
      title: 'Root',
      updated_at: '2026-07-29T09:00:00.000Z',
    });
    const freshFollowUp = task({
      case_id: 'case_followup',
      title: 'Follow-up',
      updated_at: '2026-08-01T10:00:00.000Z',
      assistant_thread: { root_case_id: 'case_root' },
    });
    const midStandalone = task({
      case_id: 'case_other',
      title: 'Other',
      updated_at: '2026-07-31T00:00:00.000Z',
    });

    const entries = groupAssistantTasksByThread([staleRoot, midStandalone, freshFollowUp]);

    expect(entries.map((e) => (e.kind === 'thread' ? e.group.root.case_id : e.task.case_id))).toEqual([
      'case_root', // pulled to the top by freshFollowUp's activity
      'case_other',
    ]);
  });

  it('orders follow-ups within a group newest first', () => {
    const root = task({ case_id: 'case_root', updated_at: '2026-08-01T00:00:00.000Z' });
    const older = task({
      case_id: 'case_followup_1',
      updated_at: '2026-08-01T10:00:00.000Z',
      assistant_thread: { root_case_id: 'case_root' },
    });
    const newer = task({
      case_id: 'case_followup_2',
      updated_at: '2026-08-02T10:00:00.000Z',
      assistant_thread: { root_case_id: 'case_root' },
    });

    const entries = groupAssistantTasksByThread([root, older, newer]);

    expect(entries).toHaveLength(1);
    const [entry] = entries;
    expect(entry?.kind).toBe('thread');
    expect(entry?.kind === 'thread' && entry.group.followUps.map((f) => f.case_id)).toEqual([
      'case_followup_2',
      'case_followup_1',
    ]);
  });

  it('renders a follow-up standalone when its root is outside the fetched page', () => {
    const orphanFollowUp = task({
      case_id: 'case_followup',
      assistant_thread: { root_case_id: 'case_root_not_in_list' },
    });

    expect(groupAssistantTasksByThread([orphanFollowUp])).toEqual([
      { kind: 'standalone', task: orphanFollowUp },
    ]);
  });

  it('treats a case pointing at itself as the root case defensively', () => {
    // Not a shape the backend produces (a root never carries assistant_thread),
    // but the spec's own predicate is "root_case_id set and != own id" — a
    // self-referencing id must not be treated as a follow-up of itself.
    const selfReferencing = task({
      case_id: 'case_a',
      assistant_thread: { root_case_id: 'case_a' },
    });

    expect(groupAssistantTasksByThread([selfReferencing])).toEqual([
      { kind: 'standalone', task: selfReferencing },
    ]);
  });
});
