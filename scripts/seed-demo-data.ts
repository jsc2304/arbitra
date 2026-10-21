/**
 * Seeds a local Firebase emulator with a small, realistic demo workspace so a
 * fresh instance looks alive (Mission Control, Board, Courtroom, Activity,
 * Observatory, Knowledge, Clerk, Intelligence).
 *
 *   npm run seed            # create / overwrite the demo data
 *   npm run seed -- --reset # first delete every collection this script writes to
 *
 * Emulator only: refuses to run unless FIRESTORE_EMULATOR_HOST and
 * FIREBASE_AUTH_EMULATOR_HOST are set. Idempotent: every document has a
 * deterministic id, so a re-run overwrites the same documents. Timestamps are
 * relative to the moment the script runs, so the data always looks recent and
 * the live agent sessions always have fresh heartbeats.
 *
 * Fictional org `acme`; sign-in accounts (Auth emulator, Google provider):
 *   Alex Example  alex@example.com   admin (matches ARBITRA_ADMIN_EMAILS)
 *   Sam Example   sam@example.com    reviewer
 *   Robin Example robin@example.com  tech lead
 *
 * Every document is typed with the shared types (check with a `tsc --noEmit`
 * over this file), and the data is built through the real lifecycle matrix,
 * evidence-policy presets and result parser, so schema drift fails loudly
 * instead of seeding data the app cannot read.
 *
 * Default project / repository / evidence policy / starter rule set from the
 * starter evidence policy and rules live here (STARTER_RULES,
 * STARTER_RULE_SET, buildPolicyRulesFromPreset).
 */

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { getAuth } from 'firebase-admin/auth';

import type {
  ActorMetadata,
  AgentPresence,
  Artifact,
  AssistantIntakeReceipt,
  Case,
  CaseEvent,
  CaseStatus,
  CaseType,
  Comment,
  CommentKind,
  Decision,
  DecisionType,
  DetectorRunSummary,
  Evidence,
  EvidencePolicy,
  EvidencePolicyPresetName,
  EvidenceSourceType,
  EvidenceType,
  Finding,
  FindingCategory,
  FindingOriginType,
  FindingSeverity,
  FindingStatus,
  FindingVerificationStatus,
  GateId,
  IntelligenceFlag,
  IntelligenceRun,
  KnowledgeAsset,
  LifecycleProfile,
  Notification,
  ObservedCaseClaim,
  Priority,
  Project,
  Repository,
  RiskLevel,
  Rule,
  RuleResult,
  RuleResultStatus,
  RuleSet,
  Run,
  RunStatus,
  RunType,
  SessionRegistryEntry,
  SourceType,
  TaskBlueprint,
  User,
  UserRole,
  ValidationTrack,
  WorkspaceEvent,
} from '@arbitra/shared';

// ---------------------------------------------------------------------------
// Workspace packages
//
// @arbitra/backend and @arbitra/shared are ESM-only (their "exports" map has
// only an "import" condition), while the root package, and so this .ts file
// under tsx, is CommonJS: static imports would compile to require() and fail
// with ERR_PACKAGE_PATH_NOT_EXPORTED. They are therefore loaded with dynamic
// import() in loadWorkspacePackages(), after the emulator check and before
// anything else runs. Only `import type` (erased) appears at the top.
// ---------------------------------------------------------------------------

type Backend = typeof import('@arbitra/backend');
type Shared = typeof import('@arbitra/shared');

let LocalStorageAdapter!: Backend['LocalStorageAdapter'];
let assistantIntakeReceiptId!: Backend['assistantIntakeReceiptId'];
let buildBlueprintOccurrenceIdempotencyKey!: Backend['buildBlueprintOccurrenceIdempotencyKey'];
let buildClerkEvidencePolicy!: Backend['buildClerkEvidencePolicy'];
let buildClerkProject!: Backend['buildClerkProject'];
let buildClerkRepository!: Backend['buildClerkRepository'];
let buildSignature!: Backend['buildSignature'];
let clerkCoreIds!: Backend['clerkCoreIds'];
let collections!: Backend['collections'];
let decideAssistantPolicy!: Backend['decideAssistantPolicy'];
let deriveAssistantTaskTitle!: Backend['deriveAssistantTaskTitle'];
let getArtifactStorage!: Backend['getArtifactStorage'];
let getDb!: Backend['getDb'];
let getFirebaseApp!: Backend['getFirebaseApp'];
let observedCaseClaimDocId!: Backend['observedCaseClaimDocId'];

let STARTER_RULES!: Shared['STARTER_RULES'];
let STARTER_RULE_SET!: Shared['STARTER_RULE_SET'];
let GATE_TRANSITION_MAP!: Shared['GATE_TRANSITION_MAP'];
let buildPolicyRulesFromPreset!: Shared['buildPolicyRulesFromPreset'];
let findGateId!: Shared['findGateId'];
let findTransition!: Shared['findTransition'];
let parseAssistantTaskResult!: Shared['parseAssistantTaskResult'];
let resolveGateBehavior!: Shared['resolveGateBehavior'];

async function loadWorkspacePackages(): Promise<void> {
  ({
    LocalStorageAdapter, assistantIntakeReceiptId, buildBlueprintOccurrenceIdempotencyKey,
    buildClerkEvidencePolicy, buildClerkProject, buildClerkRepository, buildSignature, clerkCoreIds,
    collections, decideAssistantPolicy, deriveAssistantTaskTitle, getArtifactStorage, getDb,
    getFirebaseApp, observedCaseClaimDocId,
  } = await import('@arbitra/backend'));
  ({
    STARTER_RULES, STARTER_RULE_SET, GATE_TRANSITION_MAP, buildPolicyRulesFromPreset, findGateId,
    findTransition, parseAssistantTaskResult, resolveGateBehavior,
  } = await import('@arbitra/shared'));
}

// ---------------------------------------------------------------------------
// Safety: emulator only
// ---------------------------------------------------------------------------

function requireEmulators(): void {
  const required = ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST'];
  // Clerk answers go to GCS_BUCKET when it is set; only allow that through the storage emulator.
  if (process.env['GCS_BUCKET']) required.push('FIREBASE_STORAGE_EMULATOR_HOST');
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length === 0) return;
  console.error(
    `Refusing to seed: ${missing.join(' and ')} not set.\n` +
      'This script writes demo data and must only ever run against the Firebase emulators.\n' +
      'Start them with `npm run emulators`, copy .env.example to packages/frontend/.env.local\n' +
      '(it sets both variables) and run `npm run seed`.',
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Time + id helpers
// ---------------------------------------------------------------------------

const NOW = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** An "ago" offset in ms: `t(8, 3)` is 8 days 3 hours before the run. */
const t = (days = 0, hours = 0, minutes = 0): number => days * DAY + hours * HOUR + minutes * MIN;
const iso = (agoMs: number): string => new Date(NOW - agoMs).toISOString();
const pad = (n: number): string => String(n).padStart(2, '0');
const sha1 = (seed: string): string => createHash('sha1').update(seed).digest('hex');

// ---------------------------------------------------------------------------
// People, agents, constants
// ---------------------------------------------------------------------------

// Shaped like real Firebase Auth uids (20+ alphanumerics): the UI resolves names
// only for ids of that shape, so `usr_alex`-style ids would render raw.
const ALEX = 'demoAlexExampleUid0001';
const SAM = 'demoSamExampleUid00002';
const ROBIN = 'demoRobinExampleUid003';
const PIPELINE = 'system:pipeline';

const PEOPLE: { id: string; name: string; email: string; roles: UserRole[] }[] = [
  { id: ALEX, name: 'Alex Example', email: 'alex@example.com', roles: ['developer', 'admin'] },
  { id: SAM, name: 'Sam Example', email: 'sam@example.com', roles: ['developer', 'reviewer'] },
  { id: ROBIN, name: 'Robin Example', email: 'robin@example.com', roles: ['developer', 'tech_lead'] },
];

const CLAUDE_CODE = { client_name: 'claude-code', client_version: '2.1.4', model: 'claude-sonnet-5' } satisfies ActorMetadata;
const CURSOR = { client_name: 'cursor', client_version: '2.0.38', model: 'claude-sonnet-5' } satisfies ActorMetadata;
const CODEX = { client_name: 'codex', client_version: '0.46.0', model: 'gpt-5-codex' } satisfies ActorMetadata;

const REVIEW_MODEL = 'claude-sonnet-5';
const GITHUB = 'https://github.com';

// ---------------------------------------------------------------------------
// Collected documents (written in one pass at the end)
// ---------------------------------------------------------------------------

const out = {
  users: [] as User[],
  projects: [] as Project[],
  repositories: [] as Repository[],
  evidencePolicies: [] as EvidencePolicy[],
  rules: [] as Rule[],
  ruleSets: [] as RuleSet[],
  cases: [] as Case[],
  caseEvents: [] as CaseEvent[],
  runs: [] as Run[],
  findings: [] as Finding[],
  evidence: [] as Evidence[],
  decisions: [] as Decision[],
  comments: [] as Comment[],
  ruleResults: [] as RuleResult[],
  knowledgeAssets: [] as KnowledgeAsset[],
  notifications: [] as Notification[],
  workspaceEvents: [] as WorkspaceEvent[],
  intelligenceRuns: [] as IntelligenceRun[],
  agentPresence: [] as AgentPresence[],
  sessions: [] as SessionRegistryEntry[],
  observedCaseClaims: [] as { doc: ObservedCaseClaim }[],
  artifacts: [] as Artifact[],
  taskBlueprints: [] as TaskBlueprint[],
  assistantIntakeReceipts: [] as AssistantIntakeReceipt[],
};

// ---------------------------------------------------------------------------
// Projects, repositories, policies, rules
// ---------------------------------------------------------------------------

interface ProjectSeed {
  id: string;
  name: string;
  description: string;
  owner: string;
  members: string[];
  reviewers: string[];
  techLeads: string[];
  profile: LifecycleProfile;
  ruleSets: string[];
  policyId: string;
  /** Evidence-policy preset; built lazily because the shared package is loaded at runtime. */
  policyPreset: EvidencePolicyPresetName | 'default';
  repo: { id: string; name: string; slug: string; githubId?: number };
}

const PAYMENTS: ProjectSeed = {
  id: 'proj_payments',
  name: 'Payments API',
  description: 'Card and bank payments, refunds, payouts and webhook delivery.',
  owner: ROBIN,
  members: [ALEX, SAM, ROBIN],
  reviewers: [SAM, ROBIN],
  techLeads: [ROBIN],
  // Merging payment code needs a human to confirm the gate.
  profile: { preset: 'standard', overrides: { approved_to_pending_merge: 'confirm' } },
  ruleSets: ['rs_starter', 'rs_payments_pci'],
  policyId: 'ep_payments',
  policyPreset: 'default',
  repo: { id: 'repo_payments_api', name: 'payments-api', slug: 'acme/payments-api', githubId: 810203041 },
};

const STOREFRONT: ProjectSeed = {
  id: 'proj_storefront',
  name: 'Web Storefront',
  description: 'Customer-facing shop: catalog, cart and checkout.',
  owner: ROBIN,
  members: [ALEX, SAM, ROBIN],
  reviewers: [SAM, ROBIN],
  techLeads: [ROBIN],
  profile: { preset: 'standard' },
  ruleSets: ['rs_starter'],
  policyId: 'ep_storefront',
  policyPreset: 'default',
  repo: { id: 'repo_storefront', name: 'storefront', slug: 'acme/storefront', githubId: 810203077 },
};

const MOBILE: ProjectSeed = {
  id: 'proj_mobile',
  name: 'Mobile App',
  description: 'iOS and Android client for shoppers.',
  owner: ALEX,
  members: [ALEX, ROBIN],
  reviewers: [ROBIN],
  techLeads: [ROBIN],
  profile: { preset: 'autonomous' },
  ruleSets: ['rs_starter'],
  policyId: 'ep_mobile',
  // The mobile repo has CI but no unit-test harness yet.
  policyPreset: 'no_unit',
  // No signed GitHub webhook has arrived yet: the Intelligence page nudges about it.
  repo: { id: 'repo_mobile_app', name: 'mobile-app', slug: 'acme/mobile-app' },
};

const PROJECTS = [PAYMENTS, STOREFRONT, MOBILE];
const policyRulesOf = (p: ProjectSeed): EvidencePolicy['rules'] =>
  buildPolicyRulesFromPreset(p.policyPreset === 'default' ? {} : p.policyPreset);

function seedWorkspace(): void {
  for (const p of PEOPLE) {
    out.users.push({
      user_id: p.id,
      email: p.email,
      display_name: p.name,
      roles: [...p.roles],
      created_at: iso(t(30)),
      updated_at: iso(t(0, 1)),
    } satisfies User);
  }

  for (const p of PROJECTS) {
    out.projects.push({
      project_id: p.id,
      name: p.name,
      description: p.description,
      owner_user_id: p.owner,
      members: p.members,
      reviewer_pool: p.reviewers,
      tech_leads: p.techLeads,
      default_evidence_policy_id: p.policyId,
      default_rule_set_refs: p.ruleSets,
      lifecycle_profile: p.profile,
      default_validation_track: 'direct',
      default_language: 'en',
      created_at: iso(t(30)),
      updated_at: iso(t(12)),
    } satisfies Project);

    out.repositories.push({
      repository_id: p.repo.id,
      project_id: p.id,
      name: p.repo.name,
      url: `${GITHUB}/${p.repo.slug}`,
      provider: 'github',
      github_full_name: p.repo.slug,
      default_branch: 'main',
      ...(p.repo.githubId !== undefined && {
        github_repository_id: p.repo.githubId,
        pull_request_event_seen_at: iso(t(0, 5)),
      }),
      created_at: iso(t(30)),
      updated_at: iso(t(12)),
    } satisfies Repository);

    out.evidencePolicies.push({
      policy_id: p.policyId,
      project_id: p.id,
      rules: policyRulesOf(p),
      version: 1,
      created_at: iso(t(30)),
      updated_at: iso(t(30)),
    } satisfies EvidencePolicy);
  }

  // Global starter rules + a project-scoped PCI rule for Payments.
  for (const rule of STARTER_RULES) {
    out.rules.push({ ...rule, created_at: iso(t(30)), updated_at: iso(t(30)), updated_by: ALEX } satisfies Rule);
  }
  out.rules.push({
    rule_id: 'rule_payments_no_pan_logging',
    name: 'No card data in log statements',
    category: 'security_rule',
    scope: { layer: 'project', ref: PAYMENTS.id },
    evaluation_mode: 'diff_pattern',
    severity_if_failed: 'high',
    config: { pattern: '\\+.*log.*(card_number|pan|cvv)' },
    description: 'Flags log statements that include card numbers, PANs or CVV values.',
    rationale: 'Card data in logs widens PCI scope and leaks into third-party log tooling.',
    status: 'active',
    version: 1,
    created_at: iso(t(28)),
    updated_at: iso(t(28)),
    updated_by: ROBIN,
  } satisfies Rule);

  out.ruleSets.push({
    ...STARTER_RULE_SET,
    created_at: iso(t(30)),
    updated_at: iso(t(30)),
    updated_by: ALEX,
  } satisfies RuleSet);
  out.ruleSets.push({
    rule_set_id: 'rs_payments_pci',
    name: 'Payments PCI rules',
    description: 'Project rules that keep cardholder data out of logs and fixtures.',
    project_id: PAYMENTS.id,
    rule_refs: ['rule_payments_no_pan_logging'],
    status: 'active',
    version: 1,
    created_at: iso(t(28)),
    updated_at: iso(t(28)),
    updated_by: ROBIN,
  } satisfies RuleSet);
}

// ---------------------------------------------------------------------------
// Case builder: one object per case that records its whole story (lifecycle
// events, runs, evidence, findings, decisions, comments) in chronological calls.
// ---------------------------------------------------------------------------

interface CaseInit {
  key: string;
  id: string;
  /** Jira-style reference, e.g. PAY-142. */
  ref?: string;
  title: string;
  description: string;
  project: ProjectSeed;
  owner: string;
  reviewer?: string;
  type: CaseType;
  risk: RiskLevel;
  priority: Priority;
  track?: ValidationTrack;
  branch?: string;
  pr?: number;
  /** Ago-offset of case creation. */
  created: number;
  /** IDE agent that drives the owner's work on this case, if any. */
  agent?: ActorMetadata;
  knowledge?: string[];
  source?: SourceType;
}

interface AdvanceOptions {
  agent?: ActorMetadata;
  payload?: Record<string, unknown>;
  /** How long a confirm gate waited before someone confirmed it. */
  gateWait?: number;
  confirmer?: string;
  rationale?: string;
}

interface FindingInit {
  ago: number;
  cat: FindingCategory;
  sev: FindingSeverity;
  title: string;
  desc: string;
  conf?: number;
  status?: FindingStatus;
  resolution?: string;
  origin?: FindingOriginType;
  verified?: FindingVerificationStatus;
  note?: string;
  contested?: boolean;
  rule?: string;
  source?: string;
  knowledge?: string;
}

interface EvidenceOptions {
  source?: EvidenceSourceType;
  ref?: string;
  by?: string;
  agent?: ActorMetadata;
  run?: Run;
}

const MACHINE_READABLE_EVIDENCE = new Set<string>([
  'ci_result',
  'unit_test_result',
  'integration_test_result',
  'lint_result',
  'benchmark_result',
  'diff_snapshot',
  'pr_merged',
]);

const RULE_PASS_MESSAGES: Record<string, string> = {
  rule_evidence_required: 'A CI result is attached.',
  rule_description_present: 'The case has a description.',
  rule_no_console_log: 'No console.log statements added.',
  rule_no_todo_fixme: 'No TODO or FIXME comments added.',
  rule_risk_level_set: 'Risk level is set explicitly.',
  rule_no_secrets_in_diff: 'No secrets or keys found in the diff.',
  rule_payments_no_pan_logging: 'No card data in added log statements.',
};

class CaseCtx {
  readonly c: Case;
  readonly head: string | undefined;
  private readonly n = { evt: 0, run: 0, fnd: 0, ev: 0, dec: 0, cmt: 0 };
  private newest = Number.POSITIVE_INFINITY;
  private approved = false;
  private readonly evidenceTypes = new Set<string>();

  constructor(private readonly i: CaseInit) {
    const { project } = i;
    this.head = i.pr !== undefined ? sha1(i.key) : undefined;
    const ruleSetRefs = project.ruleSets;
    this.c = {
      case_id: i.id,
      title: i.title,
      description: i.description,
      source_type: i.source ?? (i.ref ? 'jira' : 'manual'),
      source_ref: i.ref ?? '',
      project_id: project.id,
      repository_id: project.repo.id,
      owner_user_id: i.owner,
      ...(i.reviewer !== undefined && { assigned_reviewer_id: i.reviewer }),
      status: 'open',
      validation_track: i.track ?? 'direct',
      risk_level: i.risk,
      priority: i.priority,
      case_type: i.type,
      ...(i.branch !== undefined && { current_branch: i.branch }),
      ...(i.pr !== undefined && { current_pr_ref: `${GITHUB}/${project.repo.slug}/pull/${i.pr}` }),
      ...(this.head !== undefined && { current_head_sha: this.head }),
      jira_refs: i.ref ? [i.ref] : [],
      active_rule_set_refs: ruleSetRefs,
      knowledge_context_refs: i.knowledge ?? [],
      decision_ready: false,
      created_at: iso(i.created),
      updated_at: iso(i.created),
      deleted_at: null,
      deleted_by: null,
    } satisfies Case;
    out.cases.push(this.c);
    this.event(
      'case_created',
      i.created,
      i.owner,
      {
        title: i.title,
        project_id: project.id,
        validation_track: this.c.validation_track,
        risk_level: i.risk,
      },
      i.agent,
    );
  }

  private at(ago: number): string {
    this.newest = Math.min(this.newest, ago);
    return iso(ago);
  }

  event(
    type: string,
    ago: number,
    actor: string,
    payload: Record<string, unknown> = {},
    agent?: ActorMetadata,
  ): CaseEvent {
    const e: CaseEvent = {
      event_id: `evt_${this.i.key}_${pad(++this.n.evt)}`,
      case_id: this.i.id,
      type,
      actor_id: actor,
      payload: agent ? { ...payload, actor_metadata: agent } : payload,
      created_at: this.at(ago),
    };
    out.caseEvents.push(e);
    return e;
  }

  /** Move the case along the real transition matrix, emitting that edge's events. */
  advance(to: CaseStatus, ago: number, actor: string = this.i.owner, o: AdvanceOptions = {}): this {
    const from = this.c.status;
    const def = findTransition(from, to, this.c.case_type);
    if (!def) throw new Error(`${this.i.key}: no transition ${from} -> ${to} for ${this.c.case_type}`);
    const base = { from_status: from, to_status: to };
    const gateId = findGateId(from, to);
    const gated =
      def.auto_trigger === true &&
      gateId !== null &&
      resolveGateBehavior(gateId, this.i.project.profile) === 'confirm';

    if (gated && gateId) {
      const confirmer =
        o.confirmer ?? this.i.project.reviewers.find((id) => id !== this.i.owner) ?? this.i.project.owner;
      this.event('gate_pending', ago + (o.gateWait ?? t(0, 1, 30)), PIPELINE, {
        gate_id: gateId,
        ...base,
        preconditions_satisfied: true,
        awaiting: 'human_confirmation',
      });
      this.decision('gate_confirmed', ago + 2000, confirmer, o.rationale ?? 'Checks are green. Confirming the gate.');
      for (const type of def.events) {
        this.event(type, ago, PIPELINE, { ...base, triggered_by: 'gate_confirmation', gate_id: gateId });
      }
      this.event('gate_confirmed', ago, PIPELINE, { gate_id: gateId, ...base });
    } else {
      for (const type of def.events) this.event(type, ago, actor, { ...base, ...o.payload }, o.agent);
    }

    this.c.status = to;
    this.c.pending_gate = undefined;
    if (to === 'approved') {
      this.approved = true;
      if (this.head) this.c.approved_head_sha = this.head;
    }
    return this;
  }

  /**
   * open -> exploration, the exploration run, the agent's summary comment and the
   * automatic exploration -> ready_for_build, in the order the pipeline emits them.
   */
  explore(at: number, runSummary: string, comment: string, agent?: ActorMetadata, actor: string = this.i.owner): this {
    this.advance('exploration', at, actor, { agent });
    this.run('exploration_run', at - 2 * MIN, 6, { trigger: actor, summary: runSummary });
    this.comment(actor, at - 9 * MIN, comment, { agent, kind: 'exploration_summary' });
    return this.advance('ready_for_build', at - 11 * MIN, PIPELINE);
  }

  /** Park the case on a confirm gate nobody has confirmed yet. */
  pendingGate(gateId: GateId, ago: number): this {
    const { from, to } = GATE_TRANSITION_MAP[gateId];
    this.event('gate_pending', ago, PIPELINE, {
      gate_id: gateId,
      from_status: from,
      to_status: to,
      preconditions_satisfied: true,
      awaiting: 'human_confirmation',
    });
    this.c.pending_gate = { gate_id: gateId, target_status: to, since: iso(ago) };
    return this;
  }

  run(
    type: RunType,
    startedAgo: number,
    durMin: number,
    o: {
      status?: RunStatus;
      summary?: string;
      trigger?: string;
      diffLines?: number;
      tokens?: [number, number];
      model?: string;
    } = {},
  ): Run {
    const status = o.status ?? 'completed';
    const running = status === 'running';
    const finishedAgo = startedAgo - durMin * MIN;
    const trigger = o.trigger ?? PIPELINE;
    const tokens = o.tokens;
    const r: Run = {
      run_id: `run_${this.i.key}_${pad(++this.n.run)}`,
      case_id: this.i.id,
      run_type: type,
      trigger_source: trigger,
      status,
      started_at: this.at(startedAgo),
      input_refs: [],
      output_refs: [],
      attempt: 1,
      created_at: iso(startedAgo + 2000),
      updated_at: running ? iso(startedAgo) : this.at(finishedAgo),
      ...(running
        ? { lease_expires_at: iso(-t(0, 0, 8)), worker_id: 'worker-demo-1' }
        : { finished_at: iso(finishedAgo) }),
      ...(o.summary !== undefined && { summary: o.summary }),
      ...(tokens && {
        token_usage: {
          prompt_tokens: tokens[0],
          completion_tokens: tokens[1],
          total_tokens: tokens[0] + tokens[1],
          model: o.model ?? REVIEW_MODEL,
        },
      }),
      ...(type === 'review_run' && {
        prompt_version: 'review_system:v3',
        ...(this.head !== undefined && { reviewed_head_sha: this.head }),
        ...(o.diffLines !== undefined && { diff_line_count: o.diffLines }),
      }),
    };
    out.runs.push(r);
    this.event('run_created', startedAgo + 2000, trigger, { run_id: r.run_id, run_type: type });
    this.event('run_started', startedAgo, trigger, { run_id: r.run_id, run_type: type });
    if (!running) {
      this.event(status === 'failed' ? 'run_failed' : 'run_completed', finishedAgo, trigger, {
        run_id: r.run_id,
        run_type: type,
        status,
        attempt: 1,
      });
    }
    return r;
  }

  /** A rule_run plus one RuleResult per active rule (all pass unless overridden). */
  rules(
    startedAgo: number,
    overrides: Record<string, { status: RuleResultStatus; message: string; finding?: Finding }> = {},
  ): Run {
    const run = this.run('rule_run', startedAgo, 1, { summary: 'Evaluated active rules against the case and diff.' });
    const ruleIds = [
      ...(this.c.active_rule_set_refs.includes('rs_starter') ? STARTER_RULES.map((r) => r.rule_id) : []),
      ...(this.c.active_rule_set_refs.includes('rs_payments_pci') ? ['rule_payments_no_pan_logging'] : []),
    ];
    for (const ruleId of ruleIds) {
      const o = overrides[ruleId];
      out.ruleResults.push({
        rule_result_id: `rr_${run.run_id.replace(/^run_/, '')}_${ruleId.replace(/^rule_/, '')}`,
        rule_id: ruleId,
        case_id: this.i.id,
        run_id: run.run_id,
        result_status: o?.status ?? 'pass',
        message: o?.message ?? RULE_PASS_MESSAGES[ruleId] ?? 'Rule passed.',
        evidence_refs: [],
        ...(o?.finding && { finding_ref: o.finding.finding_id }),
        evaluated_at: iso(startedAgo - MIN),
      } satisfies RuleResult);
    }
    this.event('rule_results_attached', startedAgo - MIN, PIPELINE, {
      run_id: run.run_id,
      rule_count: ruleIds.length,
      conflicts: 0,
    });
    return run;
  }

  /** An AI review run with its findings. */
  review(startedAgo: number, diffLines: number, summary: string, findings: FindingInit[]): { run: Run; findings: Finding[] } {
    const run = this.run('review_run', startedAgo, 3, {
      diffLines,
      summary,
      tokens: [Math.round(diffLines * 38 + 4200), 900 + findings.length * 240],
    });
    const created = findings.map((f) => this.finding(f));
    this.event('review_completed', startedAgo - 3 * MIN, PIPELINE, {
      run_id: run.run_id,
      adapter_count: 1,
      finding_count: findings.length,
      model: REVIEW_MODEL,
      total_tokens: run.token_usage?.total_tokens,
      duration_ms: 3 * MIN,
      diff_line_count: diffLines,
    });
    return { run, findings: created };
  }

  finding(f: FindingInit): Finding {
    const status = f.status ?? 'open';
    const id = `fnd_${this.i.key}_${pad(++this.n.fnd)}`;
    const verified = f.verified ?? (f.origin === 'human' || f.origin === 'rule_engine' ? undefined : 'confirmed');
    const created = this.at(f.ago);
    const finding: Finding = {
      finding_id: id,
      case_id: this.i.id,
      category: f.cat,
      severity: f.sev,
      confidence: f.conf ?? 0.82,
      status,
      title: f.title,
      description: f.desc,
      origin_type: f.origin ?? 'reviewer',
      source_refs: [f.source ?? (f.origin === 'rule_engine' ? 'rule-engine' : 'llm-anthropic')],
      evidence_refs: [],
      rule_refs: f.rule ? [f.rule] : [],
      ...(f.resolution !== undefined && { resolution: f.resolution }),
      ...(f.contested && { severity_contested: true }),
      ...(f.knowledge !== undefined && { knowledge_asset_ref: f.knowledge }),
      ...((f.origin ?? 'reviewer') === 'reviewer' && { origin: 'authored' as const }),
      ...(verified !== undefined && {
        verification_status: verified,
        verification_note: f.note ?? 'Confirmed against the diff and the registered evidence.',
        verified_at: created,
        verifier_model: REVIEW_MODEL,
      }),
      created_at: created,
      updated_at: created,
    };
    out.findings.push(finding);
    this.event('finding_created', f.ago, PIPELINE, {
      finding_id: id,
      severity: f.sev,
      category: f.cat,
      title: f.title,
    });
    return finding;
  }

  setFinding(f: Finding, status: FindingStatus, ago: number, resolution?: string): void {
    const from = f.status;
    f.status = status;
    if (resolution !== undefined) f.resolution = resolution;
    f.updated_at = this.at(ago);
    this.event('finding_updated', ago, PIPELINE, { finding_id: f.finding_id, from, to: status });
  }

  evidence(type: EvidenceType, ago: number, summary: string, o: EvidenceOptions = {}): Evidence {
    const source = o.source ?? (MACHINE_READABLE_EVIDENCE.has(type) ? 'webhook' : 'manual');
    const by = o.by ?? (source === 'webhook' ? 'system' : this.i.owner);
    const ev: Evidence = {
      evidence_id: `ev_${this.i.key}_${pad(++this.n.ev)}`,
      case_id: this.i.id,
      ...(o.run && { run_id: o.run.run_id }),
      type,
      source_type: source,
      ...(o.ref !== undefined && { artifact_ref: o.ref }),
      summary,
      machine_readable: MACHINE_READABLE_EVIDENCE.has(type),
      validation_track: this.c.validation_track,
      created_at: this.at(ago),
      created_by: by,
      ...(o.agent && { actor_metadata: o.agent }),
    };
    out.evidence.push(ev);
    this.evidenceTypes.add(type);
    this.event('evidence_registered', ago, by, { evidence_id: ev.evidence_id, type }, o.agent);
    return ev;
  }

  /** CI run + unit tests (as the CI webhook would register them). */
  ci(ago: number, runNo: number, tests?: string): Evidence[] {
    const url = `${GITHUB}/${this.i.project.repo.slug}/actions/runs/${runNo}`;
    const rows = [this.evidence('ci_result', ago, `CI passed on ${this.i.branch ?? 'the branch'} (build ${runNo}).`, { ref: url })];
    if (tests) rows.push(this.evidence('unit_test_result', ago - MIN, tests, { ref: `${url}#tests` }));
    return rows;
  }

  decision(
    type: DecisionType,
    ago: number,
    actor: string,
    rationale: string,
    o: { finding?: Finding; agent?: ActorMetadata } = {},
  ): Decision {
    const d: Decision = {
      decision_id: `dec_${this.i.key}_${pad(++this.n.dec)}`,
      case_id: this.i.id,
      ...(o.finding && { finding_id: o.finding.finding_id }),
      type,
      actor_id: actor,
      rationale,
      snapshot: {
        active_rule_set_versions: Object.fromEntries(this.c.active_rule_set_refs.map((id) => [id, 1])),
        evidence_policy_id: this.i.project.policyId,
        evidence_policy_version: 1,
        knowledge_asset_refs: this.c.knowledge_context_refs,
        snapshot_fidelity: 'exact',
      },
      created_at: this.at(ago),
      ...(o.agent && { actor_metadata: o.agent }),
    };
    out.decisions.push(d);
    this.event(
      'decision_created',
      ago,
      actor,
      { decision_id: d.decision_id, type, ...(o.finding && { finding_id: o.finding.finding_id }) },
      o.agent,
    );
    return d;
  }

  autoApprove(ago: number, detail: string): Decision {
    return this.decision('auto_approve', ago, PIPELINE, `All auto-approve criteria met: ${detail}`);
  }

  comment(
    author: string,
    ago: number,
    body: string,
    o: { agent?: ActorMetadata; kind?: CommentKind; finding?: Finding } = {},
  ): Comment {
    const cm: Comment = {
      comment_id: `cmt_${this.i.key}_${pad(++this.n.cmt)}`,
      parent_type: o.finding ? 'finding' : 'case',
      parent_id: o.finding ? o.finding.finding_id : this.i.id,
      author_id: author,
      body,
      created_at: this.at(ago),
      source: o.agent ? 'ide_agent' : 'human',
      ...(o.agent && { agent_name: o.agent.client_name, actor_metadata: o.agent }),
      ...(o.kind && { kind: o.kind }),
    };
    out.comments.push(cm);
    this.event(
      'comment_added',
      ago,
      author,
      { comment_id: cm.comment_id, parent_type: cm.parent_type, ...(o.kind && { kind: o.kind }) },
      o.agent,
    );
    return cm;
  }

  flag(flag: IntelligenceFlag): void {
    this.c.intelligence_flags = [...(this.c.intelligence_flags ?? []), flag];
    // IntelligenceService.flagCase bumps updated_at to the flag time.
    this.newest = Math.min(this.newest, NOW - Date.parse(flag.flagged_at));
  }

  /** Seal the case: `updated_at` = newest activity, `decision_ready` = evidence complete per the project policy. */
  done(): Case {
    this.c.updated_at = iso(Number.isFinite(this.newest) ? this.newest : this.i.created);
    const cell = policyRulesOf(this.i.project)[this.c.risk_level]?.[this.c.validation_track];
    this.c.decision_ready = (cell?.required_evidence_types ?? []).every((type) => this.evidenceTypes.has(type));
    if (!this.approved) this.c.approved_head_sha = undefined;
    return this.c;
  }
}

// ---------------------------------------------------------------------------
// Knowledge asset ids (cases reference them; the assets are built after the cases)
// ---------------------------------------------------------------------------

const K_IDEMP = 'ka_pay_idempotency_scope';
const K_NOPAN = 'ka_pay_no_pan_logs';
const K_EGRESS = 'ka_pay_webhook_egress';
const K_LEGACY = 'ka_pay_legacy_intent_client';
const K_TOTALS = 'ka_web_server_side_totals';
const K_SANITIZE = 'ka_web_sanitize_html';
const K_TESTCARDS = 'ka_web_test_card_numbers';
const K_BIOMETRIC = 'ka_mob_biometric_reauth';
const K_FLAKY_V2 = 'ka_org_flaky_quarantine_v2';
const K_FLAKY_V3 = 'ka_org_flaky_quarantine_v3';

// ---------------------------------------------------------------------------
// The cases
// ---------------------------------------------------------------------------

interface Story {
  pay118: CaseCtx;
  pay131: CaseCtx;
  pay142: CaseCtx;
  pay150: CaseCtx;
  pay153: CaseCtx;
  pay158: CaseCtx;
  pay160: CaseCtx;
  web190: CaseCtx;
  web198: CaseCtx;
  web204: CaseCtx;
  web211: CaseCtx;
  web215: CaseCtx;
  mob72: CaseCtx;
  mob77: CaseCtx;
  obs1: CaseCtx;
  obs2: CaseCtx;
  pay131RequestChanges: Decision;
  web190Reject: Decision;
  pay142Waiver: Decision;
}

function seedCases(): Story {
  // --- PAY-118 · done · bugfix ------------------------------------------------
  const pay118 = new CaseCtx({
    key: 'pay118', id: 'case-quick-ledger-k3Dn', ref: 'PAY-118',
    title: 'Reject charges with unsupported currency codes',
    description: 'Charges with a currency the processor does not support surface as opaque 502 errors. Validate the currency at the API boundary and return a clear 422.',
    project: PAYMENTS, owner: SAM, type: 'bugfix', risk: 'medium', priority: 'normal',
    branch: 'fix/charge-currency-validation', pr: 402, created: t(13, 2), agent: CURSOR, knowledge: [K_LEGACY],
  });
  pay118.explore(t(13, 1, 45), 'Explored the charge request path and the processor error mapping.', [
    '**Root cause.** `ChargeRequest.currency` is passed to the processor unchecked, so unsupported codes come back as a generic 502.',
    '',
    '**Plan.** Validate against the ISO 4217 allow-list in the request schema and return `422 unsupported_currency`. Add a table-driven test.',
  ].join('\n'), CURSOR, SAM);
  pay118.advance('in_build', t(13, 0, 50), SAM, { agent: CURSOR });
  pay118.run('build_run', t(12, 22), 41, { trigger: SAM, summary: 'Implemented currency validation and tests.' });
  pay118.ci(t(12, 21), 9310442, 'Vitest: 214 passed, 0 failed.');
  pay118.comment(SAM, t(12, 20, 40), 'Added `SUPPORTED_CURRENCIES`, a 422 error body and 14 table-driven test cases. No behavior change for supported codes.', { agent: CURSOR, kind: 'build_summary' });
  pay118.advance('in_validation', t(12, 20), PIPELINE);
  pay118.rules(t(12, 19, 55));
  pay118.advance('in_review', t(12, 19, 40), PIPELINE);
  const r118 = pay118.review(t(12, 19, 35), 96, 'Review found two minor issues.', [
    { ago: t(12, 19, 32), cat: 'maintainability_issue', sev: 'low', title: 'Currency list duplicated in two modules', desc: 'The new allow-list repeats the codes already defined in `src/money/currencies.ts`. Import the existing constant instead.', conf: 0.74 },
    { ago: t(12, 19, 32), cat: 'test_gap', sev: 'info', title: 'Log the rejected currency code', desc: 'Support will ask which code was rejected. Add it to the structured log line for the 422 path.', conf: 0.6 },
  ]);
  const [r118a, r118b] = r118.findings;
  pay118.setFinding(r118a!, 'fixed', t(12, 19), 'Now imports SUPPORTED_CURRENCIES from the money module.');
  pay118.setFinding(r118b!, 'fixed', t(12, 19), 'Added currency to the structured log fields.');
  pay118.advance('approved', t(12, 18, 50), PIPELINE);
  pay118.autoApprove(t(12, 18, 50), 'no blocking findings, all rules passed, evidence complete.');
  pay118.advance('pending_merge', t(12, 17), PIPELINE, { confirmer: ROBIN, rationale: 'Reviewed the PR. Safe to merge.' });
  pay118.event('pr_merged', t(11, 20), 'system', { pr_url: pay118.c.current_pr_ref, source: 'webhook' });
  pay118.evidence('pr_merged', t(11, 20), 'Pull request #402 merged into main.', { source: 'webhook', by: 'system' });
  pay118.advance('done', t(11, 20), PIPELINE);
  pay118.done();

  // --- PAY-131 · pending_merge · critical, request-changes + four-eyes ---------
  const pay131 = new CaseCtx({
    key: 'pay131', id: 'case-steady-refund-m9Xa', ref: 'PAY-131',
    title: 'Idempotency keys for the refund endpoint',
    description: 'Refund requests retried by clients can create duplicate refunds. Accept an Idempotency-Key header and replay the stored result for repeated keys.',
    project: PAYMENTS, owner: ALEX, type: 'ticket_implementation', risk: 'critical', priority: 'urgent',
    branch: 'feat/refund-idempotency', pr: 431, created: t(15), agent: CLAUDE_CODE, knowledge: [K_NOPAN, K_FLAKY_V3],
  });
  pay131.explore(t(14, 22), 'Explored the refund flow and the existing request deduplication.', [
    '**Findings.** Refunds are created in `RefundService.create()`; nothing deduplicates retried requests. The charge endpoint already stores keys in `idempotency_keys`.',
    '',
    '**Plan.** Reuse the table, add a `refund` scope and store the response body for replay.',
  ].join('\n'), CLAUDE_CODE, ALEX);
  pay131.advance('in_build', t(14, 20), ALEX, { agent: CLAUDE_CODE });
  pay131.run('build_run', t(13, 23), 55, { trigger: ALEX, summary: 'Implemented idempotent refunds.' });
  pay131.ci(t(13, 22), 9318870, 'Vitest: 231 passed, 0 failed.');
  pay131.evidence('runtime_log', t(13, 21, 30), 'Replayed 500 refund requests with duplicate keys against staging: 0 duplicate refunds.', { source: 'agent', agent: CLAUDE_CODE, ref: `${GITHUB}/acme/payments-api/actions/runs/9318871` });
  pay131.evidence('integration_test_result', t(13, 21), 'Integration suite: 48 passed, including refund replay and key conflict cases.', { source: 'webhook', by: 'system', ref: `${GITHUB}/acme/payments-api/actions/runs/9318870#integration` });
  pay131.comment(ALEX, t(13, 20, 40), 'Keys are stored per merchant for 24h. Repeated key with a different body returns 409.', { agent: CLAUDE_CODE, kind: 'build_summary' });
  pay131.advance('in_validation', t(13, 20), PIPELINE);
  pay131.rules(t(13, 19, 55));
  pay131.advance('in_review', t(13, 19, 40), PIPELINE);
  const r131a = pay131.review(t(13, 19, 35), 412, 'Review found one high and three lower severity issues.', [
    { ago: t(13, 19, 32), cat: 'bug', sev: 'high', title: 'Idempotency key lookup is not scoped per merchant', desc: 'The lookup in `IdempotencyStore.find()` queries by key only. Two merchants sending the same key would replay each other\'s refund response.', conf: 0.93 },
    { ago: t(13, 19, 32), cat: 'test_gap', sev: 'medium', title: 'No test for concurrent duplicate requests', desc: 'Only sequential replays are tested. Add a test that fires two identical requests in parallel.', conf: 0.8 },
    { ago: t(13, 19, 32), cat: 'performance_risk', sev: 'medium', title: 'Idempotency table has no cleanup for expired keys', desc: 'Rows are never deleted after the 24h window. The table will grow without bound.', conf: 0.7, contested: true },
    { ago: t(13, 19, 32), cat: 'maintainability_issue', sev: 'low', title: 'Naming: IdemKey vs IdempotencyKey', desc: 'Both spellings appear in the new code. Pick one.', conf: 0.66 },
  ]);
  const [f131Scope, f131Test, f131Ttl, f131Name] = r131a.findings;
  pay131.advance('needs_human_decision', t(13, 19, 30), PIPELINE);
  const pay131RequestChanges = pay131.decision('request_changes', t(12, 20), ROBIN, 'The key lookup must be scoped by merchant_id before this ships, and we need a concurrency test. Everything else looks fine.');
  pay131.advance('in_build', t(12, 20), ROBIN);
  pay131.setFinding(f131Name!, 'resolved', t(12, 10), 'Renamed to IdempotencyKey everywhere.');
  pay131.run('build_run', t(12, 6), 38, { trigger: ALEX, summary: 'Scoped keys per merchant and added a concurrency test.' });
  pay131.ci(t(11, 22), 9324105, 'Vitest: 236 passed, 0 failed.');
  pay131.evidence('integration_test_result', t(11, 21, 40), 'Integration suite: 51 passed, including parallel duplicate requests.', { source: 'webhook', by: 'system', ref: `${GITHUB}/acme/payments-api/actions/runs/9324105#integration` });
  pay131.comment(ALEX, t(11, 21, 30), 'Lookup now keyed on (merchant_id, key). Added a parallel-request test. Left the TTL cleanup out on purpose: the nightly retention job already prunes this table.', { agent: CLAUDE_CODE, kind: 'build_summary' });
  pay131.setFinding(f131Scope!, 'fixed', t(11, 21), 'Lookup is scoped per merchant.');
  pay131.setFinding(f131Test!, 'fixed', t(11, 21), 'Parallel duplicate-request test added.');
  pay131.advance('in_validation', t(11, 21), PIPELINE);
  pay131.rules(t(11, 20, 55));
  pay131.advance('in_review', t(11, 20, 40), PIPELINE);
  const r131b = pay131.review(t(11, 20, 35), 468, 'Second review: earlier findings addressed, one low issue left.', [
    { ago: t(11, 20, 32), cat: 'maintainability_issue', sev: 'low', title: 'Log a line when a stored key is replayed', desc: 'Support cannot tell a replayed response from a fresh one. Log the key and merchant on replay.', conf: 0.6 },
  ]);
  pay131.setFinding(r131b.findings[0]!, 'resolved', t(11, 19), 'Replay is logged at info level.');
  pay131.advance('needs_human_decision', t(11, 20, 30), PIPELINE);
  pay131.decision('waive', t(9, 22), SAM, 'Expired keys are pruned by the platform-wide nightly retention job, so a dedicated cleanup would duplicate it.', { finding: f131Ttl! });
  pay131.setFinding(f131Ttl!, 'waived', t(9, 22), 'Pruned by the nightly retention job; no cleanup in this change.');
  pay131.decision('approve', t(9, 21), SAM, 'Round two addresses the scoping bug and adds the concurrency test. Approving.');
  pay131.decision('approve', t(9, 20), ROBIN, 'Second approval (four-eyes). Verified the merchant scoping in staging.');
  pay131.advance('approved', t(9, 20), ROBIN);
  pay131.advance('pending_merge', t(8, 10), PIPELINE, { confirmer: SAM, rationale: 'Release window is open. Confirming the merge gate.', gateWait: t(1, 10) });
  pay131.flag({
    detector_id: 'aging-pending-merge',
    signature: buildSignature('aging-pending-merge', 'case', pay131.c.case_id),
    severity: 'medium',
    summary: 'Case has been in `pending_merge` for 7d (threshold: 7d). Please merge or send back to build.',
    evidence: { case_id: pay131.c.case_id, status: 'pending_merge', pending_merge_since: iso(t(8, 10)), days_in_status: 7, threshold_days: 7 },
    flagged_at: iso(t(1, 6, 35)),
  });
  pay131.done();

  // --- PAY-142 · needs_human_decision · the Courtroom case ---------------------
  const pay142 = new CaseCtx({
    key: 'pay142', id: 'case-bold-webhook-t4Qe', ref: 'PAY-142',
    title: 'Retry failed webhook deliveries with exponential backoff',
    description: 'Merchants miss events when their endpoint is briefly down. Retry failed deliveries with exponential backoff and jitter, capped at six hours.',
    project: PAYMENTS, owner: ROBIN, reviewer: ALEX, type: 'ticket_implementation', risk: 'high', priority: 'high',
    branch: 'feat/webhook-retry-backoff', pr: 447, created: t(4, 6), agent: CLAUDE_CODE, knowledge: [K_IDEMP, K_NOPAN],
  });
  pay142.explore(t(4, 5), 'Explored the delivery worker and the current retry behavior.', [
    '**Current behavior.** A failed delivery is retried once after 30s, then dropped.',
    '',
    '**Plan.** Persist an attempt counter per delivery, use exponential backoff with full jitter, cap the delay at six hours and stop after 24 attempts.',
  ].join('\n'), CLAUDE_CODE, ROBIN);
  pay142.advance('in_build', t(4, 2), ROBIN, { agent: CLAUDE_CODE });
  pay142.run('build_run', t(0, 10), 47, { trigger: ROBIN, summary: 'Implemented the retry scheduler and tests.' });
  pay142.ci(t(0, 9, 10), 9331277, 'Vitest: 243 passed, 0 failed.');
  pay142.evidence('runtime_log', t(0, 9), 'Staging soak with 2,000 failing endpoints for 30 minutes: backoff capped at 6h, no retry storm observed.', { source: 'agent', agent: CLAUDE_CODE, ref: `${GITHUB}/acme/payments-api/actions/runs/9331278` });
  pay142.comment(ROBIN, t(0, 8, 55), 'Retries use full jitter and a 6h cap. Delivery attempts are logged without payload bodies (see the no-PAN-in-logs precedent).', { agent: CLAUDE_CODE, kind: 'build_summary' });
  pay142.advance('in_validation', t(0, 8, 30), PIPELINE);
  pay142.rules(t(0, 8, 20), {
    rule_no_todo_fixme: { status: 'warning', message: 'One TODO comment added in src/webhooks/retry-scheduler.ts.' },
  });
  pay142.advance('in_review', t(0, 8, 10), PIPELINE);
  const r142 = pay142.review(t(0, 8), 538, 'Review found one high severity bug and three further issues.', [
    { ago: t(0, 7, 56), cat: 'bug', sev: 'high', title: 'Retry counter is kept in memory and resets on restart', desc: '`WebhookRetryScheduler` stores attempt counts in a process-local Map (`src/webhooks/retry-scheduler.ts:58`). After a deploy or crash every pending delivery restarts at attempt 1, so endpoints that were down for hours receive a burst of retries.', conf: 0.91, note: 'The counter is only read from `attemptsByDelivery`; no code path persists it to the deliveries table.' },
    { ago: t(0, 7, 56), cat: 'test_gap', sev: 'medium', title: 'No test covers the jitter upper bound', desc: 'Tests assert the delay grows but never that jittered delays stay at or below the 6h cap.', conf: 0.78 },
    { ago: t(0, 7, 56), cat: 'security_risk', sev: 'medium', title: 'Webhook target URL is not re-validated before each retry', desc: 'The URL is validated when the endpoint is registered. A DNS change could later point it at an internal address.', conf: 0.7, contested: true, status: 'waiver_proposed', resolution: 'URL is validated on registration and all egress goes through the proxy that blocks private ranges. Re-validating on every retry would add a DNS lookup per attempt.', knowledge: K_EGRESS },
    { ago: t(0, 7, 56), cat: 'maintainability_issue', sev: 'low', title: 'Backoff table recomputed on every call', desc: 'The delay table is rebuilt per call. Compute it once at module load.', conf: 0.55, status: 'fixed', resolution: 'Moved to a module-level constant.', verified: 'uncertain', note: 'Could not determine whether the call is on a hot path from the provided context.' },
  ]);
  const [f142Bug, , f142Sec] = r142.findings;
  pay142.advance('needs_human_decision', t(0, 7, 50), PIPELINE);
  const pay142Waiver = pay142.decision('propose_waiver', t(0, 7, 20), ROBIN, 'Proposing to waive: the URL is validated on registration and all outbound webhook traffic goes through the egress proxy that blocks private ranges.', { finding: f142Sec!, agent: CLAUDE_CODE });
  pay142.comment(SAM, t(0, 6, 40), 'Confirmed locally: killing the worker during a retry window resets the schedule to attempt 1.', { finding: f142Bug! });
  pay142.comment(ROBIN, t(0, 6, 5), 'Alex, can you take the decision? The restart-reset finding is real and I would rather fix it than waive it. The URL re-validation one is fine to waive.');
  pay142.comment(ALEX, t(0, 5, 30), 'On it. I want the counter persisted before this merges. Will request changes unless the fix is already queued.');
  pay142.done();

  // --- PAY-150 · in_review · AI review running ----------------------------------
  const pay150 = new CaseCtx({
    key: 'pay150', id: 'case-keen-payout-w2Lc', ref: 'PAY-150',
    title: 'Add an audit log for payout approvals',
    description: 'Record who approved each payout, when, and from which role, so finance can answer audit questions without reading application logs.',
    project: PAYMENTS, owner: ALEX, type: 'ticket_implementation', risk: 'medium', priority: 'normal',
    branch: 'feat/payout-audit-log', pr: 452, created: t(2, 8), agent: CLAUDE_CODE, knowledge: [K_NOPAN],
  });
  pay150.explore(t(2, 7, 40), 'Explored the payout approval flow.', 'Approvals are handled in `PayoutApprovalService.approve()`. Plan: append-only `payout_audit_log` table written in the same transaction.', CLAUDE_CODE, ALEX);
  pay150.advance('in_build', t(2, 5), ALEX, { agent: CLAUDE_CODE });
  pay150.run('build_run', t(0, 0, 50), 33, { trigger: ALEX, summary: 'Implemented the audit log.' });
  pay150.ci(t(0, 0, 15), 9334650, 'Vitest: 249 passed, 0 failed.');
  pay150.advance('in_validation', t(0, 0, 10), PIPELINE);
  pay150.rules(t(0, 0, 9));
  pay150.advance('in_review', t(0, 0, 6), PIPELINE);
  pay150.run('review_run', t(0, 0, 2), 0, { status: 'running', diffLines: 211 });
  pay150.done();

  // --- PAY-153 · in_build · agent live on the branch ----------------------------
  const pay153 = new CaseCtx({
    key: 'pay153', id: 'case-brisk-levy-h8Vb', ref: 'PAY-153',
    title: 'Fix rounding error in tax calculation',
    description: 'Invoices for multi-line orders are off by one cent when tax is rounded per line instead of per invoice.',
    project: PAYMENTS, owner: SAM, type: 'bugfix', risk: 'medium', priority: 'high',
    branch: 'fix/tax-rounding', created: t(0, 7), agent: CLAUDE_CODE,
  });
  pay153.explore(t(0, 6, 50), 'Reproduced the one-cent drift with a three-line order.', [
    '**Root cause.** `calculateTax()` rounds each line item and sums the rounded values. Tax law in our markets requires rounding the invoice total once.',
    '',
    '**Plan.** Sum unrounded line tax, round once, and distribute the remainder cent to the largest line.',
  ].join('\n'), CLAUDE_CODE, SAM);
  pay153.advance('in_build', t(0, 6, 20), SAM, { agent: CLAUDE_CODE });
  pay153.done();

  // --- PAY-158 · approved · waiting for the merge gate --------------------------
  const pay158 = new CaseCtx({
    key: 'pay158', id: 'case-quiet-mask-r6Pj', ref: 'PAY-158',
    title: 'Mask card numbers in error logs',
    description: 'Failed-charge errors echo the request body, including the card number. Mask everything except the last four digits before logging.',
    project: PAYMENTS, owner: SAM, type: 'bugfix', risk: 'medium', priority: 'high',
    branch: 'fix/mask-pan-in-errors', pr: 439, created: t(3, 9), agent: CURSOR, knowledge: [K_NOPAN],
  });
  pay158.explore(t(3, 8, 40), 'Traced where the charge request body reaches the logger.', 'Two call sites log the raw body: the error mapper and the retry wrapper. Adding a `maskCardData()` helper and using it in both.', CURSOR, SAM);
  pay158.advance('in_build', t(3, 8), SAM, { agent: CURSOR });
  pay158.run('build_run', t(2, 4), 22, { trigger: SAM, summary: 'Masked card data in both log call sites.' });
  pay158.ci(t(2, 3, 30), 9322119, 'Vitest: 226 passed, 0 failed.');
  pay158.advance('in_validation', t(2, 3), PIPELINE);
  pay158.rules(t(2, 2, 55));
  pay158.advance('in_review', t(2, 2, 45), PIPELINE);
  const r158 = pay158.review(t(2, 2, 40), 74, 'Review found one minor issue.', [
    { ago: t(2, 2, 37), cat: 'test_gap', sev: 'low', title: 'Add a test for masking of short card numbers', desc: 'The helper is only tested with 16-digit numbers. Cover 13-digit and 19-digit PANs.', conf: 0.72 },
  ]);
  pay158.setFinding(r158.findings[0]!, 'fixed', t(2, 2), 'Added tests for 13- and 19-digit numbers.');
  pay158.advance('approved', t(2, 1, 55), PIPELINE);
  pay158.autoApprove(t(2, 1, 55), 'no blocking findings, all rules passed, evidence complete.');
  pay158.pendingGate('approved_to_pending_merge', t(2, 1, 50));
  pay158.comment(SAM, t(0, 3), 'Holding the merge gate until the release freeze lifts tomorrow. Nothing else is blocking this.');
  pay158.done();

  // --- PAY-160 · open · idle -----------------------------------------------------
  const pay160 = new CaseCtx({
    key: 'pay160', id: 'case-idle-client-d1Zs', ref: 'PAY-160',
    title: 'Replace the deprecated payment-intent client',
    description: 'The v1 payment-intent client is deprecated by the processor. Migrate calls to the v2 client and remove the wrapper.',
    project: PAYMENTS, owner: ROBIN, type: 'refactoring', risk: 'low', priority: 'low',
    created: t(10), knowledge: [K_LEGACY],
  });
  pay160.comment(ROBIN, t(9, 20), 'Parking this until Q4 planning. No customer impact, the v1 client works until next spring.');
  pay160.flag({
    detector_id: 'stale-open',
    signature: buildSignature('stale-open', 'case', pay160.c.case_id),
    severity: 'low',
    summary: 'No activity for 8d (threshold: 7d). Clarify status, continue the work, or close.',
    evidence: { case_id: pay160.c.case_id, status: 'open', last_activity_at: iso(t(9, 20)), days_idle: 8, threshold_days: 7 },
    flagged_at: iso(t(1, 18, 35)),
  });
  pay160.done();

  // --- WEB-190 · rejected --------------------------------------------------------
  const web190 = new CaseCtx({
    key: 'web190', id: 'case-hasty-total-f5Gm', ref: 'WEB-190',
    title: 'Calculate order totals in the browser',
    description: 'Compute cart and order totals client-side to remove a round trip on every quantity change.',
    project: STOREFRONT, owner: SAM, type: 'ticket_implementation', risk: 'high', priority: 'normal',
    branch: 'feat/client-side-totals', pr: 301, created: t(9), agent: CURSOR,
  });
  web190.explore(t(8, 23), 'Explored the cart pricing code paths.', 'Pricing lives in `CartService.total()`. Plan: port it to a shared TypeScript module and call it from the cart page.', CURSOR, SAM);
  web190.advance('in_build', t(8, 22), SAM, { agent: CURSOR });
  web190.run('build_run', t(8, 4), 62, { trigger: SAM, summary: 'Moved total calculation into the browser bundle.' });
  web190.ci(t(8, 3, 20), 4402190, 'Vitest: 167 passed, 0 failed.');
  web190.evidence('runtime_log', t(8, 3, 10), 'Ran the checkout flow against the preview deployment with throttled network.', { source: 'agent', agent: CURSOR, ref: `${GITHUB}/acme/storefront/actions/runs/4402191` });
  web190.advance('in_validation', t(8, 3), PIPELINE);
  web190.rules(t(8, 2, 55));
  web190.advance('in_review', t(8, 2, 45), PIPELINE);
  const r190 = web190.review(t(8, 2, 40), 322, 'Review found a critical architecture violation and a high severity security issue.', [
    { ago: t(8, 2, 36), cat: 'architecture_violation', sev: 'critical', title: 'Prices must be computed server-side only', desc: 'The change moves price calculation into the browser, which contradicts the project rule that the server is the only source of prices.', conf: 0.95 },
    { ago: t(8, 2, 36), cat: 'security_risk', sev: 'high', title: 'Order API trusts the client-supplied total', desc: '`POST /orders` now accepts `total` from the request body and no longer recomputes it. A modified client can pay any amount.', conf: 0.94 },
  ]);
  web190.advance('needs_human_decision', t(8, 2, 30), PIPELINE);
  const web190Reject = web190.decision('reject', t(7, 20), ROBIN, 'Rejecting. Prices are computed on the server, full stop: a browser-side total is trusted input. The latency problem is real, so let us cache the server total instead. I will write up the decision.');
  web190.advance('rejected', t(7, 20), ROBIN);
  web190.setFinding(r190.findings[0]!, 'resolved', t(7, 20), 'Case rejected.');
  web190.setFinding(r190.findings[1]!, 'resolved', t(7, 20), 'Case rejected.');
  web190.done();

  // --- WEB-198 · verification_pending · manual track ---------------------------
  const web198 = new CaseCtx({
    key: 'web198', id: 'case-careful-safari-n7Wk', ref: 'WEB-198',
    title: 'Verify checkout address autocomplete on Safari',
    description: 'The new address autocomplete passed automated checks. A human has to confirm it on Safari 17 and Safari on iOS before release.',
    project: STOREFRONT, owner: ROBIN, reviewer: SAM, type: 'manual_verification', risk: 'medium', priority: 'high', track: 'manual',
    branch: 'feat/checkout-address-autocomplete', pr: 315, created: t(5, 4), agent: CLAUDE_CODE,
  });
  web198.explore(t(5, 3, 40), 'Explored the address form and the autocomplete provider SDK.', 'The provider SDK attaches a listener to the street input. Plan: wrap it in a component and fall back to plain input if the SDK fails to load.', CLAUDE_CODE, ROBIN);
  web198.advance('in_build', t(5, 3), ROBIN, { agent: CLAUDE_CODE });
  web198.run('build_run', t(3, 6), 44, { trigger: ROBIN, summary: 'Implemented autocomplete with a plain-input fallback.' });
  web198.ci(t(3, 5, 20), 4417032, 'Vitest: 172 passed, 0 failed.');
  web198.evidence('screenshot', t(3, 5), 'Autocomplete dropdown in Chrome, plain-input fallback with the SDK blocked.', { source: 'manual', by: ROBIN, ref: 'https://example.com/screenshots/web-198-autocomplete.png' });
  web198.evidence('manual_confirmation', t(3, 4, 55), 'Verified address autocomplete on Chrome 130 and Firefox 131 (desktop). Safari still to do.', { source: 'manual', by: ROBIN });
  web198.advance('in_validation', t(3, 4, 50), PIPELINE);
  web198.rules(t(3, 4, 40));
  web198.advance('in_review', t(3, 4, 30), PIPELINE);
  const r198 = web198.review(t(3, 4, 25), 188, 'Review found two minor issues.', [
    { ago: t(3, 4, 22), cat: 'maintainability_issue', sev: 'low', title: 'Provider key is read from window globals', desc: 'The SDK key is read from `window.__ENV`. Use the typed config module.', conf: 0.7 },
    { ago: t(3, 4, 22), cat: 'test_gap', sev: 'low', title: 'Fallback path has no test', desc: 'Add a test that renders the form when the SDK script fails to load.', conf: 0.68 },
  ]);
  web198.setFinding(r198.findings[0]!, 'fixed', t(3, 3), 'Uses the typed config module.');
  web198.setFinding(r198.findings[1]!, 'fixed', t(3, 3), 'Added a fallback render test.');
  web198.advance('verification_pending', t(3, 4, 15), PIPELINE);
  web198.comment(SAM, t(0, 15), 'I only have Safari 17 on macOS today. Will check iOS tomorrow, then confirm.');
  web198.done();

  // --- WEB-204 · needs_human_decision · high finding, no reviewer yet ----------
  const web204 = new CaseCtx({
    key: 'web204', id: 'case-sharp-markup-b2Hy', ref: 'WEB-204',
    title: 'Render rich-text product descriptions',
    description: 'Merchandising wants bold text, lists and links in product descriptions. Render the stored HTML on the product page.',
    project: STOREFRONT, owner: SAM, type: 'ticket_implementation', risk: 'medium', priority: 'normal',
    branch: 'feat/rich-text-descriptions', pr: 322, created: t(3), agent: CURSOR, knowledge: [K_SANITIZE],
  });
  web204.explore(t(2, 23), 'Explored the product page and the description field.', 'Descriptions are stored as HTML from the CMS. Plan: render with a small `RichText` component.', CURSOR, SAM);
  web204.advance('in_build', t(2, 22), SAM, { agent: CURSOR });
  web204.run('build_run', t(1, 3), 36, { trigger: SAM, summary: 'Added the RichText component to the product page.' });
  web204.ci(t(1, 2, 25), 4421550, 'Vitest: 181 passed, 0 failed.');
  web204.advance('in_validation', t(1, 2), PIPELINE);
  web204.rules(t(1, 1, 55));
  web204.advance('in_review', t(1, 1, 45), PIPELINE);
  web204.review(t(1, 1, 40), 143, 'Review found one high severity security issue.', [
    { ago: t(1, 1, 36), cat: 'security_risk', sev: 'high', title: 'Product HTML is rendered without sanitization', desc: '`RichText` passes the CMS string to `dangerouslySetInnerHTML` (`src/components/RichText.tsx:12`). Anyone with CMS write access can inject script into every visitor\'s session.', conf: 0.92 },
    { ago: t(1, 1, 36), cat: 'test_gap', sev: 'low', title: 'No test for descriptions containing script tags', desc: 'Add a test that asserts script and event-handler attributes are stripped.', conf: 0.7 },
  ]);
  web204.advance('needs_human_decision', t(1, 1, 30), PIPELINE);
  web204.done();

  // --- WEB-211 · in_validation · waiting for CI ---------------------------------
  const web211 = new CaseCtx({
    key: 'web211', id: 'case-tidy-basket-c9Ue', ref: 'WEB-211',
    title: 'Persist cart quantity changes across sessions',
    description: 'Quantity edits are lost when a signed-in shopper reloads the cart page. Persist them to the server cart.',
    project: STOREFRONT, owner: SAM, type: 'bugfix', risk: 'low', priority: 'normal',
    branch: 'fix/cart-quantity-persist', pr: 318, created: t(1, 5), agent: CURSOR,
  });
  web211.explore(t(1, 4, 45), 'Found the debounce that drops the final PATCH on unload.', 'The quantity PATCH is debounced and never flushed on page unload. Plan: flush with `navigator.sendBeacon`.', CURSOR, SAM);
  web211.advance('in_build', t(1, 4, 20), SAM, { agent: CURSOR });
  web211.run('build_run', t(0, 0, 40), 19, { trigger: SAM, summary: 'Flushed pending quantity updates on unload.' });
  web211.ci(t(0, 0, 12), 4425011);
  web211.evidence('lint_result', t(0, 0, 11), 'ESLint: 0 errors, 0 warnings.', { source: 'webhook', by: 'system', ref: `${GITHUB}/acme/storefront/actions/runs/4425011#lint` });
  web211.advance('in_validation', t(0, 0, 9), PIPELINE);
  web211.run('rule_run', t(0, 0, 7), 0, { status: 'running' });
  web211.done();

  // --- WEB-215 · ready_for_build ------------------------------------------------
  const web215 = new CaseCtx({
    key: 'web215', id: 'case-fresh-mailer-p3Tx', ref: 'WEB-215',
    title: 'Add the order-status email template',
    description: 'Send shoppers an email when an order ships, with tracking link and delivery estimate.',
    project: STOREFRONT, owner: ROBIN, type: 'ticket_implementation', risk: 'low', priority: 'normal',
    created: t(0, 20), agent: CLAUDE_CODE,
  });
  web215.explore(t(0, 19, 40), 'Explored the notification service and existing email templates.', 'Templates live in `emails/`. Plan: add `order-shipped.mjml`, wire it to the `order.shipped` event and add a preview test.', CLAUDE_CODE, ROBIN);
  web215.done();

  // --- MOB-72 · done · autonomous profile --------------------------------------
  const mob72 = new CaseCtx({
    key: 'mob72', id: 'case-lucky-ping-j4Rv', ref: 'MOB-72',
    title: 'Fix crash when a push notification has no deep link',
    description: 'Tapping a push notification without a deep link crashes the app on Android 13. Fall back to the home screen.',
    project: MOBILE, owner: ALEX, type: 'bugfix', risk: 'medium', priority: 'high',
    branch: 'fix/push-deeplink-crash', pr: 88, created: t(7), agent: CODEX,
  });
  mob72.explore(t(6, 23, 40), 'Reproduced the crash from the stack trace in the crash report.', 'The deep link is force-unwrapped in `NotificationRouter.open()`. Plan: treat a missing link as "open home" and add a test.', CODEX, ALEX);
  mob72.advance('in_build', t(6, 23, 25), PIPELINE);
  mob72.run('build_run', t(6, 20), 27, { trigger: ALEX, summary: 'Handled missing deep links and added a regression test.' });
  mob72.ci(t(6, 19, 10), 1120344);
  mob72.evidence('lint_result', t(6, 19, 5), 'Lint: 0 errors.', { source: 'webhook', by: 'system', ref: `${GITHUB}/acme/mobile-app/actions/runs/1120344#lint` });
  // The mobile policy has no unit-test requirement; a human confirmation takes its place.
  mob72.evidence('manual_confirmation', t(6, 19), 'Verified on a Pixel 7 (Android 13): tapping a notification without a link opens the home screen.', { source: 'manual', by: ALEX });
  mob72.advance('in_validation', t(6, 19), PIPELINE);
  mob72.rules(t(6, 18, 55));
  mob72.advance('in_review', t(6, 18, 50), PIPELINE);
  const r72 = mob72.review(t(6, 18, 45), 61, 'Review found one medium issue.', [
    { ago: t(6, 18, 42), cat: 'bug', sev: 'medium', title: 'Analytics event still fires for the unresolved link', desc: 'The fallback opens home, but `trackNotificationOpened` still reports the missing link as a deep link.', conf: 0.76 },
  ]);
  mob72.setFinding(r72.findings[0]!, 'fixed', t(6, 18), 'Event now reports `home` as the destination.');
  mob72.advance('approved', t(6, 17, 55), PIPELINE);
  mob72.autoApprove(t(6, 17, 55), 'no blocking findings, all rules passed, evidence complete.');
  mob72.advance('pending_merge', t(6, 17, 54), PIPELINE);
  mob72.event('pr_merged', t(5, 20), 'system', { pr_url: mob72.c.current_pr_ref, source: 'webhook' });
  mob72.evidence('pr_merged', t(5, 20), 'Pull request #88 merged into main.', { source: 'webhook', by: 'system' });
  mob72.advance('done', t(5, 20), PIPELINE);
  mob72.done();

  // --- MOB-77 · exploration -----------------------------------------------------
  const mob77 = new CaseCtx({
    key: 'mob77', id: 'case-secure-glance-y8Ma', ref: 'MOB-77',
    title: 'Biometric re-auth before showing saved cards',
    description: 'Require Face ID, fingerprint or the device PIN before the saved-cards screen opens if the app was in the background for more than five minutes.',
    project: MOBILE, owner: ALEX, type: 'ticket_implementation', risk: 'high', priority: 'normal',
    created: t(0, 2), agent: CLAUDE_CODE, knowledge: [K_BIOMETRIC],
  });
  mob77.advance('exploration', t(0, 1, 50), ALEX, { agent: CLAUDE_CODE });
  mob77.comment(ALEX, t(0, 1, 40), 'Scope: iOS LocalAuthentication and Android BiometricPrompt, fallback to the device PIN. Exploring the existing session timeout handling first.');
  mob77.done();

  // --- Observed cases (auto-created from agent activity) ------------------------
  const obs1 = new CaseCtx({
    key: 'obs1', id: 'case-calm-wishlist-e1Nq',
    title: 'Observed: feat/wishlist-sharing',
    description: 'Auto-created by Arbitra from agent activity on storefront @ feat/wishlist-sharing. No case existed for this branch yet — this one records the work without blocking it.',
    project: STOREFRONT, owner: 'system:observed-case', type: 'observed', risk: 'low', priority: 'normal',
    branch: 'feat/wishlist-sharing', created: t(0, 1, 10), source: 'git',
  });
  obs1.advance('in_build', t(0, 1, 10), 'system:observed-case');
  obs1.done();

  const obs2 = new CaseCtx({
    key: 'obs2', id: 'case-mellow-locale-s6Uz',
    title: 'Observed: fix/locale-fallback',
    description: 'Auto-created by Arbitra from agent activity on mobile-app @ fix/locale-fallback. No case existed for this branch yet — this one records the work without blocking it.',
    project: MOBILE, owner: 'system:observed-case', type: 'observed', risk: 'low', priority: 'normal',
    branch: 'fix/locale-fallback', pr: 85, created: t(6), source: 'git',
  });
  obs2.advance('in_build', t(6), 'system:observed-case');
  obs2.event('pr_merged', t(5, 21), 'system', { pr_url: obs2.c.current_pr_ref, source: 'webhook' });
  obs2.advance('done', t(5, 21), PIPELINE);
  obs2.done();
  obs2.c.approved_head_sha = undefined;

  for (const o of [obs1, obs2]) {
    out.observedCaseClaims.push({
      doc: {
        repository_id: o.c.repository_id,
        branch: o.c.current_branch ?? '',
        case_id: o.c.case_id,
        created_at: o.c.created_at,
      } satisfies ObservedCaseClaim,
    });
  }

  return {
    pay118, pay131, pay142, pay150, pay153, pay158, pay160, web190, web198, web204, web211, web215,
    mob72, mob77, obs1, obs2,
    pay131RequestChanges, web190Reject, pay142Waiver,
  };
}

// ---------------------------------------------------------------------------
// Knowledge assets (one or more per lifecycle stage)
// ---------------------------------------------------------------------------

function seedKnowledge(s: Story): void {
  const base = {
    version: 1,
    artifact_refs: [] as string[],
    source_case_refs: [] as string[],
    source_decision_refs: [] as string[],
  };
  const asset = (a: Omit<KnowledgeAsset, 'created_at' | 'updated_at'> & { created: number; updated?: number }): KnowledgeAsset => {
    const { created, updated, ...rest } = a;
    return { ...rest, created_at: iso(created), updated_at: iso(updated ?? created) };
  };

  out.knowledgeAssets.push(
    asset({
      ...base, knowledge_id: K_IDEMP, type: 'precedent', status: 'canonical', version: 3, trust_level: 88,
      title: 'Idempotency keys are scoped per merchant',
      summary: 'A lookup by key alone lets two merchants replay each other\'s responses. Always scope by (merchant_id, key).',
      body: 'Found in PAY-131 (refund idempotency). The first implementation looked keys up globally; the reviewer caught it and a tech lead requested changes.\n\n**Rule of thumb.** Any store keyed by a client-supplied value is scoped by the tenant first. Add a test with two tenants sending the same key.',
      scope_type: 'project', scope_ref: PAYMENTS.id,
      source_case_refs: [s.pay131.c.case_id], source_decision_refs: [s.pay131RequestChanges.decision_id],
      tags: ['idempotency', 'multi-tenant', 'refunds'], created_by: ROBIN, approved_by: ROBIN,
      last_referenced_at: iso(t(0, 7)), created: t(12), updated: t(9),
    }),
    asset({
      ...base, knowledge_id: K_NOPAN, type: 'anti_pattern', status: 'canonical', version: 2, trust_level: 95,
      title: 'Never log card numbers or CVV values',
      summary: 'Request bodies, error payloads and debug dumps must not reach logs with card data in them.',
      body: 'Card data in logs widens PCI scope and leaks into third-party log tooling.\n\n- Log identifiers (charge id, last four digits), never bodies.\n- Use `maskCardData()` when an error must include the request.\n- The `rule_payments_no_pan_logging` rule flags the common patterns in the diff.',
      scope_type: 'project', scope_ref: PAYMENTS.id,
      source_case_refs: [s.pay158.c.case_id], tags: ['pci', 'logging', 'security'],
      created_by: SAM, approved_by: ROBIN, last_referenced_at: iso(t(0, 4)), created: t(25), updated: t(2),
    }),
    asset({
      ...base, knowledge_id: K_EGRESS, type: 'implementation_note', status: 'suggested', trust_level: 0,
      title: 'Webhook egress goes through the blocking proxy',
      summary: 'All outbound webhook traffic leaves via the egress proxy, which rejects private and link-local ranges.',
      body: 'Suggested by the agent while proposing a waiver on PAY-142: target URLs are validated at registration, and the egress proxy blocks private ranges at connect time, so per-retry URL validation is redundant.\n\nNeeds a human to confirm the proxy guarantee before this becomes verified.',
      scope_type: 'repo', scope_ref: PAYMENTS.repo.id,
      source_case_refs: [s.pay142.c.case_id], source_decision_refs: [s.pay142Waiver.decision_id],
      tags: ['webhooks', 'egress', 'ssrf'], created_by: ROBIN, created: t(0, 7, 20),
    }),
    asset({
      ...base, knowledge_id: K_LEGACY, type: 'pattern', status: 'deprecated', version: 2, trust_level: 40,
      title: 'Call the processor through the v1 payment-intent client',
      summary: 'Superseded: the v1 client is deprecated by the processor. New code should use the v2 client.',
      body: 'The v1 wrapper in `src/processor/intent-client.ts` was the standard entry point. The processor has announced end of life for v1; migration is tracked in PAY-160.',
      scope_type: 'project', scope_ref: PAYMENTS.id, tags: ['processor', 'deprecation'],
      created_by: ROBIN, approved_by: ROBIN, created: t(120), updated: t(20),
    }),
    asset({
      ...base, knowledge_id: K_TOTALS, type: 'architecture_decision', status: 'canonical', version: 1, trust_level: 90,
      title: 'Prices are computed on the server only',
      summary: 'Order and cart totals are computed server-side. The browser displays totals but never supplies them.',
      body: 'Decision recorded after WEB-190 was rejected.\n\n**Why.** A browser-side total is client-supplied input; the order API would have to trust it.\n\n**Instead.** Reduce latency by caching the server total and by batching quantity updates.',
      scope_type: 'project', scope_ref: STOREFRONT.id,
      source_case_refs: [s.web190.c.case_id], source_decision_refs: [s.web190Reject.decision_id],
      tags: ['pricing', 'architecture', 'security'], created_by: ROBIN, approved_by: ROBIN, created: t(7, 18), updated: t(7, 12),
    }),
    asset({
      ...base, knowledge_id: K_SANITIZE, type: 'pattern', status: 'verified', trust_level: 70,
      title: 'Sanitize CMS HTML with the shared allow-list sanitizer',
      summary: 'Any HTML from the CMS goes through `sanitizeHtml()` before it reaches the DOM.',
      body: 'The shared sanitizer allows basic formatting, lists and links (with `rel="noopener"`), and strips scripts, event handlers and inline styles.',
      scope_type: 'project', scope_ref: STOREFRONT.id, tags: ['xss', 'cms', 'frontend'],
      created_by: SAM, approved_by: ROBIN, created: t(40), updated: t(14),
    }),
    asset({
      ...base, knowledge_id: K_TESTCARDS, type: 'mock_template', status: 'verified', trust_level: 66,
      title: 'Processor test card numbers for checkout tests',
      summary: 'Use the processor\'s published test cards. Never use real card numbers in fixtures.',
      body: '| Scenario | Number |\n| --- | --- |\n| Successful charge | 4242 4242 4242 4242 |\n| Card declined | 4000 0000 0000 0002 |\n| 3-D Secure required | 4000 0000 0000 3220 |',
      scope_type: 'repo', scope_ref: STOREFRONT.repo.id, tags: ['testing', 'checkout', 'fixtures'],
      created_by: SAM, approved_by: SAM, created: t(35),
    }),
    asset({
      ...base, knowledge_id: K_BIOMETRIC, type: 'review_guideline', status: 'verified', trust_level: 64,
      title: 'Sensitive screens require biometric re-auth after backgrounding',
      summary: 'Saved cards, payouts and account deletion re-authenticate after five minutes in the background.',
      body: 'Use LocalAuthentication on iOS and BiometricPrompt on Android, with the device PIN as the fallback. Reviewers should check that the timeout comes from the shared session config.',
      scope_type: 'project', scope_ref: MOBILE.id, tags: ['security', 'biometrics'],
      created_by: ALEX, approved_by: ROBIN, created: t(18), updated: t(10),
    }),
    asset({
      ...base, knowledge_id: K_FLAKY_V2, type: 'exception_policy', status: 'superseded', version: 2, trust_level: 55,
      title: 'Quarantine flaky tests for up to 14 days',
      summary: 'Superseded by the 7-day policy.',
      body: 'A flaky test may be quarantined for 14 days with a tracking ticket.',
      scope_type: 'org', scope_ref: 'acme', tags: ['testing', 'flaky'], created_by: ROBIN, approved_by: ROBIN, created: t(90), updated: t(45),
    }),
    asset({
      ...base, knowledge_id: K_FLAKY_V3, type: 'exception_policy', status: 'canonical', version: 3, trust_level: 85,
      title: 'Quarantine flaky tests for at most 7 days',
      summary: 'A flaky test may be quarantined for up to seven days, with a tracking ticket and an owner.',
      body: 'Replaces the 14-day policy. After seven days the test is fixed or deleted. Quarantined tests still run and report, they just do not block merges.',
      scope_type: 'org', scope_ref: 'acme', tags: ['testing', 'flaky'], created_by: ROBIN, approved_by: ALEX,
      last_referenced_at: iso(t(9, 20)), created: t(45), updated: t(40),
    }),
  );
}

// ---------------------------------------------------------------------------
// Notifications for Alex
// ---------------------------------------------------------------------------

function seedNotifications(s: Story): void {
  const rows: Omit<Notification, 'user_id'>[] = [
    { notification_id: 'notif_alex_01', type: 'case_needs_decision', title: 'Decision needed', body: `${s.pay142.c.title} is waiting for your decision.`, case_id: s.pay142.c.case_id, read: false, created_at: iso(t(0, 7, 50)) },
    { notification_id: 'notif_alex_02', type: 'critical_finding', title: 'High severity finding', body: 'Product HTML is rendered without sanitization (Render rich-text product descriptions).', case_id: s.web204.c.case_id, read: false, created_at: iso(t(1, 1, 36)) },
    { notification_id: 'notif_alex_03', type: 'gate_pending', title: 'Merge gate needs confirmation', body: `${s.pay158.c.title} is approved and waiting for the merge gate.`, case_id: s.pay158.c.case_id, read: false, created_at: iso(t(2, 1, 50)) },
    { notification_id: 'notif_alex_04', type: 'assistant_task_completed', title: 'Clerk answered', body: 'Your Clerk task about cases waiting for a decision is done.', read: true, created_at: iso(t(0, 2)) },
    { notification_id: 'notif_alex_05', type: 'case_done', title: 'Case completed', body: `${s.mob72.c.title} was merged and closed.`, case_id: s.mob72.c.case_id, read: true, created_at: iso(t(5, 20)) },
    { notification_id: 'notif_alex_06', type: 'case_approved', title: 'Case approved', body: `${s.pay131.c.title} received its second approval.`, case_id: s.pay131.c.case_id, read: true, created_at: iso(t(9, 20)) },
    { notification_id: 'notif_alex_07', type: 'changes_requested', title: 'Changes requested', body: `Robin requested changes on ${s.pay131.c.title}.`, case_id: s.pay131.c.case_id, read: true, created_at: iso(t(12, 20)) },
  ];
  for (const r of rows) out.notifications.push({ ...r, user_id: ALEX } satisfies Notification);
}

// ---------------------------------------------------------------------------
// Sessions (Mission Control), presence, workspace + intelligence events
// ---------------------------------------------------------------------------

function seedSessions(s: Story): void {
  const live = (
    id: string, agent: string, slug: string, branch: string, userId: string, startedAgo: number, lastSeenAgo: number,
  ): SessionRegistryEntry => ({
    session_id: id,
    agent_name: agent,
    repository: `${GITHUB}/${slug}`,
    branch,
    last_event_type: 'heartbeat',
    ended: false,
    first_seen_at: iso(startedAgo),
    last_seen_at: iso(lastSeenAgo),
    user_id: userId,
  });
  const ended = (
    id: string, agent: string, slug: string, branch: string, userId: string, startedAgo: number, lastSeenAgo: number,
  ): SessionRegistryEntry => ({
    ...live(id, agent, slug, branch, userId, startedAgo, lastSeenAgo),
    last_event_type: 'session_end',
    ended: true,
  });

  out.sessions.push(
    // Live: heartbeats within the last two minutes.
    live('3c1f7a52-claude-pay153', 'claude-code', PAYMENTS.repo.slug, 'fix/tax-rounding', SAM, t(0, 1, 25), 25_000),
    live('b84e0d19-cursor-wishlist', 'cursor', STOREFRONT.repo.slug, 'feat/wishlist-sharing', ROBIN, t(0, 1, 5), 50_000),
    live('9d2a6b70-codex-main', 'codex', MOBILE.repo.slug, 'main', ALEX, t(0, 0, 40), 80_000),
    // Ended: history for the 24h / 7d / 30d activity panel.
    ended('5e7b1c33-claude-web211', 'claude-code', STOREFRONT.repo.slug, 'fix/cart-quantity-persist', SAM, t(0, 4), t(0, 3)),
    ended('a06d93f4-cursor-pay142', 'cursor', PAYMENTS.repo.slug, 'feat/webhook-retry-backoff', ROBIN, t(0, 10), t(0, 9)),
    ended('d17c48aa-claude-pay131', 'claude-code', PAYMENTS.repo.slug, 'feat/refund-idempotency', ALEX, t(2, 3), t(2, 2)),
    ended('61f3e9c2-cursor-web204', 'cursor', STOREFRONT.repo.slug, 'feat/rich-text-descriptions', SAM, t(3, 5), t(3, 3)),
    ended('f89a2d05-codex-mob72', 'codex', MOBILE.repo.slug, 'fix/push-deeplink-crash', ALEX, t(4, 2), t(4, 1)),
    ended('2b5c70e8-claude-pay158', 'claude-code', PAYMENTS.repo.slug, 'fix/mask-pan-in-errors', SAM, t(6, 2), t(6, 1)),
    ended('c4e81b96-cursor-web198', 'cursor', STOREFRONT.repo.slug, 'feat/checkout-address-autocomplete', ROBIN, t(9, 3), t(9, 1)),
    ended('0a37d6f1-codex-obs2', 'codex', MOBILE.repo.slug, 'fix/locale-fallback', ALEX, t(12, 4), t(12, 3)),
    ended('e92f4a07-claude-web190', 'claude-code', STOREFRONT.repo.slug, 'feat/client-side-totals', SAM, t(16, 2), t(16, 1)),
    ended('7b60c1d3-cursor-pay118', 'cursor', PAYMENTS.repo.slug, 'fix/charge-currency-validation', SAM, t(21, 3), t(21, 2)),
    ended('38d5e2b9-claude-mob', 'claude-code', MOBILE.repo.slug, 'feat/offline-order-queue', ALEX, t(27, 5), t(27, 3)),
  );

  const presence = (c: CaseCtx, userId: string, display: string, firstAgo: number, lastAgo: number): AgentPresence => ({
    presence_id: `${c.c.case_id}__${userId}`,
    case_id: c.c.case_id,
    actor_user_id: userId,
    actor_display: display,
    source: 'ide_agent',
    first_seen_at: iso(firstAgo),
    last_seen_at: iso(lastAgo),
  });
  out.agentPresence.push(
    presence(s.pay153, SAM, 'Sam Example', t(0, 1, 25), 25_000),
    presence(s.obs1, ROBIN, 'Robin Example', t(0, 1, 5), 50_000),
    presence(s.mob77, ALEX, 'Alex Example', t(0, 1, 30), 70_000),
  );
}

const INTEL_ACTOR = 'system:arbitra-intelligence';
const INTEL_META = { client_name: 'arbitra-intelligence', client_version: '1.0.0' } satisfies ActorMetadata;
const DETECTORS = [
  'aging-pending-merge', 'stale-open', 'orphan-branch', 'repeated-rework', 'high-risk-without-four-eyes', 'incomplete-repo-setup',
] as const;

function seedIntelligence(): void {
  // Eight scheduler runs, six hours apart. The oldest flagged three things,
  // a later one flagged PAY-131 once it crossed the 7-day threshold; the rest
  // found nothing new (everything else is deduplicated).
  const newFindings: Record<number, Partial<Record<(typeof DETECTORS)[number], number>>> = {
    7: { 'stale-open': 1, 'orphan-branch': 1, 'incomplete-repo-setup': 1 },
    5: { 'aging-pending-merge': 1 },
  };
  for (let k = 0; k < 8; k += 1) {
    const startedAgo = t(0, 0, 35) + k * 6 * HOUR;
    const found = newFindings[k] ?? {};
    const summaries: DetectorRunSummary[] = DETECTORS.map((id, idx) => ({
      detector_id: id,
      enabled: true,
      finding_count: found[id] ?? 0,
      duration_ms: 70 + ((k * 31 + idx * 47) % 260),
    }));
    const total = summaries.reduce((acc, x) => acc + x.finding_count, 0);
    const duration = summaries.reduce((acc, x) => acc + x.duration_ms, 0) + 40;
    const runId = `irun_demo_${pad(8 - k)}`;
    out.intelligenceRuns.push({
      run_id: runId,
      started_at: iso(startedAgo),
      finished_at: iso(startedAgo - duration),
      duration_ms: duration,
      trigger: 'scheduler',
      detector_count: DETECTORS.length,
      findings_total: total,
      summaries,
    } satisfies IntelligenceRun);
    out.workspaceEvents.push({
      event_id: `wse_intel_run_${pad(8 - k)}`,
      type: 'intelligence_run',
      actor_user_id: INTEL_ACTOR,
      actor_metadata: INTEL_META,
      timestamp: iso(startedAgo - duration),
      summary:
        `Ran ${DETECTORS.length} detectors — ${total} new nudge${total === 1 ? '' : 's'}, ` +
        `${k === 7 ? 0 : k >= 5 ? 3 : 4} deduped, 0 errors (duration ${duration}ms)`,
      evidence: { run_id: runId, cases_created: total, errors: 0, duration_ms: duration },
    } satisfies WorkspaceEvent);
  }

  // Branch- and project-targeted detections become workspace nudges.
  const orphanSig = buildSignature('orphan-branch', 'branch', `${PAYMENTS.repo.id}:feat/legacy-3ds-experiment`);
  out.workspaceEvents.push({
    event_id: 'wse_nudge_orphan_branch',
    type: 'intelligence_nudge',
    actor_user_id: INTEL_ACTOR,
    actor_metadata: INTEL_META,
    timestamp: iso(t(1, 18, 35)),
    summary: 'Unlinked branch (41d stale): feat/legacy-3ds-experiment',
    evidence: {
      detector_id: 'orphan-branch', signature: orphanSig, severity: 'low',
      summary: 'Branch `feat/legacy-3ds-experiment` in payments-api has no commit newer than 41d (threshold: 30d) and no active case references it. Archive the branch or open a case to cover the work.',
      target_kind: 'branch', target_id: `${PAYMENTS.repo.id}:feat/legacy-3ds-experiment`,
      project_id: PAYMENTS.id, repository_id: PAYMENTS.repo.id,
      repository_name: PAYMENTS.repo.name, branch: 'feat/legacy-3ds-experiment',
      last_commit_at: iso(t(41)), days_stale: 41, threshold_days: 30,
    },
  } satisfies WorkspaceEvent);
  const setupSig = buildSignature('incomplete-repo-setup', 'project', `${MOBILE.repo.id}:no-webhook`);
  out.workspaceEvents.push({
    event_id: 'wse_nudge_mobile_webhook',
    type: 'intelligence_nudge',
    actor_user_id: INTEL_ACTOR,
    actor_metadata: INTEL_META,
    timestamp: iso(t(1, 18, 35)),
    summary: `[${MOBILE.name}] Webhook not receiving signed events — ${MOBILE.repo.name}`,
    evidence: {
      detector_id: 'incomplete-repo-setup', signature: setupSig, severity: 'medium',
      summary: 'The GitHub webhook for `mobile-app` has never delivered a signed event to Arbitra. This usually means the webhook is not installed or has no secret configured.',
      target_kind: 'project', target_id: MOBILE.id, project_id: MOBILE.id, repository_id: MOBILE.repo.id,
      repository_name: MOBILE.repo.name, repository_url: `${GITHUB}/${MOBILE.repo.slug}`, issue: 'no_signed_webhook_event',
    },
  } satisfies WorkspaceEvent);

  out.workspaceEvents.push({
    event_id: 'wse_unlinked_pr_325',
    type: 'unlinked_pull_request',
    actor_user_id: 'system:arbitra-webhook',
    timestamp: iso(t(0, 5)),
    summary: 'Pull request opened without linked Arbitra case: acme/storefront#325 "Add gift-card balance lookup"',
    evidence: {
      pr_url: `${GITHUB}/acme/storefront/pull/325`, pr_number: 325, title: 'Add gift-card balance lookup',
      branch: 'feat/gift-card-balance', repository: STOREFRONT.repo.slug,
      github_repository_id: STOREFRONT.repo.githubId, arbitra_repository_id: STOREFRONT.repo.id,
      reason: 'No existing case matched by branch-name case id, PR text case id, or branch within the resolved repository.',
      hint: 'Create an Arbitra case explicitly or add an existing case id to the branch name or PR body, then reopen/synchronize the PR so Arbitra can link it.',
    },
  } satisfies WorkspaceEvent);
}

// ---------------------------------------------------------------------------
// Clerk: Alex's private assistant project, one finished task, one scheduled task
// ---------------------------------------------------------------------------

async function seedClerk(s: Story): Promise<{ storage: string }> {
  const ids = clerkCoreIds(ALEX);
  const created = iso(t(20));
  out.projects.push(buildClerkProject(ids, ALEX, created));
  out.repositories.push(buildClerkRepository(ids, created));
  out.evidencePolicies.push(buildClerkEvidencePolicy(ids, created));

  // Answers live in object storage; use whatever backend the app will read from.
  // The Next.js server (cwd packages/frontend) reads the local default `.arbitra-storage/`;
  // `npm run seed` runs from the repo root (its --env-file path is root-relative).
  // A bucket is only written through the storage emulator, never a real bucket.
  const localDir = process.env['ARBITRA_STORAGE_PATH']
    ?? join(process.cwd(), 'packages', 'frontend', '.arbitra-storage');
  const storage = process.env['GCS_BUCKET'] ? getArtifactStorage() : new LocalStorageAdapter(localDir);
  const storageLabel = process.env['GCS_BUCKET'] ? `bucket ${process.env['GCS_BUCKET']} (storage emulator)` : localDir;

  out.knowledgeAssets.push({
    knowledge_id: 'ka_clerk_team_roster',
    type: 'clerk_context',
    title: 'Team roster',
    summary: 'Who is on the team and what they own.',
    body: 'Alex Example: admin, owns the Payments API backlog.\nSam Example: reviewer for Payments API and Web Storefront.\nRobin Example: tech lead, approves high- and critical-risk changes.',
    scope_type: 'project',
    scope_ref: ids.projectId,
    status: 'suggested',
    version: 1,
    trust_level: 0,
    source_case_refs: [],
    source_decision_refs: [],
    tags: [],
    artifact_refs: [],
    created_by: ALEX,
    always_inject: true,
    created_at: created,
    updated_at: created,
  } satisfies KnowledgeAsset);

  const blueprint: TaskBlueprint = {
    blueprint_id: 'bp_demo_daily_digest',
    owner_user_id: ALEX,
    project_id: ids.projectId,
    name: 'Daily review-queue digest',
    description: 'Every morning: what is waiting for a person, and what has been idle for too long.',
    prompt_text: 'Summarize which cases are waiting for a human (decision, manual verification, merge) and which have had no activity for more than a week. Group by project and keep it short.',
    cron_schedule: '0 8 * * *',
    timezone: 'UTC',
    enabled: true,
    archived_at: null,
    version: 2,
    overlap_policy: 'skip',
    missed_run_policy: 'skip',
    created_at: iso(t(14)),
    updated_at: iso(t(9)),
  } satisfies TaskBlueprint;
  out.taskBlueprints.push(blueprint);

  // Most recent 08:00 UTC occurrence of the blueprint's schedule.
  const occurrence = new Date(NOW);
  occurrence.setUTCHours(8, 0, 0, 0);
  if (occurrence.getTime() > NOW) occurrence.setUTCDate(occurrence.getUTCDate() - 1);
  const occurrenceAgo = NOW - occurrence.getTime();

  const tasks = [
    {
      key: 'clerk1',
      caseId: 'case-clear-queue-a1Bc',
      text: 'Which cases are waiting for a human decision right now, and what is blocking each one?',
      startedAgo: t(0, 2),
      blueprint: false,
      answer: [
        'Two cases are waiting for a human decision.',
        '',
        `**${s.pay142.c.title}** (Payments API, high risk)`,
        '- Blocked by one open high-severity finding: retry counters are kept in memory and reset on restart.',
        '- One medium finding has an agent-proposed waiver that a person still has to confirm.',
        '- Evidence is complete (build, tests, runtime verification).',
        '',
        `**${s.web204.c.title}** (Web Storefront, medium risk)`,
        '- Blocked by one open high-severity finding: product HTML is rendered without sanitization.',
        '- No reviewer is assigned yet.',
        '',
        'Two more cases are waiting on people, but not for a decision: "Verify checkout address autocomplete on Safari" needs a manual confirmation, and "Mask card numbers in error logs" is waiting for its merge gate to be confirmed.',
      ].join('\n'),
      calls: [
        { name: 'arbitra_search_cases', params: { status: 'needs_human_decision', limit: 20 }, result_bytes: 2284, duration_ms: 142 },
        { name: 'arbitra_get_case', params: { case_id: s.pay142.c.case_id }, result_bytes: 6120, duration_ms: 188 },
        { name: 'arbitra_get_case', params: { case_id: s.web204.c.case_id }, result_bytes: 4310, duration_ms: 171 },
        { name: 'arbitra_search_cases', params: { status: 'verification_pending', limit: 20 }, result_bytes: 1190, duration_ms: 126 },
      ],
      usage: { input_tokens: 9840, output_tokens: 612, total_tokens: 10452 },
    },
    {
      key: 'clerk2',
      caseId: 'case-daily-digest-a2Bd',
      text: blueprint.prompt_text,
      startedAgo: occurrenceAgo,
      blueprint: true,
      answer: [
        '**Review-queue digest**',
        '',
        '*Waiting on people*',
        '- Web Storefront: "Verify checkout address autocomplete on Safari" still needs a manual confirmation and has been waiting for several days.',
        '',
        '*Aging*',
        '- Payments API: "Idempotency keys for the refund endpoint" is approved and has waited in pending merge for more than a week.',
        '- Payments API: "Replace the deprecated payment-intent client" has had no activity for more than a week.',
      ].join('\n'),
      calls: [
        { name: 'arbitra_search_cases', params: { status: 'verification_pending', limit: 20 }, result_bytes: 1190, duration_ms: 131 },
        { name: 'arbitra_search_cases', params: { status: 'pending_merge', limit: 20 }, result_bytes: 1744, duration_ms: 150 },
        { name: 'arbitra_search_cases', params: { status: 'open', limit: 20 }, result_bytes: 980, duration_ms: 119 },
      ],
      usage: { input_tokens: 7210, output_tokens: 418, total_tokens: 7628 },
    },
  ] as const;

  for (const task of tasks) {
    const key = task.key;
    const runId = `run_${key}_01`;
    const artifactId = `art_${key}_result`;
    const evidenceId = `ev_${key}_01`;
    const started = task.startedAgo;
    const finished = started - 24_000;
    const title = deriveAssistantTaskTitle(task.text);
    const idempotencyKey = task.blueprint
      ? buildBlueprintOccurrenceIdempotencyKey(blueprint.blueprint_id, blueprint.version, occurrence.toISOString())
      : '';
    const channel = task.blueprint ? 'blueprint' : 'web';

    const caseDoc: Case = {
      case_id: task.caseId,
      title,
      description: task.text,
      source_type: 'manual',
      source_ref: idempotencyKey,
      project_id: ids.projectId,
      repository_id: ids.repositoryId,
      owner_user_id: ALEX,
      status: 'done',
      validation_track: 'direct',
      risk_level: 'low',
      priority: 'normal',
      case_type: 'assistant_task',
      assistant_context: {
        channel,
        conversation_visibility: 'direct',
        requester_user_id: ALEX,
        risk_level: 'low',
        policy_version: 'assistant_policy:v1',
        prompt_version: 'assistant_task:v1',
        task_kind: 'arbitra_data_question',
        reads_withheld: false,
        ...(task.blueprint && {
          blueprint_id: blueprint.blueprint_id,
          blueprint_context: {
            blueprint_id: blueprint.blueprint_id,
            blueprint_version: blueprint.version,
            prompt_text: blueprint.prompt_text,
          },
        }),
      },
      jira_refs: [],
      active_rule_set_refs: [],
      knowledge_context_refs: [],
      decision_ready: true,
      created_at: iso(started + 3000),
      updated_at: iso(finished),
      deleted_at: null,
      deleted_by: null,
    };
    out.cases.push(caseDoc);

    const policy = decideAssistantPolicy(caseDoc);
    const result = {
      schema: 'arbitra.assistant_task_result/v2',
      case_id: task.caseId,
      run_id: runId,
      attempt: 1,
      requester_user_id: ALEX,
      task_kind: policy.task_kind,
      assistant_tool_policy: policy,
      policy_version: 'assistant_policy:v1',
      prompt_version: 'assistant_task:v1',
      model: REVIEW_MODEL,
      answer: task.answer,
      as_of: iso(started),
      answer_retried: false,
      reads_withheld: false,
      reads_withheld_reason: null,
      tools_enabled: policy.enabled_tools,
      tool_calls: task.calls.map((c) => ({ ...c, outcome: 'ok' })),
      injected_context: [],
      steps: task.calls.length + 1,
      finish_reason: 'stop',
      usage: task.usage,
      duration_ms: 24_000,
      created_at: iso(finished),
    };
    const serialised = JSON.stringify(result, null, 2);
    const base64 = Buffer.from(serialised, 'utf-8').toString('base64');

    // One blob per answer: replace the previous one on a re-run so repeated seeding leaves nothing behind.
    const filename = `assistant-task-result-${runId}.json`;
    const prior = (await collections.artifacts().doc(artifactId).get()).data();
    if (prior) await storage.delete(prior.storage_path);
    const storagePath = await storage.save(filename, 'application/json', base64);
    parseAssistantTaskResult(`data:application/json;base64,${base64}`); // fails loudly if the schema moves

    out.artifacts.push({
      artifact_id: artifactId,
      case_id: task.caseId,
      run_id: runId,
      filename,
      content_type: 'application/json',
      storage_path: storagePath,
      size_bytes: Buffer.byteLength(serialised, 'utf-8'),
      created_by: 'system:clerk',
      created_at: iso(finished),
    } satisfies Artifact);

    out.runs.push({
      run_id: runId,
      case_id: task.caseId,
      run_type: 'assistant_task_run',
      trigger_source: `assistant-intake:${channel}`,
      status: 'completed',
      started_at: iso(started),
      finished_at: iso(finished),
      input_refs: [],
      output_refs: [artifactId],
      summary: `Assistant task answered (${task.calls.length} tool call(s)): ${task.answer.split('\n')[0]}`,
      token_usage: {
        prompt_tokens: task.usage.input_tokens,
        completion_tokens: task.usage.output_tokens,
        total_tokens: task.usage.total_tokens,
        model: REVIEW_MODEL,
      },
      prompt_version: 'assistant_task:v1',
      attempt: 1,
      assistant_policy_state: 'bound',
      assistant_tool_policy: policy,
      created_at: iso(started + 3000),
      updated_at: iso(finished),
    } satisfies Run);

    out.evidence.push({
      evidence_id: evidenceId,
      case_id: task.caseId,
      run_id: runId,
      type: 'task_result',
      source_type: 'automated',
      artifact_ref: artifactId,
      summary: task.answer.split('\n')[0] ?? '',
      machine_readable: true,
      validation_track: 'direct',
      created_at: iso(finished),
      created_by: 'system:clerk',
    } satisfies Evidence);

    const ev = (seq: number, type: string, ago: number, actor: string, payload: Record<string, unknown>): void => {
      out.caseEvents.push({
        event_id: `evt_${key}_${pad(seq)}`,
        case_id: task.caseId,
        type,
        actor_id: actor,
        payload,
        created_at: iso(ago),
      } satisfies CaseEvent);
    };
    ev(1, 'assistant_task_received', started + 3000, ALEX, { channel, requester_user_id: ALEX, project_id: ids.projectId, repository_id: ids.repositoryId, run_id: runId, input_chars: task.text.length, policy_version: 'assistant_policy:v1', prompt_version: 'assistant_task:v1' });
    ev(2, 'assistant_task_started', started + 1000, 'system:clerk', { from_status: 'open', to_status: 'in_build', run_id: runId });
    ev(3, 'run_completed', finished, 'system:clerk', { run_id: runId, run_type: 'assistant_task_run', attempt: 1, artifact_id: artifactId, evidence_id: evidenceId, task_kind: policy.task_kind, steps: task.calls.length + 1, model: REVIEW_MODEL, input_tokens: task.usage.input_tokens, output_tokens: task.usage.output_tokens, answer_chars: task.answer.length, reads_withheld: false, duration_ms: 24_000 });
    ev(4, 'assistant_task_completed', finished, 'system:clerk', { from_status: 'in_build', to_status: 'done', run_id: runId, attempt: 1, reads_withheld: false });
    ev(5, 'case_completed', finished, 'system:clerk', { from_status: 'in_build', to_status: 'done' });

    if (task.blueprint) {
      out.assistantIntakeReceipts.push({
        receipt_id: assistantIntakeReceiptId('blueprint', ALEX, idempotencyKey),
        channel: 'blueprint',
        requester_user_id: ALEX,
        idempotency_key: idempotencyKey,
        case_id: task.caseId,
        run_id: runId,
        event_id: `evt_${key}_01`,
        created_at: iso(started + 3000),
        expires_at: new Date(Date.parse(iso(started + 3000)) + 30 * DAY).toISOString(),
      } satisfies AssistantIntakeReceipt);
    }
  }

  return { storage: storageLabel };
}

// ---------------------------------------------------------------------------
// Auth emulator accounts
// ---------------------------------------------------------------------------

async function seedAuthUsers(): Promise<void> {
  const auth = getAuth(getFirebaseApp());
  // importUsers refuses to overwrite an existing uid, so drop first (idempotent re-runs).
  await auth.deleteUsers(PEOPLE.map((p) => p.id));
  const res = await auth.importUsers(
    PEOPLE.map((p) => ({
      uid: p.id,
      email: p.email,
      emailVerified: true,
      displayName: p.name,
      // The emulator's Google popup lists accounts that carry a google.com provider.
      providerData: [{ uid: `google-${p.id}`, providerId: 'google.com', email: p.email, displayName: p.name }],
    })),
  );
  if (res.failureCount > 0) {
    throw new Error(`Auth import failed: ${res.errors.map((e) => e.error.message).join('; ')}`);
  }
}

// ---------------------------------------------------------------------------
// Write everything
// ---------------------------------------------------------------------------

interface Target {
  name: string;
  count: number;
  col: FirebaseFirestore.CollectionReference;
  write: (writer: FirebaseFirestore.BulkWriter) => void;
}

function target<T>(
  name: string,
  col: FirebaseFirestore.CollectionReference<T>,
  rows: readonly T[],
  id: (row: T) => string,
): Target {
  if (new Set(rows.map(id)).size !== rows.length) {
    throw new Error(`Seed bug: duplicate document ids in '${name}'`);
  }
  return {
    name,
    count: rows.length,
    col: col as unknown as FirebaseFirestore.CollectionReference,
    write: (writer) => {
      for (const row of rows) writer.set(col.doc(id(row)), row).catch(() => undefined);
    },
  };
}

function targets(): Target[] {
  return [
    target('users', collections.users(), out.users, (r) => r.user_id),
    target('projects', collections.projects(), out.projects, (r) => r.project_id),
    target('repositories', collections.repositories(), out.repositories, (r) => r.repository_id),
    target('evidence_policies', collections.evidencePolicies(), out.evidencePolicies, (r) => r.policy_id),
    target('rules', collections.rules(), out.rules, (r) => r.rule_id),
    target('rule_sets', collections.ruleSets(), out.ruleSets, (r) => r.rule_set_id),
    target('cases', collections.cases(), out.cases, (r) => r.case_id),
    target('case_events', collections.caseEvents(), out.caseEvents, (r) => r.event_id),
    target('runs', collections.runs(), out.runs, (r) => r.run_id),
    target('findings', collections.findings(), out.findings, (r) => r.finding_id),
    target('evidence', collections.evidence(), out.evidence, (r) => r.evidence_id),
    target('decisions', collections.decisions(), out.decisions, (r) => r.decision_id),
    target('comments', collections.comments(), out.comments, (r) => r.comment_id),
    target('rule_results', collections.ruleResults(), out.ruleResults, (r) => r.rule_result_id),
    target('knowledge_assets', collections.knowledgeAssets(), out.knowledgeAssets, (r) => r.knowledge_id),
    target('notifications', collections.notifications(), out.notifications, (r) => r.notification_id),
    target('workspace_events', collections.workspaceEvents(), out.workspaceEvents, (r) => r.event_id),
    target('intelligence_runs', collections.intelligenceRuns(), out.intelligenceRuns, (r) => r.run_id),
    target('agent_presence', collections.agentPresence(), out.agentPresence, (r) => r.presence_id),
    target('sessions', collections.sessions(), out.sessions, (r) => r.session_id),
    target('observed_case_claims', collections.observedCaseClaims(), out.observedCaseClaims.map((c) => c.doc), (r) => observedCaseClaimDocId(r.repository_id, r.branch)),
    target('artifacts', collections.artifacts(), out.artifacts, (r) => r.artifact_id),
    target('task_blueprints', collections.taskBlueprints(), out.taskBlueprints, (r) => r.blueprint_id),
    target('assistant_intake_receipts', collections.assistantIntakeReceipts(), out.assistantIntakeReceipts, (r) => r.receipt_id),
  ];
}

async function main(): Promise<void> {
  requireEmulators();
  await loadWorkspacePackages();
  const reset = process.argv.includes('--reset');
  getFirebaseApp();
  const db = getDb();
  console.log(
    `Seeding demo data into the emulators (project ${process.env['GOOGLE_CLOUD_PROJECT'] ?? 'demo-arbitra'}, ` +
      `Firestore ${process.env['FIRESTORE_EMULATOR_HOST']}, Auth ${process.env['FIREBASE_AUTH_EMULATOR_HOST']})\n`,
  );

  seedWorkspace();
  const story = seedCases();
  seedKnowledge(story);
  seedNotifications(story);
  seedSessions(story);
  seedIntelligence();
  const clerk = await seedClerk(story);

  const all = targets();
  if (reset) {
    console.log('--reset: deleting every collection this script writes to ...');
    for (const target of all) await db.recursiveDelete(target.col);
  }

  await seedAuthUsers();

  const writer = db.bulkWriter();
  let failed = 0;
  writer.onWriteError((err) => {
    failed += 1;
    console.error(`Write failed for ${err.documentRef.path}: ${err.message}`);
    return false;
  });
  for (const target of all) target.write(writer);
  await writer.close();
  if (failed > 0) throw new Error(`${failed} document write(s) failed`);

  console.log('Collection'.padEnd(28) + 'Documents');
  for (const target of all) console.log(`  ${target.name.padEnd(26)}${target.count}`);
  console.log(`\nAuth emulator accounts: ${PEOPLE.map((p) => `${p.name} <${p.email}>`).join(', ')}`);
  console.log(`Clerk answers stored in: ${clerk.storage}`);
  console.log('\nDone. Open http://localhost:3000 and sign in with Alex Example (Google popup, pick the existing account).');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
