/**
 * Grouping a Clerk task list by thread.
 *
 * A follow-up case carries `assistant_thread.root_case_id`; the root case it
 * points at never carries `assistant_thread` at all (see `AssistantThreadLink`
 * in `@arbitra/shared` and `assistant-follow-up-service.ts`, which derives
 * `root_case_id` from the parent's own link, falling back to the parent's own
 * id when the parent IS the root). So a task is a follow-up exactly when
 * `assistant_thread.root_case_id` is set and differs from its own `case_id`.
 *
 * A follow-up whose root is not present in the same list (outside the
 * fetched page) has nothing to nest under here, so it renders standalone —
 * this function never fabricates a root row from partial data.
 */
import type { AssistantTaskSummary } from './api-client';

export interface AssistantTaskThreadGroup {
  root: AssistantTaskSummary;
  /** Newest first — same direction as the top-level list. */
  followUps: AssistantTaskSummary[];
}

export type AssistantTaskListEntry =
  | { kind: 'standalone'; task: AssistantTaskSummary }
  | { kind: 'thread'; group: AssistantTaskThreadGroup };

function isFollowUp(task: AssistantTaskSummary): task is AssistantTaskSummary & {
  assistant_thread: { root_case_id: string };
} {
  const rootCaseId = task.assistant_thread?.root_case_id;
  return !!rootCaseId && rootCaseId !== task.case_id;
}

function newestFirst(a: AssistantTaskSummary, b: AssistantTaskSummary): number {
  return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
}

/**
 * A thread's position in the grouped list is driven by the newest activity
 * anywhere in it, not by the root's own `updated_at` — the root case's own
 * document typically stops changing once it reaches `done`, while replies
 * keep the thread alive as new (immutable) follow-up cases.
 */
function latestActivity(group: AssistantTaskThreadGroup): number {
  return Math.max(
    new Date(group.root.updated_at).getTime(),
    ...group.followUps.map((f) => new Date(f.updated_at).getTime()),
  );
}

export function groupAssistantTasksByThread(
  tasks: readonly AssistantTaskSummary[],
): AssistantTaskListEntry[] {
  const byId = new Map(tasks.map((t) => [t.case_id, t]));
  const followUpsByRoot = new Map<string, AssistantTaskSummary[]>();
  const rootCandidates: AssistantTaskSummary[] = [];

  for (const task of tasks) {
    if (isFollowUp(task) && byId.has(task.assistant_thread.root_case_id)) {
      const rootId = task.assistant_thread.root_case_id;
      const list = followUpsByRoot.get(rootId) ?? [];
      list.push(task);
      followUpsByRoot.set(rootId, list);
    } else {
      // Either a true root (no assistant_thread), or a follow-up whose root
      // fell outside this page — both render as a top-level entry.
      rootCandidates.push(task);
    }
  }

  const entries: AssistantTaskListEntry[] = rootCandidates.map((task) => {
    const followUps = followUpsByRoot.get(task.case_id);
    if (!followUps || followUps.length === 0) {
      return { kind: 'standalone', task };
    }
    return {
      kind: 'thread',
      group: { root: task, followUps: [...followUps].sort(newestFirst) },
    };
  });

  return entries.sort((a, b) => {
    const aTime = a.kind === 'standalone'
      ? new Date(a.task.updated_at).getTime()
      : latestActivity(a.group);
    const bTime = b.kind === 'standalone'
      ? new Date(b.task.updated_at).getTime()
      : latestActivity(b.group);
    return bTime - aTime;
  });
}
