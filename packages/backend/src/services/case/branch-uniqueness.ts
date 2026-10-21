import type { Case } from '@arbitra/shared';
import { ArbitraError } from '@arbitra/shared';
import { collections } from '../../lib/firestore.js';

/**
 * Statuses that are considered terminal — cases in these statuses do NOT
 * contest branch ownership (a done case's branch may be merged and therefore
 * reusable-looking, but we still recommend fresh branches per case).
 */
const TERMINAL_STATUSES = new Set(['done', 'rejected']);

export class BranchConflictError extends ArbitraError {
  constructor(
    public readonly branch: string,
    public readonly repositoryId: string,
    public readonly conflictingCaseId: string,
    public readonly conflictingCaseStatus: string,
    public readonly currentCaseId: string,
  ) {
    super(
      `Branch '${branch}' is already owned by case '${conflictingCaseId}' (status: ${conflictingCaseStatus}) in the same repository. Every case must have its own feature branch.`,
      'BRANCH_CONFLICT',
      409,
      {
        code: 'BRANCH_CONFLICT',
        branch,
        repository_id: repositoryId,
        conflicting_case_id: conflictingCaseId,
        conflicting_case_status: conflictingCaseStatus,
        current_case_id: currentCaseId,
        guidance:
          'One case, one branch. Either finish the other case first, or start a fresh branch for this one: `git checkout main && git pull --ff-only && git checkout -b feat/<case-id>`.',
      },
    );
    this.name = 'BranchConflictError';
  }
}

export interface BranchUniquenessInput {
  caseId: string;
  repositoryId?: string | null;
  branch?: string | null;
}

/**
 * Ensure no OTHER non-terminal case in the same repository_id already owns
 * `branch`. Throws BranchConflictError if there is a conflict.
 *
 * No-op when `branch` or `repositoryId` is missing — both are required to
 * evaluate uniqueness in any meaningful way.
 *
 * Firestore cannot combine `where(status not-in ...)` with other non-equality
 * filters cleanly alongside `where(repository_id, ==)` + `where(current_branch, ==)`,
 * so we fetch candidate matches on the two equality filters and filter out
 * terminal statuses client-side. In practice this returns ≤ small N (cases
 * sharing a branch should be 0 or 1 in the steady state).
 */
export async function assertBranchUniqueForCase(
  input: BranchUniquenessInput,
): Promise<void> {
  const { caseId, repositoryId, branch } = input;
  if (!branch || !repositoryId) {
    return;
  }

  const snap = await collections
    .cases()
    .where('repository_id', '==', repositoryId)
    .where('current_branch', '==', branch)
    .get();

  for (const doc of snap.docs) {
    const other = doc.data() as Case;
    if (other.case_id === caseId) continue;
    if (TERMINAL_STATUSES.has(other.status)) continue;
    throw new BranchConflictError(
      branch,
      repositoryId,
      other.case_id,
      other.status,
      caseId,
    );
  }
}
