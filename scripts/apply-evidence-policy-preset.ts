/**
 * Apply an evidence-policy preset (capability flags) to a project.
 *
 * Motivating case: repos with no CI pipeline and/or no unit-test harness
 * can never produce `ci_result` / `unit_test_result`, so a business-rule case
 * can never reach build-complete on the default policy. This script writes a single
 * `evidence_policies` doc whose rules are derived from the chosen preset via
 * `buildPolicyRulesFromPreset` — dropping the unproducible evidence types and
 * substituting a REQUIRED `manual_confirmation` so the gate is not silently
 * weakened (see packages/shared/src/constants/evidence-policy-presets.ts).
 *
 * It extends the EXISTING `evidence_policies` mechanism — no new storage
 * concept and no UI required. `getEffectivePolicyRule` reads the result as-is.
 *
 * Usage:
 *   # Dry run (DEFAULT — prints the rules that would be written, no writes):
 *   npx tsx scripts/apply-evidence-policy-preset.ts --project <projectId> --preset no_ci_no_unit
 *
 *   # Actually write (must pass --apply explicitly):
 *   npx tsx scripts/apply-evidence-policy-preset.ts --project <projectId> --preset no_ci_no_unit --apply
 *
 * Flags:
 *   --project <id>     (required) target project id
 *   --repository <id>  (optional) attach repository_id to the policy doc
 *   --preset <name>    one of: no_ci_no_unit | no_ci | no_unit  (default no_ci_no_unit)
 *   --apply            perform the write. Without it the script is a dry run.
 *
 * Idempotent: reuses the project's most-recently-updated policy doc if one
 * exists (matching the resolver's `updated_at desc` selection), otherwise
 * creates `ep_preset_<projectId>`.
 */

import { getFirebaseApp, getDb, collections } from '@arbitra/backend';
import {
  buildPolicyRulesFromPreset,
  EVIDENCE_POLICY_PRESETS,
  type EvidencePolicyPresetName,
} from '@arbitra/shared';

function getFlag(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

async function main() {
  const apply = process.argv.includes('--apply');
  const projectId = getFlag('project');
  const repositoryId = getFlag('repository');
  const presetName = (getFlag('preset') ?? 'no_ci_no_unit') as EvidencePolicyPresetName;

  if (!projectId) {
    console.error('Error: --project <projectId> is required.');
    process.exit(1);
  }
  if (!(presetName in EVIDENCE_POLICY_PRESETS)) {
    console.error(
      `Error: unknown preset '${presetName}'. Valid: ${Object.keys(EVIDENCE_POLICY_PRESETS).join(', ')}`,
    );
    process.exit(1);
  }

  const rules = buildPolicyRulesFromPreset(presetName);

  console.log(`Project:    ${projectId}`);
  console.log(`Repository: ${repositoryId ?? '(none)'}`);
  console.log(`Preset:     ${presetName} → ${JSON.stringify(EVIDENCE_POLICY_PRESETS[presetName])}`);
  console.log('Resulting rules (risk-first, track-second):');
  console.log(JSON.stringify(rules, null, 2));

  if (!apply) {
    // Dry run: do not even initialize Firebase, so the preview runs without
    // credentials and can never touch Firestore.
    console.log('\nDRY RUN — no writes performed. Re-run with --apply to persist.');
    return;
  }

  getFirebaseApp();
  getDb();

  // Reuse the most-recently-updated existing policy for this project (matches
  // the resolver in completeness-evaluator.ts), else create a stable doc id.
  const existing = await collections
    .evidencePolicies()
    .where('project_id', '==', projectId)
    .orderBy('updated_at', 'desc')
    .limit(1)
    .get();

  const now = new Date().toISOString();

  if (!existing.empty) {
    const docId = existing.docs[0]!.id;
    const current = existing.docs[0]!.data();
    await collections.evidencePolicies().doc(docId).set(
      {
        ...current,
        repository_id: repositoryId ?? current.repository_id,
        rules,
        version: (current.version ?? 0) + 1,
        updated_at: now,
      },
      { merge: true },
    );
    console.log(`\nUpdated existing policy ${docId} (version ${(current.version ?? 0) + 1}).`);
    return;
  }

  const policyId = `ep_preset_${projectId}`;
  await collections.evidencePolicies().doc(policyId).set({
    policy_id: policyId,
    project_id: projectId,
    repository_id: repositoryId,
    rules,
    version: 1,
    created_at: now,
    updated_at: now,
  });
  console.log(`\nCreated policy ${policyId}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
