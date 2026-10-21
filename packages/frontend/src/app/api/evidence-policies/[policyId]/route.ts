import { NextRequest, NextResponse } from 'next/server';
import type { EvidencePolicyRulesMap } from '@arbitra/shared';
import {
  buildPolicyRulesFromPreset,
  mergeEvidencePolicyRules,
  updateEvidencePolicySchema,
} from '@arbitra/shared';
import { authenticate, handleError, requireProjectScopedRole, validate } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

/**
 * Mutate a policy doc. Role-gated to tech_lead / admin *of the policy's own
 * project*. The doc is loaded FIRST so the gate is checked against
 * the policy's stored `project_id`, never a client-supplied one — a
 * tech_lead of project X must not be able to point the URL at project Y's
 * policyId and mutate it. `requireProjectScopedRole` runs before body
 * validation so an unauthorized/non-member caller never triggers a Firestore
 * write regardless of what the body contains.
 */
export async function PATCH(request: NextRequest, props: { params: Promise<{ policyId: string }> }) {
  const params = await props.params;
  try {
    const auth = await authenticate(request);
    const { collections } = await import('@arbitra/backend');
    const docRef = collections.evidencePolicies().doc(params.policyId);
    const doc = await docRef.get();
    if (!doc.exists) {
      return NextResponse.json({ error: { message: 'Policy not found' } }, { status: 404 });
    }
    const current = doc.data()!;
    const denied = await requireProjectScopedRole(auth.userId, current.project_id, ['tech_lead', 'admin']);
    if (denied) return denied;
    const input = validate(updateEvidencePolicySchema, await request.json());
    // Expand a `preset`/`capabilities` declaration into a full rules map. The
    // expanded rules replace any incoming `rules` field so we never persist the
    // transient preset/capabilities keys onto the policy doc. `project_id` is
    // dropped too even if the body carries one: the gate above only ever
    // authorized this caller against the policy's CURRENT project, so
    // silently re-homing the doc to another project_id would let that grant
    // carry over to a project this caller was never checked against.
    const { preset, capabilities, project_id: _incomingProjectId, ...rest } = input;
    // Only rebuild the full map when there is a real rules source: a named
    // preset, or `capabilities` carrying at least one defined flag. An empty
    // `capabilities: {}` is a no-op — rebuilding from it would expand to full
    // defaults and silently overwrite the policy's existing custom cells.
    const hasCapabilityFlags = Boolean(capabilities) && Object.keys(capabilities!).length > 0;
    const expanded =
      preset || hasCapabilityFlags
        ? { ...rest, rules: buildPolicyRulesFromPreset(preset ?? capabilities!) }
        : rest;
    // `rules` is a nested map (risk → track → rule), but Firestore's
    // `update()` replaces a top-level field wholesale — passing only the
    // risk keys the caller mentioned would silently delete the others (see
    // mergeEvidencePolicyRules's doc-comment). Merge cell-by-cell into the
    // currently stored map instead of trusting the body as the full picture.
    // A preset/capabilities expansion already produces a full grid, so
    // merging it is a no-op difference (every cell is overwritten either way).
    const mergedRules = expanded.rules
      ? mergeEvidencePolicyRules(
          (current.rules as EvidencePolicyRulesMap | undefined) ?? {},
          expanded.rules,
        )
      : undefined;
    await docRef.update({
      ...expanded,
      ...(mergedRules ? { rules: mergedRules } : {}),
      version: (current.version ?? 0) + 1,
      updated_at: new Date().toISOString(),
    });
    const updated = await docRef.get();
    return NextResponse.json(updated.data());
  } catch (error) {
    return handleError(error);
  }
}

// auth-only by design — read is workspace-typical; mutations are role-gated.
export async function GET(request: NextRequest, props: { params: Promise<{ policyId: string }> }) {
  const params = await props.params;
  try {
    await authenticate(request);
    const { collections } = await import('@arbitra/backend');
    const doc = await collections.evidencePolicies().doc(params.policyId).get();
    if (!doc.exists) {
      return NextResponse.json({ error: { message: 'Not found' } }, { status: 404 });
    }
    return NextResponse.json(doc.data());
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Delete a policy doc, reverting every cell to system defaults via the
 * fall-through in `getEffectivePolicyRule` (`completeness-evaluator.ts`).
 * Restricted to tech_lead / admin *of the policy's own project* —
 * same load-doc-first ordering as PATCH: the gate is checked against the
 * policy's stored `project_id`, so a tech_lead of project X can't delete
 * project Y's policy by targeting its policyId. 204 on success, 404 if
 * missing or caller isn't a member of the policy's project, 403 if a member
 * but lacking the role.
 */
export async function DELETE(request: NextRequest, props: { params: Promise<{ policyId: string }> }) {
  const params = await props.params;
  try {
    const auth = await authenticate(request);
    const { collections } = await import('@arbitra/backend');
    const docRef = collections.evidencePolicies().doc(params.policyId);
    const doc = await docRef.get();
    if (!doc.exists) {
      return NextResponse.json({ error: { message: 'Policy not found' } }, { status: 404 });
    }
    const denied = await requireProjectScopedRole(auth.userId, doc.data()!.project_id, ['tech_lead', 'admin']);
    if (denied) return denied;
    await docRef.delete();
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return handleError(error);
  }
}
