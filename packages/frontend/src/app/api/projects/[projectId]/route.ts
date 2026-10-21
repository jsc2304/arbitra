import { NextRequest, NextResponse } from 'next/server';
import { notificationConfigSchema, updateProjectSchema } from '@arbitra/shared';
import { authenticate, handleError, validate, validationErrorResponse } from '@/lib/api-helpers';
import { validateLlmOverrides } from './llm-overrides-validator';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, props: { params: Promise<{ projectId: string }> }) {
  const params = await props.params;
  try {
    const auth = await authenticate(request);
    const { collections, checkIsAdmin, isEffectiveMember } = await import('@arbitra/backend');
    const doc = await collections.projects().doc(params.projectId).get();
    if (!doc.exists) {
      return NextResponse.json({ error: { message: 'Project not found' } }, { status: 404 });
    }
    const project = doc.data()!;
    const admin = await checkIsAdmin(auth.userId);
    if (!admin && !isEffectiveMember(project, auth.userId)) {
      return NextResponse.json({ error: { message: 'Project not found' } }, { status: 404 });
    }
    return NextResponse.json(project);
  } catch (error) {
    return handleError(error);
  }
}

export async function PATCH(request: NextRequest, props: { params: Promise<{ projectId: string }> }) {
  const params = await props.params;
  try {
    const auth = await authenticate(request);
    const body = await request.json();
    const { collections } = await import('@arbitra/backend');
    const ref = collections.projects().doc(params.projectId);
    const doc = await ref.get();
    if (!doc.exists) {
      return NextResponse.json({ error: { message: 'Project not found' } }, { status: 404 });
    }
    // Only project owner or admin may edit
    const projectData = doc.data()!;
    const userDoc = await collections.users().doc(auth.userId).get();
    const roles: string[] = userDoc.exists ? (userDoc.data()!.roles ?? []) : [];
    const isOwner = projectData.owner_user_id === auth.userId;
    const isAdmin = roles.includes('admin');
    if (!isOwner && !isAdmin) {
      return NextResponse.json(
        { error: { message: 'Only the project owner or an admin can edit this project' } },
        { status: 403 },
      );
    }
    // Prevent changing immutable fields
    const { project_id: _pid, created_at: _ca, owner_user_id: _oui, ...safeBody } = body;
    if ('llm_overrides' in safeBody) {
      const check = validateLlmOverrides(safeBody.llm_overrides, params.projectId);
      if (!check.ok) {
        return NextResponse.json({ error: { message: check.message } }, { status: 400 });
      }
    }
    // Notification config (spec Slice C item 3, `docs/specs/clerk-config-scheduling-chat.md`):
    // `notification_webhook_url` must be Google-Chat-hosted (or empty/null to
    // clear), `notification_events` keys must be catalog members with boolean
    // values, `notification_templates` values must be strings — all BEFORE
    // the Firestore write below. Deliberately narrow to these three fields
    // (not `updateProjectSchema`, which also tightens unrelated fields this
    // route doesn't validate today) — see `notificationConfigSchema`'s doc
    // comment in `project-validators.ts`.
    const notificationCheck = notificationConfigSchema.safeParse(safeBody);
    if (!notificationCheck.success) {
      return validationErrorResponse('Invalid notification configuration', notificationCheck.error.issues);
    }
    // Full-body validation (issue #1070): `updateProjectSchema` covers every
    // writable `Project` field (the notification/llm_overrides fields above
    // included, kept in sync with the narrower checks above) and `.strict()`s
    // out unknown keys — a typo'd or unexpected field 400s instead of being
    // silently dropped or persisted unchecked. `input` (not `safeBody`) is
    // what gets written, so `name`/etc. are trimmed exactly once.
    const input = validate(updateProjectSchema, safeBody);
    const updates: Record<string, unknown> = { ...input, updated_at: new Date().toISOString() };
    // `notification_webhook_url: null` (or `''`) is the schema's dedicated
    // "explicitly cleared" signal (`notificationWebhookUrlSchema.nullable()`),
    // distinct from the key being absent, which means "leave alone" — Zod
    // omits an `.optional()` key entirely when the client's PATCH body
    // didn't send it, so `ref.update()` (which only touches keys present in
    // its argument) already leaves an omitted field untouched. But writing
    // the literal value `null`/`''` through would leave the field
    // present-but-falsy in Firestore, diverging from `Project.notification_
    // webhook_url?: string` (no null branch) and from this same route's
    // sibling clear pattern (`github_token` in
    // `repositories/[projectId]/route.ts`) — so an explicit clear is turned
    // into a real field delete instead (issue #1100).
    if (
      'notification_webhook_url' in updates
      && (updates.notification_webhook_url === null || updates.notification_webhook_url === '')
    ) {
      const { FieldValue } = await import('firebase-admin/firestore');
      updates.notification_webhook_url = FieldValue.delete();
    }
    await ref.update(updates);
    // Invalidate project LLM config cache if llm_overrides were changed
    if ('llm_overrides' in input) {
      const { invalidateProjectConfigCache } = await import('@arbitra/backend');
      invalidateProjectConfigCache(params.projectId);
    }
    const updated = await ref.get();
    return NextResponse.json(updated.data());
  } catch (error) {
    return handleError(error);
  }
}

export async function DELETE(request: NextRequest, props: { params: Promise<{ projectId: string }> }) {
  const params = await props.params;
  try {
    const auth = await authenticate(request);
    const { collections, getDb } = await import('@arbitra/backend');
    const userDoc = await collections.users().doc(auth.userId).get();
    const roles: string[] = userDoc.exists ? (userDoc.data()!.roles ?? []) : [];
    if (!roles.includes('admin')) {
      return NextResponse.json({ error: { message: 'Admin role required' } }, { status: 403 });
    }
    await collections.projects().doc(params.projectId).delete();
    // Clean up related repositories
    const repoSnap = await collections.repositories().where('project_id', '==', params.projectId).get();
    const batch = getDb().batch();
    repoSnap.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
    return NextResponse.json({ success: true });
  } catch (error) {
    return handleError(error);
  }
}
