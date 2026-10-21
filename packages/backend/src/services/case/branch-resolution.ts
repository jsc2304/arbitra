import type { Case } from '@arbitra/shared';
import { collections } from '../../lib/firestore.js';

/**
 * Statuses that are considered terminal for branch resolution — mirrors
 * `TERMINAL_STATUSES` in branch-uniqueness.ts. A terminal case's branch is
 * still resolvable (e.g. a merged/done case is the last known owner of the
 * branch) but never wins over an active case sharing the same branch.
 */
const TERMINAL_STATUSES = new Set(['done', 'rejected']);

export interface ResolveCaseByBranchInput {
  repositoryId?: string | null;
  branch?: string | null;
}

export interface ResolveCaseByBranchResult {
  case: Case | null;
  /**
   * True when more than one non-terminal case currently shares this
   * (repository, branch) pair. `case` is still populated (the most recently
   * updated of them) so callers get a usable answer, but should surface the
   * ambiguity rather than silently trusting a single-case binding.
   */
  ambiguous: boolean;
}

/**
 * Resolve the case bound to a (repository, branch) pair — the inverse of the
 * case → branch binding (`current_branch` on the case). Stateless: every
 * call runs its own Firestore query and works only with locals, so
 * concurrent resolutions for different branches never share mutable state
 * or interfere with each other.
 *
 * - Unknown branch (no matching case) → `{ case: null, ambiguous: false }`,
 *   a normal answer, never an error.
 * - Exactly one matching, non-terminal case → that case.
 * - Multiple non-terminal cases sharing the branch (should not happen once
 *   `assertBranchUniqueForCase` is enforced at write time, but data can
 *   predate that guard or a race can slip through) → the most recently
 *   updated one, with `ambiguous: true`.
 * - Only terminal cases (e.g. the case is done and its branch was reused
 *   informally) → the most recently updated terminal case, `ambiguous: false`.
 */
export async function resolveCaseByBranch(
  input: ResolveCaseByBranchInput,
): Promise<ResolveCaseByBranchResult> {
  const { repositoryId, branch } = input;
  if (!repositoryId || !branch) {
    return { case: null, ambiguous: false };
  }

  const snap = await collections
    .cases()
    .where('repository_id', '==', repositoryId)
    .where('current_branch', '==', branch)
    .get();

  const candidates = snap.docs
    .map((doc) => doc.data() as Case)
    .filter((c) => !c.deleted_at);

  if (candidates.length === 0) {
    return { case: null, ambiguous: false };
  }

  const nonTerminal = candidates.filter((c) => !TERMINAL_STATUSES.has(c.status));
  const pool = nonTerminal.length > 0 ? nonTerminal : candidates;

  const mostRecent = [...pool].sort((a, b) => (b.updated_at > a.updated_at ? 1 : -1))[0]!;

  return {
    case: mostRecent,
    ambiguous: nonTerminal.length > 1,
  };
}
