import {
  ArbitraError,
  ForbiddenError,
  NotFoundError,
  type Artifact,
  type AssistantThreadLink,
  type AssistantThreadResponse,
  type AssistantThreadTurn,
  type Case,
  type Evidence,
  type Run,
} from '@arbitra/shared';
import { collections } from '../../lib/firestore.js';
import {
  getArtifactStorage,
  type ArtifactStorageAdapter,
} from '../../lib/artifact-storage.js';
import type { AssistantFollowUpPromptTurn } from './assistant-prompt.js';

const RESULT_SCHEMAS = new Set([
  'arbitra.assistant_task_result/v1',
  'arbitra.assistant_task_result/v2',
]);

interface PinnedSourceDocuments {
  parent: Case | undefined;
  run: Run | undefined;
  evidence: Evidence | undefined;
  artifact: Artifact | undefined;
}

/** A follow-up is invalid state, not a model/provider failure worth retrying. */
export class AssistantFollowUpError extends ArbitraError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'ASSISTANT_FOLLOW_UP_INVALID', 409, details);
    this.name = 'AssistantFollowUpError';
  }
}

function newest<T>(rows: T[], timestamp: (row: T) => string): T | undefined {
  return rows.reduce<T | undefined>((best, row) => {
    if (!best) return row;
    return Date.parse(timestamp(row)) > Date.parse(timestamp(best)) ? row : best;
  }, undefined);
}

function assertRequester(case_: Case, actorId: string): void {
  if (
    case_.owner_user_id === actorId
    && case_.assistant_context?.requester_user_id === actorId
  ) return;
  // Deliberately no admin bypass: a private Clerk project is not an
  // impersonation surface for an operator account.
  throw new ForbiddenError('Only the Clerk requester can continue or read this thread.', {
    case_id: case_.case_id,
  });
}

/**
 * Validate the exact documents named by a thread edge. Used both before intake
 * and again inside its transaction, closing the gap where a parent/result is
 * changed between those two moments.
 */
export function assertPinnedFollowUpSources(
  link: AssistantThreadLink,
  actorId: string,
  projectId: string,
  repositoryId: string,
  sources: PinnedSourceDocuments,
): asserts sources is {
  parent: Case;
  run: Run;
  evidence: Evidence;
  artifact: Artifact;
} {
  const { parent, run, evidence, artifact } = sources;
  if (!parent || parent.deleted_at) {
    throw new AssistantFollowUpError('The preceding Clerk task is unavailable.', {
      parent_case_id: link.parent_case_id,
    });
  }
  assertRequester(parent, actorId);
  const expectedRoot = parent.assistant_thread?.root_case_id ?? parent.case_id;
  const expectedDepth = (parent.assistant_thread?.depth ?? 0) + 1;
  if (
    parent.case_id !== link.parent_case_id
    || parent.case_type !== 'assistant_task'
    || parent.status !== 'done'
    || parent.project_id !== projectId
    || parent.repository_id !== repositoryId
    || link.root_case_id !== expectedRoot
    || link.depth !== expectedDepth
  ) {
    throw new AssistantFollowUpError('A follow-up requires an immutable completed Clerk parent.', {
      parent_case_id: link.parent_case_id,
    });
  }
  if (
    !run
    || run.run_id !== link.prior_run_id
    || run.case_id !== parent.case_id
    || run.run_type !== 'assistant_task_run'
    || run.status !== 'completed'
  ) {
    throw new AssistantFollowUpError('The pinned preceding Clerk run is not completed.', {
      prior_run_id: link.prior_run_id,
    });
  }
  if (
    !evidence
    || evidence.evidence_id !== link.prior_result_evidence_id
    || evidence.case_id !== parent.case_id
    || evidence.run_id !== run.run_id
    || evidence.type !== 'task_result'
    || evidence.artifact_ref !== link.prior_result_artifact_id
  ) {
    throw new AssistantFollowUpError('The pinned preceding task_result Evidence is invalid.', {
      prior_result_evidence_id: link.prior_result_evidence_id,
    });
  }
  if (
    !artifact
    || artifact.artifact_id !== link.prior_result_artifact_id
    || artifact.case_id !== parent.case_id
    || artifact.run_id !== run.run_id
  ) {
    throw new AssistantFollowUpError('The pinned preceding result Artifact is invalid.', {
      prior_result_artifact_id: link.prior_result_artifact_id,
    });
  }
}

function parseResultDataUrl(
  dataUrl: string,
  link: AssistantThreadLink,
  parentCaseId: string,
): { answer: string; toolCalls: unknown[] } {
  const match = /^data:[^;]+;base64,([\s\S]*)$/.exec(dataUrl);
  if (!match) {
    throw new AssistantFollowUpError('The preceding Clerk result bytes are unreadable.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(match[1]!, 'base64').toString('utf-8')) as unknown;
  } catch {
    throw new AssistantFollowUpError('The preceding Clerk result is not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AssistantFollowUpError('The preceding Clerk result has an invalid document shape.');
  }
  const result = parsed as Record<string, unknown>;
  if (
    !RESULT_SCHEMAS.has(String(result['schema']))
    || result['case_id'] !== parentCaseId
    || result['run_id'] !== link.prior_run_id
    || typeof result['answer'] !== 'string'
    || !Array.isArray(result['tool_calls'])
  ) {
    throw new AssistantFollowUpError('The preceding Clerk result does not match its pinned provenance.');
  }
  return { answer: result['answer'], toolCalls: result['tool_calls'] };
}

export class AssistantFollowUpService {
  constructor(private readonly storage: ArtifactStorageAdapter = getArtifactStorage()) {}

  /** Resolve the newest valid completed result on a parent into an exact edge. */
  async resolveParentLink(parentCaseId: string, actorId: string): Promise<AssistantThreadLink> {
    const parentSnap = await collections.cases().doc(parentCaseId).get();
    if (!parentSnap.exists || parentSnap.data()!.deleted_at) {
      throw new NotFoundError('Case', parentCaseId);
    }
    const parent = parentSnap.data()!;
    assertRequester(parent, actorId);
    if (parent.case_type !== 'assistant_task' || parent.status !== 'done') {
      throw new AssistantFollowUpError('Only a completed Clerk task can receive a follow-up.', {
        parent_case_id: parentCaseId,
        status: parent.status,
      });
    }

    const [runSnap, evidenceSnap] = await Promise.all([
      collections.runs().where('case_id', '==', parentCaseId).get(),
      collections.evidence().where('case_id', '==', parentCaseId).get(),
    ]);
    const completedRuns = runSnap.docs
      .map((doc) => doc.data())
      .filter((run) => run.run_type === 'assistant_task_run' && run.status === 'completed');
    const run = newest(completedRuns, (row) => row.finished_at ?? row.updated_at ?? row.created_at);
    if (!run) {
      throw new AssistantFollowUpError('The completed Clerk task has no completed assistant Run.');
    }
    const matchingEvidence = evidenceSnap.docs
      .map((doc) => doc.data())
      .filter(
        (row) => row.type === 'task_result' && row.run_id === run.run_id && !!row.artifact_ref,
      );
    const evidence = newest(matchingEvidence, (row) => row.created_at);
    if (!evidence?.artifact_ref) {
      throw new AssistantFollowUpError('The completed Clerk task has no result Evidence for its latest Run.');
    }
    const artifactSnap = await collections.artifacts().doc(evidence.artifact_ref).get();
    const link: AssistantThreadLink = {
      schema_version: 1,
      root_case_id: parent.assistant_thread?.root_case_id ?? parent.case_id,
      parent_case_id: parent.case_id,
      prior_run_id: run.run_id,
      prior_result_evidence_id: evidence.evidence_id,
      prior_result_artifact_id: evidence.artifact_ref,
      depth: (parent.assistant_thread?.depth ?? 0) + 1,
    };
    assertPinnedFollowUpSources(
      link,
      actorId,
      parent.project_id,
      parent.repository_id,
      { parent, run, evidence, artifact: artifactSnap.data() },
    );
    return link;
  }

  /**
   * Every Case in one Clerk thread — root plus every descendant sharing its
   * `root_case_id` — restricted to the exact requester, live, and in this
   * project, sorted oldest first. Pulled out so `getThread` and `loadContext`
   * cannot drift on what counts as "this conversation": both need exactly
   * this set, one for display, the other to assemble a follow-up's prompt.
   */
  private async loadThreadCases(rootCaseId: string, actorId: string): Promise<Case[]> {
    const [rootSnap, descendantsSnap] = await Promise.all([
      collections.cases().doc(rootCaseId).get(),
      collections.cases().where('assistant_thread.root_case_id', '==', rootCaseId).get(),
    ]);
    if (!rootSnap.exists || rootSnap.data()!.deleted_at) throw new NotFoundError('Case', rootCaseId);
    const root = rootSnap.data()!;
    assertRequester(root, actorId);
    return [root, ...descendantsSnap.docs.map((doc) => doc.data())]
      .filter(
        (row, index, all) =>
          all.findIndex((candidate) => candidate.case_id === row.case_id) === index
          && !row.deleted_at
          && row.case_type === 'assistant_task'
          && row.project_id === root.project_id
          && row.owner_user_id === actorId
          && row.assistant_context?.requester_user_id === actorId,
      )
      .sort((left, right) => {
        const depth = (left.assistant_thread?.depth ?? 0) - (right.assistant_thread?.depth ?? 0);
        return depth !== 0 ? depth : left.created_at.localeCompare(right.created_at);
      });
  }

  /**
   * Resolve this follow-up's WHOLE preceding conversation before the child
   * makes any model call: every ancestor turn, oldest first, the immediate
   * parent last — see `AssistantFollowUpPromptTurn` and
   * `buildAssistantFollowUpUserMessage` for how the last
   * `RECENT_VERBATIM_TURN_COUNT` of these stay verbatim while earlier ones
   * are compacted.
   *
   * ## Why this walks the chain instead of returning one pinned exchange
   *
   * A follow-up Case pins exactly its own parent's result
   * (`case_.assistant_thread`). Before #968 proposal 1 this method returned
   * only that one exchange, and the prompt fenced it verbatim regardless of
   * how deep the conversation already was — so a ninth-turn follow-up
   * carried only the eighth turn's own answer and tool trace, never the
   * seven turns before that, and nothing ever bounded what ONE turn could
   * carry forward: the model is explicitly told the prior trace "is not a
   * substitute for fresh reads", so it tends to read at least as much again,
   * and that unbounded output becomes the entire context the NEXT turn
   * carries. Prompt tokens grew 9,680 → 70,287 → 94,902 across three
   * consecutive turns, latency 5s → 34s → 54s.
   *
   * Fixing it needs real per-turn granularity — a case id and a question for
   * each earlier turn — which a single pinned exchange cannot reconstruct
   * after the fact: the model's own answer text deliberately excludes the
   * prompt it was given (see `assistant-prompt.ts`'s module doc), so nothing
   * about "the whole conversation so far" is recoverable from it. Every
   * ancestor's OWN completed result is pinned somewhere already, though:
   * on ITS OWN CHILD's `assistant_thread` field. So resolving every
   * ancestor's turn costs one thread-wide query (`loadThreadCases`, shared
   * with `getThread`) plus one direct-id fetch of each ancestor's own
   * run/evidence/artifact — the exact fetch this method always did for the
   * single parent, now repeated once per turn instead of stopping at one.
   *
   * ## Why the ancestor set is a parent-chain walk, not a depth filter
   *
   * A Clerk conversation is a tree, not a line: one root can have more than
   * one depth-1 child (e.g. two depth-1 children started from two
   * different Google Chat threads in the same DM). `threadCases` holds
   * every Case sharing the thread's `root_case_id`, siblings included, so
   * filtering it by `depth < link.depth` counts sibling branches as if they
   * were this follow-up's own history. A depth-2 case under one of those
   * siblings hit exactly that: the filter matched all 3
   * cases at depth < 2 across both branches, so `ancestors.length !== 2`
   * failed permanently with a "missing turns" message that had it backwards
   * — there were too many candidates, not too few. The only ancestor set
   * that is always correct is the chain obtained by following each Case's
   * own `assistant_thread.parent_case_id` up to the root: that pointer
   * identifies ONE Case, never a branch, so walking it can't pick up a
   * sibling regardless of how the tree is shaped.
   */
  async loadContext(case_: Case): Promise<AssistantFollowUpPromptTurn[] | null> {
    const link = case_.assistant_thread;
    if (!link) return null;
    const actorId = case_.assistant_context?.requester_user_id;
    if (!actorId) {
      throw new AssistantFollowUpError('The follow-up Case has no requester identity.');
    }

    const threadCases = await this.loadThreadCases(link.root_case_id, actorId);
    const byCaseId = new Map(threadCases.map((row) => [row.case_id, row]));

    // Walk from this follow-up's own parent up to the root, one hop at a
    // time, prepending as we go so the result ends up oldest first with the
    // immediate parent last — exactly the shape the per-ancestor resolution
    // below expects. Following `assistant_thread.parent_case_id` can only
    // ever name this Case's own lineage, so a sibling branch is structurally
    // excluded without needing to compare depths at all.
    const ancestors: Case[] = [];
    let cursorCaseId: string | undefined = link.parent_case_id;
    let steps = 0;
    while (cursorCaseId) {
      if (steps++ > threadCases.length) {
        throw new AssistantFollowUpError('The preceding Clerk conversation has a corrupt thread link (cycle detected).', {
          parent_case_id: link.parent_case_id,
          cursor_case_id: cursorCaseId,
        });
      }
      const ancestor: Case | undefined = byCaseId.get(cursorCaseId);
      if (!ancestor) {
        throw new AssistantFollowUpError('The preceding Clerk conversation is missing turns.', {
          parent_case_id: link.parent_case_id,
          missing_case_id: cursorCaseId,
        });
      }
      ancestors.unshift(ancestor);
      cursorCaseId = ancestor.assistant_thread?.parent_case_id;
    }
    // The walk terminates the moment `parent_case_id` runs out — on a
    // genuinely missing ancestor that's caught above, but a corrupted or
    // truncated `assistant_thread` can survive with a correct `depth` and
    // `root_case_id` and only its OWN `parent_case_id` gone missing or
    // falsy. Nothing above catches that: the loop just stops early and
    // hands back a short-but-otherwise-valid-looking chain, which
    // `assertPinnedFollowUpSources` cannot see since it only checks each
    // ancestor against its own child, never against the thread's actual
    // root. The root Case never carries `assistant_thread` (see
    // `resolveParentLink` and `assistant-task-grouping.ts`'s module doc),
    // so a walk that truly reached it always has the root as `ancestors[0]`
    // — for every legitimate chain, branched or linear, regardless of
    // depth. Assert that invariant explicitly instead of trusting a walk
    // that merely ran out of pointers.
    if (ancestors[0]?.case_id !== link.root_case_id) {
      throw new AssistantFollowUpError('The preceding Clerk conversation is missing turns.', {
        parent_case_id: link.parent_case_id,
        root_case_id: link.root_case_id,
        reached_case_id: ancestors[0]?.case_id ?? null,
      });
    }
    // The walked chain is the source of truth; `link.depth` is only a
    // recorded expectation from when the link was created (see
    // `resolveParentLink`). A mismatch would mean the thread was mutated in
    // some way the walk itself didn't already reject — worth knowing about,
    // not worth failing a request over.
    if (ancestors.length !== link.depth) {
      console.warn(
        `AssistantFollowUpService.loadContext: walked chain length ${ancestors.length} `
        + `does not match link.depth ${link.depth} for case ${case_.case_id}`,
      );
    }

    return Promise.all(ancestors.map(async (ancestor, index) => {
      // Every ancestor's own completed result is pinned on the NEXT case in
      // the chain — except the immediate parent (the last entry here), whose
      // result is pinned on `case_` itself, since `case_` IS that next case.
      const resultLink = index === ancestors.length - 1
        ? link
        : ancestors[index + 1]!.assistant_thread!;
      const [runSnap, evidenceSnap, artifactSnap] = await Promise.all([
        collections.runs().doc(resultLink.prior_run_id).get(),
        collections.evidence().doc(resultLink.prior_result_evidence_id).get(),
        collections.artifacts().doc(resultLink.prior_result_artifact_id).get(),
      ]);
      const sources: PinnedSourceDocuments = {
        parent: ancestor,
        run: runSnap.data(),
        evidence: evidenceSnap.data(),
        artifact: artifactSnap.data(),
      };
      assertPinnedFollowUpSources(resultLink, actorId, case_.project_id, case_.repository_id, sources);
      const result = parseResultDataUrl(
        await this.storage.read(sources.artifact.storage_path),
        resultLink,
        ancestor.case_id,
      );
      return {
        caseId: ancestor.case_id,
        request: ancestor.description,
        answer: result.answer,
        toolTrace: JSON.stringify(result.toolCalls),
      };
    }));
  }

  /** List one private Clerk conversation without using heuristic case relations. */
  async getThread(caseId: string, actorId: string): Promise<AssistantThreadResponse> {
    const anchorSnap = await collections.cases().doc(caseId).get();
    if (!anchorSnap.exists || anchorSnap.data()!.deleted_at) throw new NotFoundError('Case', caseId);
    const anchor = anchorSnap.data()!;
    if (anchor.case_type !== 'assistant_task') {
      throw new AssistantFollowUpError('The requested Case is not a Clerk task.');
    }
    assertRequester(anchor, actorId);
    const rootCaseId = anchor.assistant_thread?.root_case_id ?? anchor.case_id;
    const cases = await this.loadThreadCases(rootCaseId, actorId);
    const turns: AssistantThreadTurn[] = await Promise.all(cases.map(async (row) => {
      const evidenceSnap = await collections.evidence().where('case_id', '==', row.case_id).get();
      const taskResult = newest(
        evidenceSnap.docs.map((doc) => doc.data()).filter((item) => item.type === 'task_result'),
        (item) => item.created_at,
      );
      return {
        case_id: row.case_id,
        title: row.title,
        request: row.description,
        status: row.status,
        created_at: row.created_at,
        updated_at: row.updated_at,
        depth: row.assistant_thread?.depth ?? 0,
        ...(row.assistant_thread ? { parent_case_id: row.assistant_thread.parent_case_id } : {}),
        ...(taskResult?.summary ? { answer_preview: taskResult.summary } : {}),
      };
    }));
    return { root_case_id: rootCaseId, turns };
  }
}
