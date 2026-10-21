import type { Case, CreateCaseInput, UpdateCaseInput, CaseFilters } from '@arbitra/shared';
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
  isCodeProducingCaseType,
  isProtectedBranch,
  SCOPED_CASE_TYPES,
} from '@arbitra/shared';
import { generateId } from '../../lib/ids.js';
import { CaseRepository } from './case-repository.js';
import { EventService } from '../event/event-service.js';

const EARLY_PHASE_ONLY_FIELDS = ['title', 'description', 'project_id', 'validation_track', 'risk_level', 'case_type'];
const EDITABLE_PHASES = ['open', 'exploration', 'ready_for_build'];
/** Statuses past which a case's PR/branch identity is frozen — see `updateCase` (issue #1045). */
const PR_IDENTITY_LOCKED_STATUSES = ['approved', 'pending_merge', 'done', 'rejected'];

export class CaseService {
  constructor(
    private readonly caseRepo = new CaseRepository(),
    private readonly eventService = new EventService(),
  ) {}

  async createCase(input: CreateCaseInput, actorId: string): Promise<Case> {
    assertBranchAllowsCaseType(input);

    const now = new Date().toISOString();
    const caseId = generateId('case');

    // Resolve validation_track: explicit > project default > 'direct'
    let resolvedTrack = input.validation_track;
    if (!resolvedTrack && input.project_id) {
      try {
        const { collections } = await import('../../lib/firestore.js');
        const projDoc = await collections.projects().doc(input.project_id).get();
        if (projDoc.exists) {
          resolvedTrack = projDoc.data()?.default_validation_track;
        }
      } catch {
        // Project lookup failed — fall through to default
      }
    }
    if (!resolvedTrack) resolvedTrack = 'direct';

    // Normalize repository_id: resolve slug format (org/repo) to internal ID (repo_XXXXX)
    let resolvedRepoId = input.repository_id;
    if (resolvedRepoId && !resolvedRepoId.startsWith('repo_')) {
      try {
        const { collections: cols } = await import('../../lib/firestore.js');
        const repoSnap = await cols.repositories()
          .where('project_id', '==', input.project_id)
          .limit(50)
          .get();
        const match = repoSnap.docs.find((d) => {
          const data = d.data();
          const url = data.url || '';
          return url.includes(resolvedRepoId!) || data.name === resolvedRepoId;
        });
        if (match) {
          resolvedRepoId = match.data().repository_id;
        }
      } catch {
        // Repository lookup failed — keep original value
      }
    }

    const newCase: Case = {
      case_id: caseId,
      title: input.title,
      description: input.description,
      source_type: input.source_type,
      source_ref: input.source_ref ?? '',
      project_id: input.project_id,
      repository_id: resolvedRepoId,
      owner_user_id: actorId,
      assigned_reviewer_id: input.assigned_reviewer_id,
      status: 'open',
      validation_track: resolvedTrack,
      risk_level: input.risk_level,
      priority: input.priority,
      case_type: input.case_type,
      assistant_context: input.assistant_context,
      current_branch: input.current_branch,
      current_pr_ref: input.current_pr_ref,
      // #1079: persist the commit the caller already told us about as the
      // observed head, so an autonomous approval right after case creation
      // (before any webhook has run) has something for approval-pin.ts to
      // pin. Without this, `current_head_sha` stayed unset until the first
      // PR webhook, and an approval in that window was written unpinned —
      // the next push then failed the `arbitra/case` required check closed.
      current_head_sha: input.git_context?.commit_sha,
      active_rule_set_refs: input.active_rule_set_refs ?? [],
      knowledge_context_refs: input.knowledge_context_refs ?? [],
      jira_refs: input.jira_refs ?? [],
      decision_ready: false,
      created_at: now,
      updated_at: now,
      deleted_at: null,
      deleted_by: null,
    };

    await this.caseRepo.create(newCase);

    await this.eventService.emit(
      caseId,
      'case_created',
      {
        title: input.title,
        project_id: input.project_id,
        validation_track: resolvedTrack,
        risk_level: input.risk_level,
      },
      actorId,
    );

    return newCase;
  }

  async getCase(caseId: string): Promise<Case> {
    return this.caseRepo.getById(caseId);
  }

  async updateCase(caseId: string, input: UpdateCaseInput, actorId: string): Promise<Case> {
    const existing = await this.caseRepo.getById(caseId);

    // #1030 / #1040: `observed` and `assistant_task` are
    // system-created only (see the create-path value guard in
    // packages/frontend/src/lib/case-type-guard.ts — `observed` comes from
    // the git-signal sweep's atomic claim/dedup, `assistant_task` from the
    // assistant intake transaction; neither writes through this method).
    // On update this has to be a TRANSITION guard, not a value guard: the
    // case-detail edit modal (case-header-edit-modal.tsx) sends the case's
    // current, unchanged case_type on every save (e.g. renaming just the
    // title of an already-`observed` case) — a value guard would 400 that.
    // Reject only an actual move INTO one of the internal-only types;
    // resubmitting the existing value is a no-op, same as the title/
    // priority/etc. diffing below.
    if (
      input.case_type !== undefined &&
      input.case_type !== existing.case_type &&
      SCOPED_CASE_TYPES.has(input.case_type)
    ) {
      throw new ValidationError(
        `case_type '${input.case_type}' is system-created only and cannot be set via this endpoint`,
        { case_type: input.case_type },
      );
    }

    // Phase-gate core fields
    const isEarlyPhase = EDITABLE_PHASES.includes(existing.status);
    if (!isEarlyPhase) {
      const restrictedKeys = Object.keys(input).filter((k) => EARLY_PHASE_ONLY_FIELDS.includes(k));
      if (restrictedKeys.length > 0) {
        throw new ForbiddenError(
          `Cannot edit ${restrictedKeys.join(', ')} — case is in '${existing.status}'. Core fields are only editable in early phases.`,
          { status: existing.status, fields: restrictedKeys },
        );
      }
    }

    // Issue #1045, secondary hardening: once a case has reached a decided
    // status, the PR/branch it points at is part of the verdict's meaning —
    // "this case approves PR #42", not "this case approves whatever PR it
    // currently names". Re-pointing an `approved` case at a different PR
    // through this endpoint would move the published `arbitra/case` status
    // onto a PR nobody reviewed.
    //
    // Deliberately NOT done by adding these to `EARLY_PHASE_ONLY_FIELDS`:
    // `current_branch`/`current_pr_ref` legitimately appear DURING
    // `in_build`/`in_validation`/`in_review` (an agent creates the case, then
    // pushes a branch), so the early-phase gate would break the normal
    // workflow. Only a change once the case is decided is refused, and only
    // an actual change — resubmitting the same value stays a no-op, matching
    // the `case_type` guard above.
    //
    // This is a defence in depth, not the fix: the webhook path writes
    // through `caseRepo` and never reaches `CaseService.updateCase` at all,
    // which is why `Case.approved_head_sha` (pinned to the reviewed commit)
    // is the primary guard — a re-pointed PR has a different head SHA and
    // therefore cannot match the pin either.
    if (PR_IDENTITY_LOCKED_STATUSES.includes(existing.status)) {
      const repointed = (['current_pr_ref', 'current_branch'] as const).filter(
        (key) => input[key] !== undefined && input[key] !== existing[key],
      );
      if (repointed.length > 0) {
        throw new ForbiddenError(
          `Cannot change ${repointed.join(', ')} — case is in '${existing.status}'. `
          + `A decided case stays bound to the PR its decision was made against.`,
          { status: existing.status, fields: repointed },
        );
      }
    }

    // A `project_id` change re-homes the case
    // into a different project's isolation boundary. The phase-gate above
    // only restricts *when* this can happen — it never checked the
    // destination existed or that the caller belongs to it, so a case
    // owner could move their case into a project_id they have no standing
    // in (inheriting visibility never granted) or into a nonexistent one
    // (immediately orphaning it). Mirrors `requireProjectAccess`'s
    // 404-for-both semantics (api-helpers.ts) so a caller can't distinguish
    // "no such project" from "not a member of it" by probing project_id
    // values here.
    if (input.project_id !== undefined && input.project_id !== existing.project_id) {
      const { collections } = await import('../../lib/firestore.js');
      const { isEffectiveMember, checkIsAdmin } = await import('../../lib/project-access.js');
      const destDoc = await collections.projects().doc(input.project_id).get();
      if (!destDoc.exists) {
        throw new NotFoundError('Project', input.project_id);
      }

      const isAdmin = await checkIsAdmin(actorId);
      if (!isAdmin && !isEffectiveMember(destDoc.data()!, actorId)) {
        throw new NotFoundError('Project', input.project_id);
      }
    }

    const updates: Partial<Case> = {
      ...input,
      updated_at: new Date().toISOString(),
    };

    // `assistantContextSchema` (shared by `createCaseSchema` and
    // `updateCaseSchema`) has no `blueprint_id`/`blueprint_context` fields —
    // deliberately, so blueprint provenance can never be forged through this
    // public write path (`findNonTerminalBlueprintCaseId` trusts
    // `blueprint_id` with no project/owner scoping, and the occurrence
    // creator skips creating a new case on any hit). The schema also has no
    // `reads_withheld`/`reads_withheld_reason` fields — those are stamped
    // only by `AssistantTaskExecutor`'s own `done`-transition write (a
    // separate path, `applyTransitionInTransaction` →
    // `CaseRepository.updateInTransaction`, already safe because it spreads
    // the existing `assistant_context` itself), never by this public route.
    // But `ref.update()` replaces the whole `assistant_context` map, not a
    // deep merge — so any caller PATCHing `assistant_context` at all (e.g.
    // to add `wait_reason`) through THIS path would otherwise silently wipe
    // an existing blueprint reference, an existing `reads_withheld`
    // flag/reason, or the Chat double-post guard off the case, because the
    // validated input can never carry any of these fields back. Re-attach
    // them all here, from the document already read above, so an update can
    // change the rest of `assistant_context` without dropping any of them.
    if (input.assistant_context !== undefined) {
      const existingContext = existing.assistant_context;
      updates.assistant_context = {
        ...input.assistant_context,
        ...(existingContext?.blueprint_id !== undefined
          ? { blueprint_id: existingContext.blueprint_id }
          : {}),
        ...(existingContext?.blueprint_context !== undefined
          ? { blueprint_context: existingContext.blueprint_context }
          : {}),
        ...(existingContext?.reads_withheld !== undefined
          ? { reads_withheld: existingContext.reads_withheld }
          : {}),
        ...(existingContext?.reads_withheld_reason !== undefined
          ? { reads_withheld_reason: existingContext.reads_withheld_reason }
          : {}),
        // `chat_reply_posted_at` is the Slice F double-post guard: losing it
        // would let the same Clerk answer be posted into a Chat space twice.
        // `assistant_context` is not phase-gated, so an update can legally
        // arrive even on a terminal case — exactly when the guard matters.
        ...(existingContext?.chat_reply_posted_at !== undefined
          ? { chat_reply_posted_at: existingContext.chat_reply_posted_at }
          : {}),
      };
    }

    // Track risk level changes for audit
    if (input.risk_level && input.risk_level !== existing.risk_level) {
      await this.eventService.emit(
        caseId,
        'risk_level_changed',
        {
          from: existing.risk_level,
          to: input.risk_level,
        },
        actorId,
      );
    }

    // Issue #794 (timeline P1): case-detail edits other than risk_level
    // previously left no audit trail at all — the timeline showed only
    // "Case Created" no matter how many times title/description/case_type/
    // priority/validation_track were changed afterward. One `case_updated`
    // event per `updateCase` call, diffed against `existing` (never the raw
    // `input`) so re-submitting the same value is a no-op and emits nothing.
    // `title`/`case_type`/`priority`/`validation_track` are short enough to
    // carry old→new values; `description` carries only a changed-marker
    // (`changed` lists it, no `description` key) — free-text bodies can be
    // long, and the timeline is an audit trail, not a diff viewer.
    const caseUpdatedChanged: string[] = [];
    const caseUpdatedFields: Record<string, { from: unknown; to: unknown }> = {};

    if (input.title !== undefined && input.title !== existing.title) {
      caseUpdatedChanged.push('title');
      caseUpdatedFields.title = { from: existing.title, to: input.title };
    }
    if (input.case_type !== undefined && input.case_type !== existing.case_type) {
      caseUpdatedChanged.push('case_type');
      caseUpdatedFields.case_type = { from: existing.case_type, to: input.case_type };
    }
    if (input.priority !== undefined && input.priority !== existing.priority) {
      caseUpdatedChanged.push('priority');
      caseUpdatedFields.priority = { from: existing.priority, to: input.priority };
    }
    if (input.validation_track !== undefined && input.validation_track !== existing.validation_track) {
      caseUpdatedChanged.push('validation_track');
      caseUpdatedFields.validation_track = { from: existing.validation_track, to: input.validation_track };
    }
    if (input.description !== undefined && input.description !== existing.description) {
      caseUpdatedChanged.push('description');
    }

    if (caseUpdatedChanged.length > 0) {
      await this.eventService.emit(
        caseId,
        'case_updated',
        {
          changed: caseUpdatedChanged,
          ...caseUpdatedFields,
        },
        actorId,
      );
    }

    return this.caseRepo.update(caseId, updates);
  }

  async listCases(filters: CaseFilters): Promise<{ cases: Case[]; cursor?: string }> {
    return this.caseRepo.list(filters);
  }

  /**
   * Soft-delete a case. Hides it from `getCase` and `listCases` without
   * removing the underlying doc or its related collections (events, evidence,
   * comments, findings, decisions, runs, artifacts) — all remain intact for
   * audit. Emits a `case_deleted` event.
   */
  async deleteCase(caseId: string, actorId: string): Promise<void> {
    // Ensure the case exists (and is not already soft-deleted) before emitting.
    await this.caseRepo.getById(caseId);
    await this.caseRepo.softDelete(caseId, actorId);
    await this.eventService.emit(caseId, 'case_deleted', {}, actorId);
  }

  /**
   * Count cases matching any of the supplied statuses, optionally scoped to a
   * set of accessible project IDs. Backed by Firestore's server-side
   * `.count()` aggregation.
   */
  async countByStatus(
    statuses: readonly string[],
    projectIds?: readonly string[],
  ): Promise<number> {
    return this.caseRepo.countByStatus(statuses, projectIds);
  }
}

export function assertBranchAllowsCaseType(input: CreateCaseInput): void {
  if (!isCodeProducingCaseType(input.case_type)) return;

  const branch = input.current_branch ?? input.git_context?.branch;
  if (!isProtectedBranch(branch)) return;

  throw new ValidationError(
    `Case type '${input.case_type}' produces code changes and cannot be created on branch '${branch}'. ` +
      `Create a feature branch first (e.g. feat/<slug>, fix/<slug>, refactor/<slug>, security/<slug>) ` +
      `and retry with that branch.`,
    { case_type: input.case_type, branch },
  );
}
