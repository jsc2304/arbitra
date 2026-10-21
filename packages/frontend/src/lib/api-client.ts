'use client';

import type {
  Case,
  CreateCaseInput,
  UpdateCaseInput,
  CaseFilters,
  CaseExportFormat,
  Finding,
  Evidence,
  EvidencePolicy,
  Decision,
  Comment,
  CreateCommentInput,
  CaseEvent,
  Run,
  RuleSet,
  Rule,
  RuleStatus,
  RuleOverride,
  KnowledgeAsset,
  KnowledgeStatus,
  KnowledgeType,
  CreateKnowledgeAssetInput,
  UpdateKnowledgeAssetInput,
  NotificationPage,
  Artifact,
  SearchResponse,
  Project,
  Repository,
  PersonalAccessToken,
  User,
  ChatConversationWindow,
  CaseTemplate,
  CreateDecisionInput,
  LlmSettings,
  LlmProviderName,
  RiskLevel,
  ActivityEntry,
  ActivityLeaderboardRow,
  ActivityProjectLeaderboardRow,
  ActivityLeaderboardWindow,
  IntelligenceRun,
  DetectorConfig,
  WorkspaceEvent,
  AgentPresence,
  AssistantThreadResponse,
  AssistantFeedback,
  AssistantFeedbackRequest,
  AssistantFeedbackWriteResponse,
  TaskBlueprint,
  CreateTaskBlueprintInput,
  UpdateTaskBlueprintInput,
  MissionControlResponse,
} from '@arbitra/shared';

/**
 * Per-section result envelope for the `/api/dashboard` aggregate response.
 * Matches the shape produced by the server (see
 * `app/api/dashboard/route.ts`): on success `{ ok: true, data }`,
 * on failure `{ ok: false, error }`. One failing section never fails the
 * whole response.
 */
export type DashboardSectionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

export interface CasesListResponse {
  cases: Case[];
  cursor?: string;
  finding_counts?: Record<string, number>;
}

export interface ObservatoryResponse {
  summary: {
    total_cases: number;
    pending_reviews: number;
    approval_rate: number;
    avg_findings_per_case: number;
    total_findings: number;
    open_findings: number;
    total_knowledge_assets: number;
  };
  cases_by_status: Record<string, number>;
  risk_distribution: Record<string, number>;
  track_distribution: Record<string, number>;
  findings_by_severity: Record<string, number>;
  recent_activity: Array<{
    case_id: string;
    case_title: string;
    type: string;
    summary: string;
    created_at: string;
  }>;
  top_contributors: Array<{
    user_id: string;
    display_name: string;
    total_cases: number;
    approved_cases: number;
    approval_rate: number;
  }>;
  top_reviewers: Array<{
    user_id: string;
    display_name: string;
    cases_reviewed: number;
  }>;
  top_repositories: Array<{
    repository_id: string;
    name: string;
    project_name: string;
    total_cases: number;
    /** Terminal cases (approved + rejected + done) — denominator behind `approval_rate`. See #676. */
    decided_count: number;
    approval_rate: number;
  }>;
  top_projects: Array<{
    project_id: string;
    name: string;
    total_cases: number;
    team_size: number;
    /** Terminal cases (approved + rejected + done) — denominator behind `approval_rate`. See #676. */
    decided_count: number;
    approval_rate: number;
  }>;
  throughput_leaderboard: Array<{
    case_id: string;
    title: string;
    status: string;
    risk_level: string;
    duration_ms: number;
    is_completed: boolean;
  }>;
  top_referenced_assets: Array<{
    knowledge_id: string;
    title: string;
    type: KnowledgeType;
    status: KnowledgeStatus;
    reference_count: number;
  }>;
}

export async function getToken(): Promise<string | null> {
  try {
    const { getIdToken } = await import('./firebase-client');
    return await getIdToken();
  } catch {
    return null;
  }
}

export async function fetchApiRaw(
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const token = await getToken();

  const headers: Record<string, string> = {};
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(`/api${path}`, {
    ...options,
    headers: {
      ...headers,
      ...(options.headers as Record<string, string>),
    },
  });

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }

  return response;
}

export async function exportCase(
  caseId: string,
  format: CaseExportFormat,
): Promise<Response> {
  return fetchApiRaw(`/cases/${caseId}/export?format=${format}`);
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }

  return btoa(binary);
}

async function fetchApiDataUrl(path: string): Promise<string> {
  const response = await fetchApiRaw(path);
  const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
  const content = await response.arrayBuffer();
  return `data:${contentType};base64,${arrayBufferToBase64(content)}`;
}

/**
 * A rejected API call, carrying the machine-readable half of the error envelope
 * alongside the message.
 *
 * `message` is byte-identical to what `fetchApi` has always thrown, so callers
 * that only read `error.message` (that is: all of them today) are unaffected.
 * `code` and `details` exist for the callers that must ACT on a refusal rather
 * than print it — the assistant intake, whose 429 names the cases blocking the
 * user, and whose `CLERK_CORE_NOT_PROVISIONED` is a fixable state rather than a
 * failure.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function fetchApi<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const token = await getToken();

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(`/api${path}`, {
    ...options,
    headers: {
      ...headers,
      ...(options.headers as Record<string, string>),
    },
  });

  if (!response.ok) {
    // Error bodies are NOT guaranteed to be JSON: when Cloud Run itself
    // rejects the request (e.g. 429 "Rate exceeded." with all instance slots
    // saturated), the body is plain text and a blind
    // `response.json()` throws "Unexpected token 'R' ... is not valid JSON"
    // at the user. Read as text first, then try to parse our API's
    // `{ error: { message } }` envelope out of it.
    const raw = await response.text().catch(() => '');
    let isJson = false;
    let apiMessage: string | undefined;
    let apiCode: string | undefined;
    let apiDetails: Record<string, unknown> | undefined;
    try {
      const parsed = JSON.parse(raw) as {
        error?: { message?: string; code?: string; details?: Record<string, unknown> };
      };
      isJson = true;
      apiMessage = parsed?.error?.message;
      apiCode = parsed?.error?.code;
      apiDetails = parsed?.error?.details;
    } catch {
      // Not JSON — plain-text/HTML error body.
    }
    // JSON envelope with a message: surface it verbatim (existing contract).
    if (apiMessage) throw new ApiError(apiMessage, response.status, apiCode, apiDetails);
    // Plain-text body: keep a capped excerpt so the user sees
    // "Request failed (429): Rate exceeded." — never a parser error.
    // A JSON body WITHOUT a message (e.g. `{}`) degrades to the legacy
    // status-only shape other callers already match on.
    const detail = isJson ? '' : raw.trim().slice(0, 300);
    throw new ApiError(
      detail
        ? `Request failed (${response.status}): ${detail}`
        : `Request failed: ${response.status}`,
      response.status,
      apiCode,
      apiDetails,
    );
  }

  return response.json();
}

/** One of the signed-in user's Clerk tasks, as `GET /api/assistant/tasks` returns it. */
export interface AssistantTaskSummary {
  case_id: string;
  title: string;
  status: string;
  created_at: string;
  updated_at: string;
  /**
   * Present only on a follow-up case — the root is never carrying this field
   * (see `AssistantThreadLink` in `@arbitra/shared`). Just the one field the
   * task list needs to group a follow-up under its root; the route omits the
   * rest of `AssistantThreadLink` (`parent_case_id`, `prior_run_id`, ...) as
   * not needed here.
   */
  assistant_thread?: { root_case_id: string };
  /**
   * The blueprint that produced this occurrence (`assistant_context.blueprint_id`),
   * present only on a case created through the `blueprint` channel — see
   * `clerk-scheduled-panel.tsx`, which groups this list by this field to
   * render each blueprint's recent occurrences.
   */
  blueprint_id?: string;
  /**
   * The blueprint version effective when this occurrence was created
   * (`assistant_context.blueprint_context.blueprint_version`), NOT the
   * blueprint's current version — see that field's own doc comment in
   * `@arbitra/shared`'s `AssistantContext`.
   */
  blueprint_version?: number;
  /**
   * Set once the run finishes (`AssistantTaskExecutor`'s `done`-transition
   * write) — absent on a still-running occurrence, which is not the same as
   * `false`.
   */
  reads_withheld?: boolean;
}

export interface AssistantTaskCreated {
  case_id: string;
  run_id: string;
  status: string;
  replayed: boolean;
  share_url?: string;
}

export interface AssistantTaskCancelled {
  case_id: string;
  target_run_id: string;
  cancelled_run_ids: string[];
  pending_reconciliation_run_ids: string[];
  status: 'rejected';
  cancel_revision: number;
  requested_at: string;
  requested_by: string;
  replayed: boolean;
}

export const api = {
  artifacts: {
    content: (artifactId: string) =>
      fetchApiDataUrl(`/artifacts/${encodeURIComponent(artifactId)}/content`),
  },

  assistant: {
    /**
     * Submit one Clerk task. The route's schema is strict and web-facing: text
     * plus an optional idempotency key, nothing else — it supplies the channel
     * itself, so sending one is a 400.
     */
    createTask: (input: { text: string; idempotency_key?: string }) =>
      fetchApi<AssistantTaskCreated>('/assistant/tasks', {
        method: 'POST',
        body: JSON.stringify(input),
      }),

    /** The signed-in user's own recent Clerk tasks, newest first. */
    listTasks: (limit?: number) =>
      fetchApi<{ tasks: AssistantTaskSummary[] }>(
        `/assistant/tasks${limit ? `?limit=${limit}` : ''}`,
      ),

    /** Stop the exact active attempt displayed by the case page. */
    cancelTask: (caseId: string, runId: string) =>
      fetchApi<AssistantTaskCancelled>(
        `/assistant/tasks/${encodeURIComponent(caseId)}/cancel`,
        {
          method: 'POST',
          body: JSON.stringify({ run_id: runId }),
        },
      ),

    /** Create the next immutable Case in a completed Clerk conversation. */
    createFollowUp: (
      caseId: string,
      input: { text: string; idempotency_key: string },
    ) =>
      fetchApi<AssistantTaskCreated>(
        `/assistant/tasks/${encodeURIComponent(caseId)}/follow-ups`,
        { method: 'POST', body: JSON.stringify(input) },
      ),

    /** Dedicated chronological Clerk thread, scoped to the signed-in requester. */
    getThread: (caseId: string) =>
      fetchApi<AssistantThreadResponse>(
        `/assistant/tasks/${encodeURIComponent(caseId)}/thread`,
      ),

    /** The requester's current judgement, or null before one was recorded. */
    getFeedback: (caseId: string) =>
      fetchApi<{ feedback: AssistantFeedback | null }>(
        `/assistant/tasks/${encodeURIComponent(caseId)}/feedback`,
      ),

    /** Save or revise feedback without changing the completed Clerk Case. */
    saveFeedback: (caseId: string, input: AssistantFeedbackRequest) =>
      fetchApi<AssistantFeedbackWriteResponse>(
        `/assistant/tasks/${encodeURIComponent(caseId)}/feedback`,
        { method: 'PUT', body: JSON.stringify(input) },
      ),

    /** Idempotent provisioning of the caller's Clerk project/repository/policy. */
    provisionClerkCore: () =>
      fetchApi<{ project_id: string; repository_id: string; policy_id: string }>(
        '/assistant/clerk-core',
        { method: 'POST' },
      ),

    /**
     * Clerk context entries (#832 slice A) — `GET/POST/PATCH/DELETE
     * /api/assistant/context[/id]`. Every method is scoped by the route to
     * the caller's own private Clerk project; there is no id to pass for
     * "whose project".
     */
    context: {
      /** The signed-in user's own context entries, as `KnowledgeAsset`s. */
      list: () => fetchApi<{ entries: KnowledgeAsset[] }>('/assistant/context'),

      /** Create one entry. `type`/`scope_type`/`scope_ref` are fixed by the route. */
      create: (input: { title: string; body: string; always_inject?: boolean }) =>
        fetchApi<{ entry: KnowledgeAsset }>('/assistant/context', {
          method: 'POST',
          body: JSON.stringify(input),
        }),

      /** Partial update — only the provided fields change. */
      update: (
        knowledgeId: string,
        input: { title?: string; body?: string; always_inject?: boolean },
      ) =>
        fetchApi<{ entry: KnowledgeAsset }>(
          `/assistant/context/${encodeURIComponent(knowledgeId)}`,
          { method: 'PATCH', body: JSON.stringify(input) },
        ),

      remove: (knowledgeId: string) =>
        fetchApi<{ success: boolean }>(
          `/assistant/context/${encodeURIComponent(knowledgeId)}`,
          { method: 'DELETE' },
        ),
    },

    /**
     * Task blueprints (#793 slice B) — `/api/assistant/blueprints[/id[/run]]`.
     * Every method is owner-scoped by the route itself, same as `context`
     * above: there is no id to pass for "whose blueprints".
     */
    blueprints: {
      /** The signed-in user's own blueprints, most recently created first. */
      list: () => fetchApi<{ blueprints: TaskBlueprint[] }>('/assistant/blueprints'),

      /** Create a new blueprint owned by the signed-in user. Version starts at 1. */
      create: (input: CreateTaskBlueprintInput) =>
        fetchApi<{ blueprint: TaskBlueprint }>('/assistant/blueprints', {
          method: 'POST',
          body: JSON.stringify(input),
        }),

      /** Partial update. Bumps `version`; 409s (`TASK_BLUEPRINT_ARCHIVED`) on an archived blueprint. */
      update: (blueprintId: string, input: UpdateTaskBlueprintInput) =>
        fetchApi<{ blueprint: TaskBlueprint }>(
          `/assistant/blueprints/${encodeURIComponent(blueprintId)}`,
          { method: 'PATCH', body: JSON.stringify(input) },
        ),

      /** Archive — terminal in v1, not a hard delete. Idempotent on an already-archived blueprint. */
      archive: (blueprintId: string) =>
        fetchApi<{ blueprint: TaskBlueprint }>(
          `/assistant/blueprints/${encodeURIComponent(blueprintId)}`,
          { method: 'DELETE' },
        ),

      /**
       * Run-now. Same response shape as `POST /api/assistant/tasks`
       * (`AssistantTaskCreated`): the occurrence is one ordinary Clerk task
       * case. 409s `TASK_BLUEPRINT_OVERLAP` (details carry the blocking
       * `case_id`) while a prior occurrence of this blueprint is non-terminal.
       */
      runNow: (blueprintId: string) =>
        fetchApi<AssistantTaskCreated>(
          `/assistant/blueprints/${encodeURIComponent(blueprintId)}/run`,
          { method: 'POST' },
        ),
    },
  },

  cases: {
    create: (input: CreateCaseInput) =>
      fetchApi<Case>('/cases', {
        method: 'POST',
        body: JSON.stringify(input),
      }),

    get: (caseId: string) =>
      fetchApi<Case>(`/cases/${caseId}`),

    list: (filters?: CaseFilters) => {
      const params = new URLSearchParams();
      if (filters) {
        Object.entries(filters).forEach(([key, value]) => {
          if (value !== undefined) params.set(key, String(value));
        });
      }
      const query = params.toString();
      return fetchApi<CasesListResponse>(
        `/cases${query ? `?${query}` : ''}`,
      );
    },

    listAll: async (filters?: CaseFilters) => {
      const pageSize = 100;
      const allCases: Case[] = [];
      const findingCounts: Record<string, number> = {};
      let cursor: string | undefined = filters?.cursor;

      do {
        const page = await api.cases.list({
          ...filters,
          cursor,
          limit: pageSize,
        });
        allCases.push(...page.cases);
        Object.assign(findingCounts, page.finding_counts ?? {});
        cursor = page.cursor;
      } while (cursor);

      return {
        cases: allCases,
        finding_counts: findingCounts,
      } satisfies CasesListResponse;
    },

    /**
     * Cheap count of cases that need human attention (for the launcher badge).
     * Backed by Firestore's server-side `.count()` aggregation — does not
     * fetch any case payloads.
     */
    actionableCount: () =>
      fetchApi<{ count: number }>('/cases/actionable-count'),

    update: (caseId: string, input: UpdateCaseInput) =>
      fetchApi<Case>(`/cases/${caseId}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),

    transition: (caseId: string, targetStatus: string) =>
      fetchApi<Case>(`/cases/${caseId}/transition`, {
        method: 'POST',
        body: JSON.stringify({ target_status: targetStatus }),
      }),

    delete: (caseId: string) =>
      fetchApi<{ success: boolean }>(`/cases/${caseId}`, {
        method: 'DELETE',
      }),

    findings: (caseId: string) =>
      fetchApi<{ findings: Finding[] }>(`/cases/${caseId}/findings`),

    evidence: (caseId: string) =>
      fetchApi<{ evidence: Evidence[]; satisfied: boolean }>(`/cases/${caseId}/evidence`),

    evidenceRequirements: (caseId: string) =>
      fetchApi<{
        required: string[];
        optional: string[];
        present: string[];
        missing: string[];
        satisfied: boolean;
        four_eyes_required: boolean;
        allow_self_approval: boolean;
      }>(`/cases/${caseId}/evidence/requirements`),

    /**
     * Blocked `human_confirmation` RuleResults for the case, enriched with
     * the rule name — surfaced by the Courtroom as an actionable case-level
     * gate (confirm/reject) alongside the lifecycle pending_gate banner.
     */
    humanConfirmationGates: (caseId: string) =>
      fetchApi<{
        gates: {
          rule_result_id: string;
          rule_id: string;
          rule_name: string;
          message: string;
        }[];
      }>(`/cases/${caseId}/human-confirmation-gates`),

    registerEvidence: (caseId: string, input: { type: string; source_type: string; summary?: string; artifact_ref?: string; machine_readable?: boolean }) =>
      fetchApi<Evidence>(`/cases/${caseId}/evidence`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),

    decisions: (caseId: string) =>
      fetchApi<{ decisions: Decision[] }>(`/cases/${caseId}/decisions`),

    submitDecision: (caseId: string, input: CreateDecisionInput) =>
      // Response is the Decision plus an optional `transition_error` field
      // when the post-decision state-machine transition failed. The decision
      // is still persisted; the UI surfaces transition_error as a warning.
      fetchApi<Decision & { transition_error?: { code: string; message: string } }>(
        `/cases/${caseId}/decisions`,
        {
          method: 'POST',
          body: JSON.stringify(input),
        },
      ),

    comments: (caseId: string) =>
      fetchApi<{ comments: Comment[] }>(`/cases/${caseId}/comments`),

    addComment: (caseId: string, input: CreateCommentInput) =>
      fetchApi<Comment>(`/cases/${caseId}/comments`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),

    events: (caseId: string) =>
      fetchApi<{ events: CaseEvent[] }>(`/cases/${caseId}/events`),

    emitEvent: (caseId: string, type: string, payload?: Record<string, unknown>) =>
      fetchApi<CaseEvent>(`/cases/${caseId}/events`, {
        method: 'POST',
        body: JSON.stringify({ type, payload }),
      }),

    syncMerge: (caseId: string) =>
      fetchApi<{ synced: boolean; merged?: boolean; reason?: string }>(`/cases/${caseId}/sync-merge`, {
        method: 'POST',
      }),

    related: (caseId: string) =>
      fetchApi<{ groups: Array<{ relation: string; label: string; value: string; cases: Case[] }> }>(`/cases/${caseId}/related`),

    /**
     * Persistent "Approval blocked by" data for the courtroom: which approve
     * preconditions are currently unmet. `target` is `'approved'` when the
     * case is in an approve-eligible status (`needs_human_decision` /
     * `verification_pending`), else `null` (and `blockers` is empty). Fails
     * open server-side — an empty `blockers` array never means "errored".
     */
    approvalBlockers: (caseId: string) =>
      fetchApi<{
        status: string;
        target: 'approved' | null;
        blockers: Array<{ id: string; reason: string }>;
      }>(`/cases/${caseId}/approval-blockers`),

    artifacts: (caseId: string) =>
      fetchApi<{ artifacts: Artifact[] }>(`/cases/${caseId}/artifacts`),

    addArtifact: (caseId: string, input: { filename: string; content_type: string; data: string }) =>
      fetchApi<Artifact>(`/cases/${caseId}/artifacts`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),

  },

  findings: {
    comments: (findingId: string) =>
      fetchApi<{ comments: Comment[] }>(`/findings/${findingId}/comments`),

    addComment: (findingId: string, input: CreateCommentInput) =>
      fetchApi<Comment>(`/findings/${findingId}/comments`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
  },

  rules: {
    list: () =>
      fetchApi<{ ruleSets: RuleSet[]; rules: Rule[] }>('/rules'),

    create: (input: Omit<Rule, 'rule_id' | 'version' | 'created_at' | 'updated_at'>) =>
      fetchApi<Rule>('/rules', { method: 'POST', body: JSON.stringify(input) }),

    update: (ruleId: string, input: Partial<Omit<Rule, 'rule_id' | 'version' | 'created_at' | 'updated_at'>>) =>
      fetchApi<Rule>(`/rules/${ruleId}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),

    updateStatus: (ruleId: string, status: 'active' | 'inactive' | 'draft') =>
      fetchApi<Rule>(`/rules/${ruleId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      }),

    overrides: {
      list: (filters?: { rule_id?: string; overriding_rule_id?: string }) => {
        const params = new URLSearchParams();
        if (filters?.rule_id) params.set('rule_id', filters.rule_id);
        if (filters?.overriding_rule_id) params.set('overriding_rule_id', filters.overriding_rule_id);
        const query = params.toString();
        return fetchApi<{ overrides: RuleOverride[] }>(`/rules/overrides${query ? `?${query}` : ''}`);
      },

      create: (input: {
        rule_id: string;
        overriding_rule_id: string;
        scope: { layer: 'global' | 'project'; ref: string };
        rationale: string;
        finding_id?: string;
      }) =>
        fetchApi<RuleOverride>('/rules/overrides', {
          method: 'POST',
          body: JSON.stringify(input),
        }),
    },
  },

  ruleSets: {
    create: (input: { name: string; description?: string; project_id?: string; rule_refs?: string[]; status?: RuleStatus }) =>
      fetchApi<RuleSet>('/rule-sets', {
        method: 'POST',
        body: JSON.stringify(input),
      }),

    update: (ruleSetId: string, input: { name?: string; description?: string; rule_refs?: string[]; status?: RuleStatus }) =>
      fetchApi<RuleSet>(`/rule-sets/${ruleSetId}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),

    updateStatus: (ruleSetId: string, status: 'active' | 'inactive' | 'draft') =>
      fetchApi<RuleSet>(`/rule-sets/${ruleSetId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      }),
  },

  knowledge: {
    list: () =>
      fetchApi<{ assets: KnowledgeAsset[] }>('/knowledge'),

    get: (id: string) =>
      fetchApi<{ asset: KnowledgeAsset }>(`/knowledge/${id}`),

    create: (input: CreateKnowledgeAssetInput) =>
      fetchApi<{ asset: KnowledgeAsset }>('/knowledge', {
        method: 'POST',
        body: JSON.stringify(input),
      }),

    update: (id: string, input: UpdateKnowledgeAssetInput) =>
      fetchApi<{ asset: KnowledgeAsset }>(`/knowledge/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),

    delete: (id: string) =>
      fetchApi<{ success: boolean }>(`/knowledge/${id}`, {
        method: 'DELETE',
      }),

    updateStatus: (id: string, status: KnowledgeStatus) =>
      fetchApi<{ asset: KnowledgeAsset }>(`/knowledge/${id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      }),
  },

  evidencePolicies: {
    list: () =>
      fetchApi<{ policies: EvidencePolicy[] }>('/evidence-policies'),

    get: (policyId: string) =>
      fetchApi<EvidencePolicy>(`/evidence-policies/${policyId}`),

    create: (input: { project_id: string; repository_id?: string; rules: Record<string, unknown> }) =>
      fetchApi<EvidencePolicy>('/evidence-policies', {
        method: 'POST',
        body: JSON.stringify(input),
      }),

    update: (policyId: string, updates: Partial<EvidencePolicy>) =>
      fetchApi<EvidencePolicy>(`/evidence-policies/${policyId}`, {
        method: 'PATCH',
        body: JSON.stringify(updates),
      }),

    delete: async (policyId: string): Promise<void> => {
      // 204 has no JSON body — bypass `fetchApi` so we don't try to
      // parse an empty response.
      const token = await getToken();
      const headers: Record<string, string> = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const response = await fetch(`/api/evidence-policies/${policyId}`, {
        method: 'DELETE',
        headers,
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(
          (error as { error?: { message?: string } }).error?.message
            ?? `Request failed: ${response.status}`,
        );
      }
    },
  },

  runs: {
    // `create` (POST /runs with a caller-supplied `diff`) was removed here —
    // dead code with no caller (review follow-up on #1047): the route no
    // longer accepts a body diff at all (it resolves the diff server-side
    // from the case's PR/branch), and nothing in this codebase ever called
    // this method to begin with.

    listForCase: (caseId: string, status?: string) =>
      fetchApi<{ runs: Run[] }>(`/cases/${caseId}/runs${status ? `?status=${status}` : ''}`),

    complete: (runId: string, summary: string, caseId?: string) =>
      fetchApi<{ run: Run; case_transitioned: boolean; new_status?: string; next_actions: unknown[] }>(
        `/runs/${runId}/complete`,
        { method: 'POST', body: JSON.stringify({ summary, case_id: caseId }) },
      ),

    fail: (runId: string, error: string, caseId?: string) =>
      fetchApi<{ run: Run }>(`/runs/${runId}/fail`, {
        method: 'POST',
        body: JSON.stringify({ error, case_id: caseId }),
      }),

    listActive: () =>
      fetchApi<{
        activeRunsByCase: Record<string, Run[]>;
        presenceByCase: Record<string, AgentPresence[]>;
      }>('/runs/active'),
  },

  search: {
    query: (q: string) =>
      fetchApi<SearchResponse>(`/search?q=${encodeURIComponent(q)}`),
  },

  notifications: {
    /**
     * Cursor-paginated (issue #794 P0). `unread_count` on the response is
     * the caller's TOTAL unread count, not just this page's — use it for
     * the bell badge instead of counting `notifications`.
     */
    list: (params?: { cursor?: string; limit?: number }) => {
      const qs = new URLSearchParams();
      if (params?.cursor) qs.set('cursor', params.cursor);
      if (params?.limit) qs.set('limit', String(params.limit));
      const q = qs.toString();
      return fetchApi<NotificationPage>(`/notifications${q ? `?${q}` : ''}`);
    },

    markAsRead: (notificationId: string) =>
      fetchApi<void>(`/notifications/${notificationId}/read`, {
        method: 'POST',
      }),

    /** Bulk mark-all-as-read, scoped server-side to every unread row the caller owns. */
    markAllAsRead: () =>
      fetchApi<{ status: string; count: number }>('/notifications/read-all', {
        method: 'POST',
      }),

    delete: (notificationId: string) =>
      fetchApi<void>(`/notifications/${notificationId}`, {
        method: 'DELETE',
      }),
  },

  projects: {
    list: () =>
      fetchApi<{ projects: Project[] }>('/projects'),

    get: (projectId: string) =>
      fetchApi<Project>(`/projects/${projectId}`),

    create: (input: { name: string; description?: string; reviewer_pool?: string[]; tech_leads?: string[]; default_rule_set_refs?: string[]; default_validation_track?: 'direct' | 'manual' }) =>
      fetchApi<Project>('/projects', {
        method: 'POST',
        body: JSON.stringify(input),
      }),

    // `notification_webhook_url` is widened the same way `llm_overrides` is
    // just below: `Partial<Project>` alone only allows `string | undefined`
    // (matching the stored `Project` shape, which has no null branch), but
    // the PATCH wire format needs a THIRD state — an explicit clear,
    // distinct from "field omitted, leave alone" (see `webhook-section.tsx`,
    // issue #1100: sending `undefined` here means `JSON.stringify` drops the
    // key entirely and a clear never reaches the server at all).
    update: (projectId: string, input: Omit<Partial<Project>, 'llm_overrides' | 'notification_webhook_url'> & { llm_overrides?: Project['llm_overrides'] | null; notification_webhook_url?: string | null }) =>
      fetchApi<Project>(`/projects/${projectId}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),

    repositories: (projectId: string) =>
      fetchApi<{ repositories: Repository[] }>(`/projects/${projectId}/repositories`),

    addRepository: (projectId: string, input: { name: string; url: string; provider: Repository['provider']; github_token?: string }) =>
      fetchApi<Repository>(`/projects/${projectId}/repositories`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),

    updateRepository: (projectId: string, repoId: string, input: { name?: string; url?: string; provider?: Repository['provider']; github_token?: string }) =>
      fetchApi<Repository>(`/projects/${projectId}/repositories?repoId=${repoId}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),

    deleteRepository: (projectId: string, repoId: string) =>
      fetchApi<{ success: boolean }>(`/projects/${projectId}/repositories?repoId=${repoId}`, {
        method: 'DELETE',
      }),

    delete: (projectId: string) =>
      fetchApi<{ success: boolean }>(`/projects/${projectId}`, {
        method: 'DELETE',
      }),

    testWebhook: (projectId: string) =>
      fetchApi<{ success: boolean }>(`/projects/${projectId}/test-webhook`, {
        method: 'POST',
      }),

    /**
     * Find projects whose registered repositories match a canonicalized git
     * remote URL. Used by the `/connect` page to seed the project picker with
     * the project the IDE is currently sitting in.
     */
    match: (input: { repo_url: string }) =>
      fetchApi<{
        matches: Array<{
          project_id: string;
          project_name: string;
          repositories: Array<{ repository_id: string; url: string; name: string }>;
        }>;
      }>(`/projects/match?repo_url=${encodeURIComponent(input.repo_url)}`),
  },

  tokens: {
    list: () =>
      fetchApi<{ tokens: PersonalAccessToken[] }>('/tokens'),

    /**
     * Mint a Personal Access Token. The `name` arg is mandatory for back-compat
     * with the legacy form; the per-tool/device fields are populated by either
     * the `unified_connect` device flow (server-side mint in
     * `/api/auth/connect/token`) or the "Create CI service token…" disclosure
     * in the tokens panel, which passes `created_via: 'ci_service'`.
     */
    create: (
      name: string,
      extras?: {
        client_name?: string;
        client_version?: string;
        device_id?: string;
        device_label?: string;
        created_via?: 'manual' | 'ci_service';
      },
    ) =>
      fetchApi<{ token: PersonalAccessToken; raw_token: string }>('/tokens', {
        method: 'POST',
        body: JSON.stringify({ name, ...(extras ?? {}) }),
      }),

    delete: (tokenId: string) =>
      fetchApi<{ success: boolean }>(`/tokens?tokenId=${tokenId}`, {
        method: 'DELETE',
      }),

    /**
     * Bulk-revoke every token on a single device for the current user. Used by
     * the "Revoke all tokens on this device" button in the tokens panel. The
     * backend scopes the query to the authenticated user, so callers can't use
     * this to nuke someone else's device.
     */
    deleteByDevice: (deviceId: string) =>
      fetchApi<{ success: boolean; deleted_count: number }>(
        `/tokens?device_id=${encodeURIComponent(deviceId)}`,
        { method: 'DELETE' },
      ),
  },

  auth: {
    connect: {
      /**
       * Fetch the non-secret metadata for a pending device-code, so the
       * `/connect` page can render Tool / Device / Project rows. 404 if the
       * code is unknown, expired, denied, or already consumed.
       */
      lookup: (input: { user_code: string }) =>
        fetchApi<{
          client_name: string;
          client_version?: string;
          device_label: string;
          repo_url?: string;
          repo_name?: string;
          expires_at: string;
        }>(`/auth/connect/lookup?user_code=${encodeURIComponent(input.user_code)}`),

      /**
       * User clicks Confirm. Flips the device-code doc from `pending` →
       * `approved` and binds (user_id, project_id). Idempotent for the same
       * (user, project) pair; 409 otherwise.
       */
      approve: (input: { user_code: string; project_id: string; device_label?: string }) =>
        fetchApi<{ approved: true; project_name: string }>('/auth/connect/approve', {
          method: 'POST',
          body: JSON.stringify(input),
        }),

      /** User clicks Cancel. Idempotent. */
      cancel: (input: { user_code: string }) =>
        fetchApi<{ cancelled: true }>('/auth/connect/cancel', {
          method: 'POST',
          body: JSON.stringify(input),
        }),
    },
  },

  users: {
    batch: (ids: string[]) =>
      fetchApi<{ users: User[] }>(`/users?ids=${ids.join(',')}`),

    me: () =>
      fetchApi<User>('/users/me'),

    /**
     * All fields are independently optional (spec Slice D,
     * `docs/specs/clerk-config-scheduling-chat.md`, adds
     * `notification_chat_webhook` alongside the pre-existing
     * `custom_avatar_url`; the chat DM conversation-window feature adds
     * `chat_conversation_window`) — pass only the one you're changing.
     * `notification_chat_webhook: null` clears it, same as `''`.
     * `chat_conversation_window` has no clear signal — omit it to leave the
     * user's habit (or the default, if they never chose one) untouched.
     */
    updateMe: (input: {
      custom_avatar_url?: string;
      notification_chat_webhook?: string | null;
      chat_conversation_window?: ChatConversationWindow;
    }) =>
      fetchApi<User>('/users/me', {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),

    /**
     * Sends a test message to the CALLER's own `notification_chat_webhook`
     * (spec Slice D). Mirrors `projects.testWebhook` — a real send attempt
     * that also updates `notification_chat_delivery` on the backend.
     */
    testChatWebhook: () =>
      fetchApi<{ success: boolean }>('/users/me/test-chat-webhook', {
        method: 'POST',
      }),

    /**
     * Upload a new avatar image. The file is proxied through the backend
     * (see `storage.rules` — direct client access is denied) and stored
     * in the app bucket. Returns the updated user row with
     * `custom_avatar_url` pointing at the minted download URL.
     */
    uploadAvatar: async (file: File): Promise<User> => {
      const token = await getToken();
      const headers: Record<string, string> = {};
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
      // Do NOT set Content-Type: the browser must set it with the
      // multipart boundary itself.
      const form = new FormData();
      form.append('file', file);

      const response = await fetch('/api/users/me/avatar', {
        method: 'POST',
        headers,
        body: form,
      });

      if (!response.ok) {
        let message = `Request failed: ${response.status}`;
        try {
          const err = await response.json();
          message = err?.error?.message ?? message;
        } catch {
          // Ignore JSON parse errors; fall back to the status-based message.
        }
        throw new Error(message);
      }

      return response.json() as Promise<User>;
    },

    list: () =>
      fetchApi<{ users: User[] }>('/users'),

    updateRoles: (userId: string, roles: string[]) =>
      fetchApi<User>(`/users/${userId}/roles`, {
        method: 'PATCH',
        body: JSON.stringify({ roles }),
      }),

    // Issue #1069 fix 1 — clear only: no
    // parameter to set a specific chat_user_id, see route's docstring.
    clearChatIdentity: (userId: string) =>
      fetchApi<User>(`/users/${userId}/chat-identity`, {
        method: 'PATCH',
        body: JSON.stringify({ action: 'clear' }),
      }),
  },

  dashboard: {
    /**
     * Server-side fan-in for the dashboard hook. Returns the same four
     * sections that were previously fetched in parallel by the client, each
     * settled independently so one failing sub-query yields partial data
     * instead of a whole-dashboard failure.
     */
    get: () =>
      fetchApi<{
        myCases: DashboardSectionResult<{ cases: Case[] }>;
        needs_human_decision: DashboardSectionResult<{ cases: Case[] }>;
        verification_pending: DashboardSectionResult<{ cases: Case[] }>;
        observatory: DashboardSectionResult<ObservatoryResponse>;
      }>('/dashboard'),
  },

  observatory: {
    get: (params?: { days?: number }) =>
      fetchApi<ObservatoryResponse>(`/observatory${params?.days ? `?days=${params.days}` : ''}`),
  },

  missionControl: {
    /** Live "what is running right now" list — see /api/mission-control. */
    get: () => fetchApi<MissionControlResponse>('/mission-control'),
  },

  activity: {
    /**
     * Workspace-wide live feed. Pass `since` to delta-fetch only entries
     * newer than the last timestamp the UI already holds — avoids replacing
     * the whole list on every poll.
     */
    list: (params?: {
      limit?: number;
      since?: string;
      before?: string;
      clientName?: string;
      projectId?: string;
      agentsOnly?: boolean;
    }) => {
      const qs = new URLSearchParams();
      if (params?.limit) qs.set('limit', String(params.limit));
      if (params?.since) qs.set('since', params.since);
      if (params?.before) qs.set('before', params.before);
      if (params?.clientName) qs.set('client_name', params.clientName);
      if (params?.projectId) qs.set('project_id', params.projectId);
      if (params?.agentsOnly) qs.set('agents_only', 'true');
      const q = qs.toString();
      return fetchApi<{ entries: ActivityEntry[]; cursor: string | null }>(
        `/activity${q ? `?${q}` : ''}`,
      );
    },

    leaderboard: (window: ActivityLeaderboardWindow = '24h') =>
      fetchApi<{
        window: ActivityLeaderboardWindow;
        rows: ActivityLeaderboardRow[];
        project_rows: ActivityProjectLeaderboardRow[];
      }>(
        `/activity/leaderboard?window=${window}`,
      ),

    /**
     * "What needs me" chip counts for the pinned strip. Counts are
     * scoped to the viewer's project access — admins see the global queue.
     * The `filter` payload returned per chip is structured so the client can
     * spread it directly into the existing feed `setFilters()`.
     */
    needsMe: () =>
      fetchApi<{
        awaiting_decision: { count: number; filter: { needsMe: boolean } };
        idle_over_threshold: {
          count: number;
          filter: { openedBy: 'detector' };
        };
        failed_builds_24h: {
          count: number;
          filter: { kind: 'case_event'; subkind: string };
        };
        webhook_rejections: {
          count: number;
          filter: { kind: 'workspace_event'; subkind: string };
        };
      }>('/activity/needs-me'),
  },

  workspaceEvents: {
    /**
     * Fetch a single workspace event by id. Used by the detail drawer opened
     * from the activity feed. Any authenticated user may call this.
     */
    get: (eventId: string) =>
      fetchApi<WorkspaceEvent>(`/workspace-events/${eventId}`),
    /**
     * Globally resolve a workspace event (admin / tech_lead only).
     * Returns the updated event body.
     */
    resolve: (eventId: string) =>
      fetchApi<WorkspaceEvent>(`/workspace-events/${eventId}/resolve`, {
        method: 'POST',
      }),
    /**
     * Dismiss a workspace event for the current viewer only. Any
     * authenticated user may call this; idempotent.
     */
    dismiss: (eventId: string) =>
      fetchApi<{ user_id: string; event_id: string; dismissed_at: string }>(
        `/workspace-events/${eventId}/dismiss`,
        { method: 'POST' },
      ),
  },

  caseTemplates: {
    list: () =>
      fetchApi<{ templates: CaseTemplate[] }>('/case-templates'),
  },

  settings: {
    llm: {
      get: () =>
        fetchApi<{
          settings: Pick<LlmSettings, 'provider' | 'models'>;
          source: 'firestore' | 'env' | 'default';
          defaults: Record<RiskLevel, string>;
        }>('/settings/llm'),

      update: (provider: LlmProviderName, models: Record<RiskLevel, string>) =>
        fetchApi<{ settings: LlmSettings }>('/settings/llm', {
          method: 'PATCH',
          body: JSON.stringify({ provider, models }),
        }),
    },
  },

  intelligence: {
    /**
     * Admin-only — list persisted intelligence runs, newest first.
     * `cursor` is the `started_at` of the last row on the previous page.
     */
    listRuns: (params?: { limit?: number; cursor?: string }) => {
      const qs = new URLSearchParams();
      if (params?.limit) qs.set('limit', String(params.limit));
      if (params?.cursor) qs.set('cursor', params.cursor);
      const q = qs.toString();
      return fetchApi<{ runs: IntelligenceRun[]; next_cursor?: string }>(
        `/intelligence/runs${q ? `?${q}` : ''}`,
      );
    },

    getRun: (runId: string) =>
      fetchApi<IntelligenceRun>(`/intelligence/runs/${runId}`),

    listDetectors: () =>
      fetchApi<{
        detectors: Array<{
          detector_id: string;
          name: string;
          description: string;
          config: DetectorConfig;
          // `error` — full per-detector error message from the most recent
          // run, present only when that run failed for this detector. Used
          // by the drill-down page to render the failure and extract a
          // Firestore create-index URL when one is embedded in the text.
          last_run?: { started_at: string; finding_count: number; error?: string };
        }>;
      }>('/intelligence/detectors'),

    setDetectorEnabled: (detectorId: string, enabled: boolean) =>
      fetchApi<{ detector_id: string; config: DetectorConfig }>(
        `/intelligence/detectors/${detectorId}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ enabled }),
        },
      ),

    /**
     * Admin-authenticated manual kickoff of an intelligence run. Returns
     * the fully-built `IntelligenceRun` (already persisted). Shares the
     * scheduler's Firestore lock — concurrent calls get a 409.
     */
    runNow: () =>
      fetchApi<IntelligenceRun>('/intelligence/run-admin', {
        method: 'POST',
      }),

    /**
     * Admin-only — list cases whose `intelligence_signature` starts with
     * `${detectorId}:`. Used by the observatory drill-down. Newest first.
     */
    detectorFindings: (detectorId: string, params?: { limit?: number }) => {
      const qs = new URLSearchParams();
      if (params?.limit) qs.set('limit', String(params.limit));
      const q = qs.toString();
      return fetchApi<{
        findings: Array<{
          case_id: string;
          title: string;
          status: string;
          risk_level: string;
          intelligence_signature: string | null;
          created_at: string;
          updated_at: string;
        }>;
      }>(`/intelligence/detectors/${detectorId}/findings${q ? `?${q}` : ''}`);
    },
  },

  helper: {
    /**
     * Ask the Arbitra Helper Bot a question. Optionally pass `history` —
     * the prior turns of the conversation — to get a context-aware reply.
     * Omitting `history` keeps the original single-turn contract for
     * back-compat. Backend caps history at 10 turns. Backend authenticates
     * via the existing session cookie + bearer token (see
     * `app/api/helper/ask/route.ts`).
     */
    ask: (
      question: string,
      history?: Array<{ role: 'user' | 'assistant'; content: string }>,
    ) =>
      fetchApi<{
        answer: string;
        latency_ms: number;
        prompt_tokens: number;
        completion_tokens: number;
      }>('/helper/ask', {
        method: 'POST',
        body: JSON.stringify(
          history && history.length > 0 ? { question, history } : { question },
        ),
      }),
  },

  llm: {
    test: (input: {
      provider: LlmProviderName;
      models: Partial<Record<RiskLevel, string>>;
      project_id?: string;
    }) =>
      fetchApi<{
        results: Partial<Record<RiskLevel, {
          ok: boolean;
          latency_ms: number;
          error?: string;
          model: string;
          skipped?: boolean;
          reason?: string;
        }>>;
      }>('/llm/test', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
  },
};
