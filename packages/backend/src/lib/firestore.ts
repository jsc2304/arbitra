import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { getFirebaseApp } from './firebase.js';
import type {
  Case, CaseEvent, Run, Finding, Comment, Evidence,
  EvidencePolicy, Rule, RuleSet, RuleResult, RuleOverride,
  KnowledgeAsset, Decision, Artifact, Project, Repository,
  User, Notification, PersonalAccessToken, CaseTemplate,
  LlmSettings, PromptTemplate, WorkspaceEvent, WorkspaceEventDismissal,
  IntelligenceRun, DetectorConfigMap,
  HelperBotLog,
  AgentPresence,
  DeviceCode,
  AssistantIntakeReceipt,
  AssistantFeedback,
  TaskBlueprint,
  ChatThreadLink,
  SessionSignalEventReceipt,
  SessionRegistryEntry,
  ObservedCaseClaim,
} from '@arbitra/shared';

let db: Firestore;

export function getDb(): Firestore {
  if (db) return db;
  const databaseId = process.env['FIRESTORE_DATABASE_ID'];
  if (databaseId) {
    db = getFirestore(getFirebaseApp(), databaseId);
  } else {
    db = getFirestore(getFirebaseApp());
  }
  db.settings({ ignoreUndefinedProperties: true });
  return db;
}

type TypedCollection<T> = FirebaseFirestore.CollectionReference<T>;

function collection<T>(name: string): TypedCollection<T> {
  return getDb().collection(name) as TypedCollection<T>;
}

export const collections = {
  cases: () => collection<Case>('cases'),
  /**
   * `cases` pre-filtered to `deleted_at == null`. Use this for every
   * read path that should NOT see soft-deleted tombstones (list views,
   * search, activity feeds, intelligence scans, webhook lookups, etc.).
   *
   * Returns a `Query<Case>` rather than a `CollectionReference<Case>`:
   * you can chain `.where()` / `.orderBy()` / `.limit()` as with the
   * raw collection, but you cannot `.doc(id)` on a query — for direct
   * document reads go through `CaseRepository.getById` (which already
   * applies the soft-delete filter), or use the raw `collections.cases()`
   * for admin/audit paths and the soft-delete write itself.
   */
  activeCases: (): FirebaseFirestore.Query<Case> =>
    collection<Case>('cases').where('deleted_at', '==', null),
  caseEvents: () => collection<CaseEvent>('case_events'),
  runs: () => collection<Run>('runs'),
  findings: () => collection<Finding>('findings'),
  comments: () => collection<Comment>('comments'),
  rawReviewObservations: () => collection<Record<string, unknown>>('raw_review_observations'),
  ruleSets: () => collection<RuleSet>('rule_sets'),
  rules: () => collection<Rule>('rules'),
  ruleResults: () => collection<RuleResult>('rule_results'),
  evidence: () => collection<Evidence>('evidence'),
  evidencePolicies: () => collection<EvidencePolicy>('evidence_policies'),
  knowledgeAssets: () => collection<KnowledgeAsset>('knowledge_assets'),
  ruleOverrides: () => collection<RuleOverride>('rule_overrides'),
  decisions: () => collection<Decision>('decisions'),
  artifacts: () => collection<Artifact>('artifacts'),
  projects: () => collection<Project>('projects'),
  repositories: () => collection<Repository>('repositories'),
  users: () => collection<User>('users'),
  notifications: () => collection<Notification>('notifications'),
  tokens: () => collection<PersonalAccessToken>('tokens'),
  caseTemplates: () => collection<CaseTemplate>('case_templates'),
  settingsLlm: () => collection<LlmSettings>('settings').doc('llm'),
  promptTemplates: () => collection<PromptTemplate>('prompt_templates'),
  workspaceEvents: () => collection<WorkspaceEvent>('workspace_events'),
  /**
   * Per-user dismissals of workspace events. Doc id is
   * `${user_id}_${event_id}`. A dismissal hides the row from the activity
   * feed for that user only — the canonical WorkspaceEvent is untouched.
   */
  workspaceEventDismissals: () =>
    collection<WorkspaceEventDismissal>('workspace_event_dismissals'),
  /**
   * History of every intelligence run (scheduler + admin manual). One doc
   * per run keyed by `run_id`. Queried by `started_at DESC` from the
   * observatory UI (PR 5). The `started_at DESC` index is NOT added in this
   * PR — add it to `firestore.indexes.json` when the UI ships.
   */
  intelligenceRuns: () => collection<IntelligenceRun>('intelligence_runs'),
  /**
   * Single-document collection holding per-detector runtime config. The
   * `detectors` doc stores the whole `DetectorConfigMap` — a single read
   * gets every detector's enable flag. Missing doc = all detectors enabled.
   */
  intelligenceConfig: () => collection<DetectorConfigMap>('intelligence_config'),
  /**
   * Per-call log of Arbitra Helper bot invocations (one doc per `ask`).
   * Stores question + answer preview + latency + token usage. Used for
   * observability and abuse review; not surfaced to end users.
   */
  helperBotLogs: () => collection<HelperBotLog>('helper_bot_logs'),
  /**
   * Live presence heartbeats from IDE agents (Cursor, Claude Code, Codex) and
   * other lightweight surfaces. One doc per (case, actor) pair, keyed by
   * `${case_id}__${actor_user_id}`. Read with a `last_seen_at >= cutoff`
   * window — there is no TTL index, stale rows are filtered in JS.
   */
  agentPresence: () => collection<AgentPresence>('agent_presence'),
  /**
   * RFC 8628 device-flow grants. Doc id = `sha256(device_code)` (hex); the
   * raw `device_code` is never persisted. Cleaned by Firestore TTL on
   * `expires_at` (configured manually).
   * See `docs/specs/device-flow-and-per-tool-tokens.md` §C.2.
   */
  deviceCodes: () => collection<DeviceCode>('device_codes'),
  /**
   * Idempotency receipts for accepted assistant-task intakes. Doc id is
   * derived from (channel, requester, caller key) via
   * `assistantIntakeReceiptId` — never queried, always computed — which is what
   * lets `AssistantIntakeService` re-check the receipt INSIDE its write
   * transaction and so guarantee at most one case per key. Retention is
   * expressed in `expires_at`; the Firestore TTL policy for it must be
   * configured manually (see `device_codes`).
   */
  assistantIntakeReceipts: () =>
    collection<AssistantIntakeReceipt>('assistant_intake_receipts'),
  /** Current requester judgement for one immutable completed Clerk result. */
  assistantFeedback: () => collection<AssistantFeedback>('assistant_feedback'),
  /**
   * Versioned, user-owned recurring-task definitions
   * (`docs/specs/clerk-config-scheduling-chat.md` Slice B, #793). Generated
   * id (`bp_...`, `generateId('taskBlueprint')`) — a blueprint has no natural
   * deterministic key. Owner-scoped by
   * `owner_user_id`; every occurrence it produces is a normal `assistant_task`
   * Case whose `assistant_context.blueprint_id` (flat, queryable — see
   * `AssistantContext` in `../../shared/src/types/case.ts`) points back here
   * for the overlap-'skip' check. Version is bumped in place on every edit —
   * this row is never itself versioned/historized; the Case snapshot
   * (`assistant_context.blueprint_context`) is the historical record.
   */
  taskBlueprints: () => collection<TaskBlueprint>('task_blueprints'),
  /**
   * Per-IP sliding-window counters for unauthenticated rate-limited
   * endpoints (currently `/api/auth/connect/init`). Doc id =
   * `sha256(ip)`. TTL'd after 1h via Firestore TTL on `expires_at`.
   */
  authRateLimits: () => collection<{
    /** sha256 hex of the caller IP. Stored as the doc id; mirrored here for human debugging. */
    ip_hash: string;
    /** ISO timestamps of recent requests within the sliding window. Trimmed on every write. */
    request_timestamps: string[];
    /** ISO timestamp `created_at + 1h`. Firestore TTL policy keys off this field. */
    expires_at: string;
    created_at: string;
    updated_at: string;
  }>('auth_rate_limits'),
  /**
   * Mutable per-thread pointer to the current tip Case of a Google Chat
   * thread (Slice F inbound, `docs/specs/clerk-config-scheduling-chat.md`).
   * Doc id is derived from `thread_name` alone via `chatThreadLinkId` — never
   * queried, always computed, same lookup-by-id discipline as
   * `assistantIntakeReceipts` above. Unlike that collection this one IS
   * overwritten on every genuinely new turn: it is a routing hint deciding
   * root-vs-follow-up, not the idempotency mechanism (that is the message-
   * name-keyed `AssistantIntakeReceipt`). See `ChatThreadLink`'s doc comment.
   */
  chatThreadLinks: () => collection<ChatThreadLink>('chat_thread_links'),
  /**
   * Idempotency receipts for ingested Session Signal events (issue #983 /
   * ADR-0001). Doc id is a deterministic sha256 hex of the client-supplied
   * `event_id`, computed by `sessionSignalEventDocId` — never queried,
   * only claimed via a transactional `create`, which is what makes
   * duplicate/out-of-order delivery of the same `event_id` a no-op instead
   * of a second session mutation. No TTL yet — same posture as
   * `assistantIntakeReceipts` before its retention field was added.
   */
  sessionSignalEvents: () => collection<SessionSignalEventReceipt>('session_signal_events'),
  /**
   * The session registry: one document per `session_id`, upserted by every
   * Session Signal event that carries it. `last_seen_at` is a server
   * receipt timestamp, not a client one — see `SessionRegistryEntry`. Read
   * with a liveness-window filter in JS (mirrors `agentPresence`); no TTL
   * index, since an ended/stale row is still useful history, not garbage.
   */
  sessions: () => collection<SessionRegistryEntry>('sessions'),
  /**
   * Atomic per-(repository, branch) claims for Observed Case creation
   * (issue #986). Doc id is a deterministic sha256 hex of
   * `repository_id` + `branch`, computed by `observedCaseClaimDocId` —
   * never queried, only claimed via a transactional `create`. Mirrors
   * `sessionSignalEvents`'s claim discipline: the loser of the `tx.create`
   * throw never writes a Case document, which is what makes concurrent
   * signals for the same unknown branch produce exactly one Observed Case.
   */
  observedCaseClaims: () => collection<ObservedCaseClaim>('observed_case_claims'),
} as const;
