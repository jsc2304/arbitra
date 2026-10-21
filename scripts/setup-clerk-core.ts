/**
 * Provision the private project, placeholder repository, and evidence policy
 * needed for one user's Clerk assistant tasks.
 *
 * Usage:
 *   # Dry run (default): read Firestore and print the complete plan.
 *   npx tsx scripts/setup-clerk-core.ts --user-id <firebaseUid>
 *
 *   # Apply the plan atomically.
 *   npx tsx scripts/setup-clerk-core.ts --user-id <firebaseUid> --apply
 *
 * The user is selected by Firestore document ID/Firebase UID, not email.
 * Project access checks use that immutable ID directly; email is mutable and
 * therefore unsuitable for provisioning a data-protection boundary.
 */

import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { EvidencePolicy, Project, Repository, User } from '@arbitra/shared';

/**
 * The document shape (project name/description, placeholder repo, risk-first
 * evidence policy rules) lives in `@arbitra/backend`'s
 * `clerk-core-documents.ts` and is shared with `ProvisionClerkCoreService` —
 * the self-service route counterpart to this script — so the two paths
 * cannot silently diverge on it. Imported lazily inside `loadPlan` /
 * `applyConfiguration`, same as `collections` / `getDb` below, so `--help`
 * prints without pulling in the backend's full dependency graph.
 *
 * The id derivation just below is a DIFFERENT, deliberately duplicated
 * convention (see `clerk-core.ts`'s doc comment and `clerk-core.test.ts`,
 * which pins this file's own literals) and is untouched by that shared
 * module.
 */
interface ClerkCoreDocumentBuilders {
  buildClerkProject: (ids: ClerkIds, userId: string, now: string) => Project;
  buildClerkRepository: (ids: ClerkIds, now: string) => Repository;
  buildClerkEvidencePolicy: (ids: ClerkIds, now: string) => EvidencePolicy;
}

interface CliOptions {
  apply: boolean;
  help: boolean;
  userId?: string;
}

interface ClerkIds {
  projectId: string;
  repositoryId: string;
  policyId: string;
}

type ProjectManagedFields = Pick<
  Project,
  | 'project_id'
  | 'name'
  | 'owner_user_id'
  | 'members'
  | 'reviewer_pool'
  | 'tech_leads'
  | 'default_evidence_policy_id'
  | 'default_validation_track'
>;
type RepositoryManagedFields = Pick<
  Repository,
  'repository_id' | 'project_id' | 'name' | 'url' | 'provider'
>;
type PolicyManagedFields = Pick<EvidencePolicy, 'policy_id' | 'project_id' | 'rules'>;

interface DesiredConfiguration {
  ids: ClerkIds;
  projectCreate: Project;
  projectManaged: ProjectManagedFields;
  repositoryCreate: Repository;
  repositoryManaged: RepositoryManagedFields;
  policyCreate: EvidencePolicy;
  policyManaged: PolicyManagedFields;
}

interface FieldChange {
  field: string;
  current: unknown;
  desired: unknown;
}

type PlanStatus = 'would create' | 'already correct' | 'would change';
type ApplyStatus = 'created' | 'already correct' | 'changed';

interface PlanItem {
  kind: 'Project' | 'Repository' | 'Evidence policy';
  id: string;
  status: PlanStatus;
  managedTarget: Record<string, unknown>;
  createDocument: Project | Repository | EvidencePolicy;
  changes: FieldChange[];
  policyTargetVersion?: number;
}

function printHelp(): void {
  console.log(`Usage:
  npx tsx scripts/setup-clerk-core.ts --user-id <firebaseUid> [--apply]

Options:
  --user-id <id>  Required Firestore user document ID / Firebase UID.
  --apply         Persist the plan. Without this flag, the script is read-only.
  --help, -h      Show this help without initializing Firebase.

Default mode is a dry run: it reads the target user and deterministic Clerk
documents, then reports what it would create, leave alone, or change.`);
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { apply: false, help: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--apply') {
      options.apply = true;
      continue;
    }
    if (arg === '--user-id') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('--user-id requires a Firebase UID.');
      }
      options.userId = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function clerkIds(userId: string): ClerkIds {
  const suffix = createHash('sha256')
    .update(`arbitra-clerk-core\0${userId}`)
    .digest('hex')
    .slice(0, 24);

  return {
    projectId: `proj_clerk_${suffix}`,
    repositoryId: `repo_clerk_${suffix}`,
    policyId: `ep_clerk_${suffix}`,
  };
}

function buildDesiredConfiguration(
  userId: string,
  now: string,
  builders: ClerkCoreDocumentBuilders,
): DesiredConfiguration {
  const ids = clerkIds(userId);
  const project = builders.buildClerkProject(ids, userId, now);
  const repository = builders.buildClerkRepository(ids, now);
  const policy = builders.buildClerkEvidencePolicy(ids, now);

  const projectManaged = {
    project_id: project.project_id,
    name: project.name,
    owner_user_id: project.owner_user_id,
    members: project.members,
    reviewer_pool: project.reviewer_pool,
    tech_leads: project.tech_leads,
    default_evidence_policy_id: project.default_evidence_policy_id,
    default_validation_track: project.default_validation_track,
  } satisfies Partial<Project>;
  const repositoryManaged = {
    repository_id: repository.repository_id,
    project_id: repository.project_id,
    name: repository.name,
    url: repository.url,
    provider: repository.provider,
  } satisfies Partial<Repository>;
  const policyManaged = {
    policy_id: policy.policy_id,
    project_id: policy.project_id,
    rules: policy.rules,
  } satisfies Partial<EvidencePolicy>;

  return {
    ids,
    projectManaged,
    projectCreate: project,
    repositoryManaged,
    repositoryCreate: repository,
    policyManaged,
    policyCreate: policy,
  };
}

function fieldChanges(
  current: Record<string, unknown>,
  managedTarget: Record<string, unknown>,
): FieldChange[] {
  return Object.entries(managedTarget)
    .filter(([field, desired]) => !isDeepStrictEqual(current[field], desired))
    .map(([field, desired]) => ({ field, current: current[field], desired }));
}

function assertTargetUser(userId: string, exists: boolean, user?: User): asserts user is User {
  if (!exists || !user) {
    throw new Error(`User '${userId}' does not exist in the users collection.`);
  }
  if (user.user_id && user.user_id !== userId) {
    throw new Error(
      `User document '${userId}' contains mismatched user_id '${user.user_id}'; refusing to provision.`,
    );
  }
}

function assertExistingIdentity(
  label: string,
  current: Record<string, unknown> | undefined,
  identityField: string,
  expectedId: string,
): void {
  const storedId = current?.[identityField];
  if (storedId !== undefined && storedId !== expectedId) {
    throw new Error(
      `${label} document '${expectedId}' contains mismatched ${identityField} '${String(storedId)}'; refusing to overwrite it.`,
    );
  }
}

function assertExistingScope(
  label: string,
  current: Record<string, unknown> | undefined,
  projectId: string,
): void {
  const storedProjectId = current?.['project_id'];
  if (storedProjectId !== undefined && storedProjectId !== projectId) {
    throw new Error(
      `${label} belongs to project '${String(storedProjectId)}', not '${projectId}'; refusing to re-home it.`,
    );
  }
}

function regularPlanItem(
  kind: PlanItem['kind'],
  id: string,
  exists: boolean,
  current: Record<string, unknown> | undefined,
  managedTarget: Record<string, unknown>,
  createDocument: Project | Repository | EvidencePolicy,
): PlanItem {
  const changes = exists && current ? fieldChanges(current, managedTarget) : [];
  return {
    kind,
    id,
    status: !exists ? 'would create' : changes.length === 0 ? 'already correct' : 'would change',
    managedTarget,
    createDocument,
    changes,
  };
}

function policyPlanItem(
  configuration: DesiredConfiguration,
  exists: boolean,
  current: Record<string, unknown> | undefined,
): PlanItem {
  const item = regularPlanItem(
    'Evidence policy',
    configuration.ids.policyId,
    exists,
    current,
    configuration.policyManaged,
    configuration.policyCreate,
  );

  if (!exists || !current) {
    item.policyTargetVersion = 1;
    return item;
  }

  const currentVersion = current['version'];
  const hasValidVersion =
    typeof currentVersion === 'number' && Number.isInteger(currentVersion) && currentVersion > 0;
  const contentChanged = item.changes.length > 0;
  const targetVersion = hasValidVersion
    ? Number(currentVersion) + (contentChanged ? 1 : 0)
    : 1;

  item.policyTargetVersion = targetVersion;
  if (!hasValidVersion || contentChanged) {
    item.changes.push({ field: 'version', current: currentVersion, desired: targetVersion });
    item.status = 'would change';
  }

  return item;
}

function buildPlan(
  configuration: DesiredConfiguration,
  projectExists: boolean,
  currentProject: Project | undefined,
  repositoryExists: boolean,
  currentRepository: Repository | undefined,
  policyExists: boolean,
  currentPolicy: EvidencePolicy | undefined,
): PlanItem[] {
  const projectRecord = currentProject as unknown as Record<string, unknown> | undefined;
  const repositoryRecord = currentRepository as unknown as Record<string, unknown> | undefined;
  const policyRecord = currentPolicy as unknown as Record<string, unknown> | undefined;

  assertExistingIdentity(
    'Project',
    projectRecord,
    'project_id',
    configuration.ids.projectId,
  );
  assertExistingIdentity(
    'Repository',
    repositoryRecord,
    'repository_id',
    configuration.ids.repositoryId,
  );
  assertExistingScope('Repository', repositoryRecord, configuration.ids.projectId);
  assertExistingIdentity(
    'Evidence policy',
    policyRecord,
    'policy_id',
    configuration.ids.policyId,
  );
  assertExistingScope('Evidence policy', policyRecord, configuration.ids.projectId);

  return [
    regularPlanItem(
      'Project',
      configuration.ids.projectId,
      projectExists,
      projectRecord,
      configuration.projectManaged,
      configuration.projectCreate,
    ),
    regularPlanItem(
      'Repository',
      configuration.ids.repositoryId,
      repositoryExists,
      repositoryRecord,
      configuration.repositoryManaged,
      configuration.repositoryCreate,
    ),
    policyPlanItem(configuration, policyExists, policyRecord),
  ];
}

function indentJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}

function printPlan(user: User, plan: PlanItem[], apply: boolean): void {
  console.log('Clerk core provisioning plan');
  console.log(`Mode: ${apply ? 'APPLY' : 'DRY RUN (read-only)'}`);
  console.log(`Target user: ${user.user_id} (${user.email})`);

  for (const item of plan) {
    console.log(`\n${item.kind} ${item.id}: ${item.status}`);
    console.log(item.status === 'would create' ? '  Document to create:' : '  Managed target:');
    console.log(indentJson(item.status === 'would create' ? item.createDocument : item.managedTarget));
    if (item.changes.length > 0) {
      console.log('  Changes:');
      for (const change of item.changes) {
        console.log(
          `    ${change.field}: ${JSON.stringify(change.current)} -> ${JSON.stringify(change.desired)}`,
        );
      }
    }
  }
}

async function loadPlan(userId: string, now: string) {
  const {
    collections,
    getDb,
    getFirebaseApp,
    buildClerkProject,
    buildClerkRepository,
    buildClerkEvidencePolicy,
  } = await import('@arbitra/backend');
  getFirebaseApp();
  getDb();
  const configuration = buildDesiredConfiguration(userId, now, {
    buildClerkProject,
    buildClerkRepository,
    buildClerkEvidencePolicy,
  });
  const [userDoc, projectDoc, repositoryDoc, policyDoc] = await Promise.all([
    collections.users().doc(userId).get(),
    collections.projects().doc(configuration.ids.projectId).get(),
    collections.repositories().doc(configuration.ids.repositoryId).get(),
    collections.evidencePolicies().doc(configuration.ids.policyId).get(),
  ]);
  const user = userDoc.data();
  assertTargetUser(userId, userDoc.exists, user);

  return {
    configuration,
    user,
    plan: buildPlan(
      configuration,
      projectDoc.exists,
      projectDoc.data(),
      repositoryDoc.exists,
      repositoryDoc.data(),
      policyDoc.exists,
      policyDoc.data(),
    ),
  };
}

async function applyConfiguration(userId: string): Promise<Array<{ item: PlanItem; status: ApplyStatus }>> {
  const {
    collections,
    getDb,
    buildClerkProject,
    buildClerkRepository,
    buildClerkEvidencePolicy,
  } = await import('@arbitra/backend');
  const db = getDb();

  return db.runTransaction(async (transaction) => {
    const now = new Date().toISOString();
    const configuration = buildDesiredConfiguration(userId, now, {
      buildClerkProject,
      buildClerkRepository,
      buildClerkEvidencePolicy,
    });
    const userRef = collections.users().doc(userId);
    const projectRef = collections.projects().doc(configuration.ids.projectId);
    const repositoryRef = collections.repositories().doc(configuration.ids.repositoryId);
    const policyRef = collections.evidencePolicies().doc(configuration.ids.policyId);
    const [userDoc, projectDoc, repositoryDoc, policyDoc] = await Promise.all([
      transaction.get(userRef),
      transaction.get(projectRef),
      transaction.get(repositoryRef),
      transaction.get(policyRef),
    ]);
    const user = userDoc.data();
    assertTargetUser(userId, userDoc.exists, user);

    const plan = buildPlan(
      configuration,
      projectDoc.exists,
      projectDoc.data(),
      repositoryDoc.exists,
      repositoryDoc.data(),
      policyDoc.exists,
      policyDoc.data(),
    );
    const [projectPlan, repositoryPlan, policyPlan] = plan;

    if (projectPlan!.status === 'would create') {
      transaction.create(projectRef, configuration.projectCreate);
    } else if (projectPlan!.status === 'would change') {
      transaction.set(
        projectRef,
        { ...configuration.projectManaged, updated_at: now },
        { merge: true },
      );
    }

    if (repositoryPlan!.status === 'would create') {
      transaction.create(repositoryRef, configuration.repositoryCreate);
    } else if (repositoryPlan!.status === 'would change') {
      transaction.set(
        repositoryRef,
        { ...configuration.repositoryManaged, updated_at: now },
        { merge: true },
      );
    }

    if (policyPlan!.status === 'would create') {
      transaction.create(policyRef, configuration.policyCreate);
    } else if (policyPlan!.status === 'would change') {
      transaction.set(
        policyRef,
        {
          ...configuration.policyManaged,
          version: policyPlan!.policyTargetVersion!,
          updated_at: now,
        },
        { merge: true },
      );
    }

    return plan.map((item): { item: PlanItem; status: ApplyStatus } => ({
      item,
      status:
        item.status === 'would create'
          ? 'created'
          : item.status === 'would change'
            ? 'changed'
            : 'already correct',
    }));
  });
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (!options.userId) {
    printHelp();
    throw new Error('--user-id <firebaseUid> is required.');
  }

  const { user, plan } = await loadPlan(options.userId, new Date().toISOString());
  printPlan(user, plan, options.apply);

  if (!options.apply) {
    console.log('\nDRY RUN — no writes performed. Re-run with --apply to persist this plan.');
    return;
  }

  const results = await applyConfiguration(options.userId);
  console.log('\nApply result:');
  for (const result of results) {
    console.log(`  ${result.item.kind} ${result.item.id}: ${result.status}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `Error: ${error.message}` : error);
  process.exitCode = 1;
});
