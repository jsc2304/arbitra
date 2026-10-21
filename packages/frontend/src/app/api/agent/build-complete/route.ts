import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  actorMetadataSchema,
  CANONICAL_EVIDENCE_TYPES,
  canonicalEvidenceTypeSchema,
  createCommentSchema,
  createEvidenceSchema,
  normalizeActorMetadata,
  prRefSchema,
} from '@arbitra/shared';
import type { Comment } from '@arbitra/shared';
import {
  authenticate,
  handleError,
  invalidJsonResponse,
  requireCaseAccess,
  validate,
  validationErrorResponse,
} from '@/lib/api-helpers';
import { resolveCaseShareUrl } from '@/lib/public-base-url';

// ---------------------------------------------------------------------------
// POST /api/agent/build-complete
//
// High-level action that replaces 5-6 separate calls:
//   1. Update case with current_branch and current_pr_ref (PATCH)
//   2. Register all evidence items
//   3. Post build summary as a comment (source: ide_agent)
//   4. Create a `build_run` (triggers pipeline auto-transition)
//   5. Fetch and return final case status
// ---------------------------------------------------------------------------

// Per-item schema: identical to createEvidenceSchema but `case_id` is supplied
// by the route (not the agent), so we omit it from the wire-format payload.
// `source_type` is enforced as a strict required enum by the shared schema;
// MCP clients from arbitra-mcp v2.0.1+ inject `'agent'` as a Zod default
// before the POST, so agents can explicitly classify evidence provenance.
//
// `type` is additionally narrowed to `canonicalEvidenceTypeSchema` here (the
// base `createEvidenceSchema` keeps `type` permissive for webhooks/policy custom
// types). This closes the silent-drop footgun: a non-canonical inline type
// (e.g. `manual_verification`) used to pass validation, get registered, then
// fail to satisfy any required-evidence type — leaving the gate unmet with no
// error. Now the boundary rejects it with a named-type + accepted-types 400.
const buildCompleteEvidenceItemSchema = createEvidenceSchema
  .omit({ case_id: true })
  .extend({ type: canonicalEvidenceTypeSchema });

const buildCompleteEvidenceArraySchema = z.array(buildCompleteEvidenceItemSchema);

const buildCompleteRequestSchema = z.object({
  case_id: z.string().min(1),
  branch: z.string().optional(),
  // Validated as a real PR reference (issue #1046 review): this value is
  // PATCHed onto `Case.current_pr_ref`, which the terminal-case ownership
  // check compares against.
  pr_url: prRefSchema.optional(),
  summary: z.string().min(1),
  evidence: buildCompleteEvidenceArraySchema.optional(),
  actor_metadata: actorMetadataSchema.optional(),
});

export async function POST(request: NextRequest) {
  // --- Parse & validate request body ---
  let body: z.infer<typeof buildCompleteRequestSchema>;
  try {
    const rawBody = await request.json();
    const parsed = buildCompleteRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      // Surface unknown evidence `type` values as a dedicated, actionable
      // envelope before falling back to the generic validation blob. This is
      // the silent-drop fix: a non-canonical inline type must come back to the
      // caller naming the offending value(s) and the accepted types, never get
      // dropped without feedback.
      const unknownTypeResponse = unknownEvidenceTypeResponse(rawBody, parsed.error.issues);
      if (unknownTypeResponse) return unknownTypeResponse;
      return validationErrorResponse('Invalid request payload', parsed.error.issues);
    }
    body = parsed.data;
  } catch {
    return invalidJsonResponse();
  }

  const {
    case_id,
    branch,
    pr_url,
    summary,
    evidence: validatedEvidence = [],
    actor_metadata: topLevelActorMetadata,
  } = body;

  try {
    const auth = await authenticate(request);
    const denied = await requireCaseAccess(case_id, auth.userId);
    if (denied) return denied;

    const { safeHeartbeat } = await import('@arbitra/backend');
    await safeHeartbeat({ caseId: case_id, userId: auth.userId, source: 'ide_agent' });

    const { CaseService, EvidenceService, collections, generateId, assertBranchUniqueForCase } = await import('@arbitra/backend');
    const caseService = new CaseService();

    const caseData = await caseService.getCase(case_id);
    if (caseData.status !== 'in_build') {
      return NextResponse.json(
        {
          error: {
            code: 'INVALID_CASE_STATE',
            message: `Case is in '${caseData.status}' — must be 'in_build' to complete build`,
            details: {
              current_status: caseData.status,
              required_status: 'in_build',
            },
          },
        },
        { status: 400 },
      );
    }

    // One case, one branch: if the agent supplies a branch (or we already have
    // one on the case), reject when another non-terminal case in the same repo
    // already owns it. This catches agents who bypassed the transition guard
    // by editing current_branch out-of-band or starting on a conflicting
    // branch before in_build.
    const effectiveBranch = branch ?? caseData.current_branch;
    try {
      await assertBranchUniqueForCase({
        caseId: case_id,
        repositoryId: caseData.repository_id,
        branch: effectiveBranch,
      });
    } catch (err) {
      if (err instanceof Error && (err as { code?: string }).code === 'BRANCH_CONFLICT') {
        return NextResponse.json(
          {
            error: {
              code: 'BRANCH_CONFLICT',
              message: err.message,
              details: (err as { details?: unknown }).details,
            },
          },
          { status: 409 },
        );
      }
      throw err;
    }

    // 1. Update case with branch/PR info
    const patchFields: Record<string, string> = {};
    if (branch) patchFields.current_branch = branch;
    if (pr_url) patchFields.current_pr_ref = pr_url;
    if (Object.keys(patchFields).length > 0) {
      await caseService.updateCase(case_id, patchFields, auth.userId);
    }

    // 2. Register evidence items (already validated above)
    const { FirestorePipelineAdapter } = await import('@arbitra/backend');
    const pipelineAdapter = new FirestorePipelineAdapter();
    const evidenceService = new EvidenceService(undefined, undefined, undefined, undefined, pipelineAdapter);

    if (validatedEvidence.length > 0) {
      for (const item of validatedEvidence) {
        await evidenceService.registerEvidence(
          {
            case_id,
            type: item.type,
            source_type: item.source_type,
            summary: item.summary,
            artifact_ref: item.artifact_ref,
            machine_readable: item.machine_readable ?? false,
            // Normalization happens inside EvidenceService.registerEvidence via
            // normalizeActorMetadata, so pass the raw validated value through.
            ...(item.actor_metadata !== undefined && { actor_metadata: item.actor_metadata }),
          },
          auth.userId,
        );
      }
    }

    // 2b. Hard-stop build completion before the build_run is created when the
    // effective evidence policy still has gaps. This keeps the case in_build
    // and gives the agent a specific fix-forward payload instead of allowing
    // an advance-then-stall path.
    const completeness = await evidenceService.evaluateCompleteness(case_id);
    if (!completeness.satisfied) {
      return NextResponse.json(
        {
          error: {
            code: 'MISSING_REQUIRED_EVIDENCE',
            message: `Cannot complete build — missing required evidence: ${completeness.missing.join(', ')}`,
            details: {
              ...completeness,
              hint: 'Register the missing evidence types and retry build completion.',
            },
          },
        },
        { status: 400 },
      );
    }

    // 3. Post build summary as a comment. Route through the shared
    // createCommentSchema so this channel honors the same validation
    // contract as POST /api/cases/:caseId/comments (previously inline and
    // bypassed the schema).
    const commentInput = validate(createCommentSchema, {
      parent_type: 'case',
      parent_id: case_id,
      body: summary,
      source: 'ide_agent',
      agent_name: 'ide-agent',
      ...(topLevelActorMetadata !== undefined && { actor_metadata: topLevelActorMetadata }),
    });
    const commentActorMetadata = normalizeActorMetadata(commentInput.actor_metadata);
    const comment: Comment = {
      comment_id: generateId('comment'),
      parent_type: commentInput.parent_type,
      parent_id: commentInput.parent_id,
      author_id: auth.userId,
      body: commentInput.body,
      created_at: new Date().toISOString(),
      source: commentInput.source ?? 'ide_agent',
      ...(commentInput.agent_name !== undefined && { agent_name: commentInput.agent_name }),
      ...(commentActorMetadata !== undefined && { actor_metadata: commentActorMetadata }),
      // Structural tag — lets the dossier locate this summary slot without
      // temporal pairing against the lifecycle event. Server-side only; the
      // request payload is unchanged.
      kind: 'build_summary',
    };
    await collections.comments().doc(comment.comment_id).set(comment);

    // 4. Create build_run + trigger pipeline
    const { RunCompletionHandler } = await import('@arbitra/backend');
    const run = await pipelineAdapter.createRun(case_id, 'build_run', auth.userId);
    await pipelineAdapter.completeRun(run.run_id, case_id, 'Build completed via agent action endpoint');
    const pipeline = new RunCompletionHandler(pipelineAdapter);
    await pipeline.onRunCompleted(case_id);

    // 5. Fetch final status
    const fresh = await caseService.getCase(case_id);

    const share_url = resolveCaseShareUrl(request, fresh.case_id, fresh.status);

    return NextResponse.json({
      status: fresh.status,
      message: `Build complete. Case advanced to '${fresh.status}'.`,
      next: getNextMessage(fresh.status),
      ...(share_url !== null && { share_url }),
    });
  } catch (error) {
    return handleError(error);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * If the schema rejection was caused by one or more non-canonical evidence
 * `type` values, return a dedicated 400 that names the offending type(s) and
 * lists the accepted types. Returns `null` when no `type`-enum issue is present
 * so the caller can fall through to the generic validation envelope.
 *
 * Extracts the offending values from the raw payload (not the Zod issue) so the
 * caller sees exactly what they sent, even for repeated/invalid items.
 */
function unknownEvidenceTypeResponse(
  rawBody: unknown,
  issues: readonly z.ZodIssue[],
): NextResponse | null {
  const typeIssues = issues.filter(
    (issue) =>
      issue.code === 'invalid_enum_value' &&
      issue.path[0] === 'evidence' &&
      issue.path[issue.path.length - 1] === 'type',
  );
  if (typeIssues.length === 0) return null;

  const evidenceArray = (rawBody as { evidence?: unknown })?.evidence;
  const invalidTypes = new Set<string>();
  for (const issue of typeIssues) {
    const index = issue.path[1];
    if (typeof index === 'number' && Array.isArray(evidenceArray)) {
      const item = evidenceArray[index] as { type?: unknown } | undefined;
      if (item && typeof item.type === 'string') invalidTypes.add(item.type);
    }
  }
  const offending = [...invalidTypes];

  return NextResponse.json(
    {
      error: {
        code: 'UNKNOWN_EVIDENCE_TYPE',
        message:
          offending.length > 0
            ? `Unknown evidence type(s): ${offending.join(', ')}. ` +
              `Accepted types: ${CANONICAL_EVIDENCE_TYPES.join(', ')}.`
            : `One or more evidence items has an unknown type. ` +
              `Accepted types: ${CANONICAL_EVIDENCE_TYPES.join(', ')}.`,
        details: {
          invalid_evidence_types: offending,
          accepted_evidence_types: [...CANONICAL_EVIDENCE_TYPES],
          hint: 'Resubmit with a canonical evidence type. For manual attestation use "manual_confirmation".',
        },
      },
    },
    { status: 400 },
  );
}

function getNextMessage(status: string): string {
  switch (status) {
    case 'in_validation':
      return 'Validation is running. Case will auto-advance when complete.';
    case 'in_review':
      return 'Auto-review triggered. Case will auto-advance if no critical findings.';
    case 'needs_human_decision':
      return 'Review complete with findings. A human reviewer must approve, request changes, or reject.';
    case 'approved':
      return 'Case has been approved. It will auto-transition to pending_merge.';
    case 'pending_merge':
      return 'Case is ready to merge. Merge the PR to complete.';
    default:
      return `Case is in '${status}'. Check the context endpoint for next steps.`;
  }
}
