import { NextRequest, NextResponse } from 'next/server';
import { authenticate, handleError } from '@/lib/api-helpers';
import { updateChatIdentitySchema } from '@arbitra/shared';

/**
 * PATCH /api/users/:userId/chat-identity — admin-gated Chat identity remap
 * (issue #1069 fix 1).
 *
 * CLEAR ONLY: `chat_user_id` is an opaque Google Chat resource id surfaced in no UI and
 * no log, so there is no value an admin could type in for a replace
 * variant — this route only deletes `chat_identity` back to unmapped. The
 * next Chat message from the correct account re-runs `mapChatIdentity`
 * (`packages/backend/src/services/chat/chat-identity-service.ts`) and
 * re-establishes the mapping naturally.
 *
 * Uses `requireRole` (not the inline check `roles/route.ts` uses) — see
 * that route's own docstring: its inline gate is a pinned pre-existing
 * check, not the pattern new routes should copy. `requireRole` is the
 * dominant admin-gate pattern elsewhere in this codebase (e.g.
 * `api/settings/llm/route.ts`).
 *
 * Fixes 2 (mapping_conflict admin-visible signal) and 3 (the check-then-act
 * race in `mapChatIdentity`) are explicitly out of scope for this route —
 * they are separate, unstarted parts of issue #1069. This route's OWN
 * read-then-write, however, is wrapped in a transaction (below) rather than
 * shipping that same race class new: see the transaction comment.
 */
export async function PATCH(request: NextRequest, props: { params: Promise<{ userId: string }> }) {
  const params = await props.params;
  try {
    const auth = await authenticate(request);
    const { requireRole, collections, getDb, WorkspaceEventService, validateBody } = await import(
      '@arbitra/backend'
    );
    await requireRole(auth.userId, ['admin']);

    const body = await request.json();
    validateBody(updateChatIdentitySchema, body);

    const { FieldValue } = await import('firebase-admin/firestore');
    const targetRef = collections.users().doc(params.userId);
    const workspaceEventService = new WorkspaceEventService();

    // Transactional read-modify-write: `targetRef.get()` followed by a plain
    // `targetRef.update()` would let a concurrent write to the same doc
    // (e.g. a `mapChatIdentity` commit binding a brand-new mapping) land
    // between our read and our write. The unconditional delete would then
    // silently clobber that fresh mapping, and the audit event below would
    // record the STALE `previous` we read rather than what was actually
    // deleted. Wrapping the read, the no-op check, the delete, and the
    // audit write in one `runTransaction` (idiom from
    // `chat-identity-service.ts`'s `mapChatIdentity` and
    // `auth/connect/approve/route.ts`) makes Firestore retry the whole
    // block on conflict, so the delete and the audit always act on the
    // freshest data — never a value that has already moved on.
    //
    // The audit write joins the SAME transaction via
    // `WorkspaceEventService.recordInTransaction` (mirrors
    // `EventRepository.createInTransaction` / `EventService.emitInTransaction`)
    // rather than being issued after commit: this event exists to record
    // what was deleted, and a post-commit `.record()` call could either be
    // lost entirely (process dies between commit and that call) or could
    // race a second transaction attempt. Both are the same "audit event
    // must not go missing" argument that applies to status
    // writes — it applies here because `recordInTransaction` exists and
    // costs nothing extra; where no `*InTransaction` variant exists (see
    // `EventService.notifyCommitted`, used for fire-and-forget
    // notifications), that argument does NOT license inventing one for a
    // side effect that isn't a Firestore write.
    const result = await getDb().runTransaction(async (tx) => {
      const targetDoc = await tx.get(targetRef);
      if (!targetDoc.exists) {
        return { kind: 'not_found' as const };
      }

      const targetData = targetDoc.data()!;
      const previous = targetData.chat_identity;
      if (!previous) {
        // Idempotent no-op: nothing bound, nothing to clear, no audit noise.
        return { kind: 'noop' as const, data: targetData };
      }

      const now = new Date().toISOString();
      tx.update(targetRef, { chat_identity: FieldValue.delete(), updated_at: now });

      workspaceEventService.recordInTransaction(tx, {
        type: 'chat_identity_cleared',
        actor_user_id: auth.userId,
        summary: `Cleared Chat identity mapping for user ${params.userId}`,
        evidence: {
          target_user_id: params.userId,
          previous_chat_user_id: previous.chat_user_id,
          previous_space_name: previous.space_name,
        },
      });

      return { kind: 'cleared' as const };
    });

    if (result.kind === 'not_found') {
      return NextResponse.json({ error: { message: 'User not found' } }, { status: 404 });
    }
    if (result.kind === 'noop') {
      return NextResponse.json(result.data);
    }

    const updated = await targetRef.get();
    return NextResponse.json(updated.data());
  } catch (error) {
    return handleError(error);
  }
}
