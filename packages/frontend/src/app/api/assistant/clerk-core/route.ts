import { NextRequest, NextResponse } from 'next/server';
import { ProvisionClerkCoreService } from '@arbitra/backend';
import { authenticate, handleError } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

const provisionService = new ProvisionClerkCoreService();

/**
 * `POST /api/assistant/clerk-core` — provision the signed-in user's private
 * `Clerk` project, placeholder repository, and evidence policy: the three
 * documents `AssistantIntakeService` requires before it will accept an
 * assistant task (see `ClerkCoreNotProvisionedError`). Runs inside Cloud Run,
 * so it authenticates through the runtime identity like every other route
 * here — unlike `scripts/setup-clerk-core.ts`, it needs no
 * `GOOGLE_APPLICATION_CREDENTIALS` / `applicationDefault()` setup, which is
 * exactly what makes per-user, self-service provisioning workable: the
 * script does not scale past a handful of people run by hand. The script
 * stays in place as the administrative path (e.g. provisioning ahead of a
 * user's first sign-in); both build the same documents from
 * `clerk-core-documents.ts` so neither can drift from the other.
 *
 * The user id always comes from the authenticated session, never from the
 * request body — there is no other-user project to guard against, because
 * the id is *derived* from the caller (`clerkCoreIds`). A body is accepted
 * (or omitted) but never parsed, so a caller cannot use this endpoint to
 * provision — or discover — another user's Clerk core by posting one.
 *
 * Idempotent: safe to call on every sign-in, or speculatively before every
 * assistant-task submission. Each of the three documents is reported
 * individually as `created` or `already_provisioned` — see
 * `ProvisionClerkCoreService` for exactly what "already provisioned" means
 * (existence at the deterministic id, not a content match: an existing
 * document is never patched, since drift from a fresh build may be a
 * deliberate customization).
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const auth = await authenticate(request);
    const result = await provisionService.provision(auth.userId);

    const createdAnything = result.items.some((item) => item.status === 'created');
    return NextResponse.json(
      {
        project_id: result.ids.projectId,
        repository_id: result.ids.repositoryId,
        policy_id: result.ids.policyId,
        items: result.items,
      },
      // Nothing created on a repeat call: report 200, not 201, matching the
      // replay-vs-create distinction `POST /api/assistant/tasks` makes.
      { status: createdAnything ? 201 : 200 },
    );
  } catch (error) {
    return handleError(error);
  }
}
