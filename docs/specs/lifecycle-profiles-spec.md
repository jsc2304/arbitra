# Lifecycle Profiles Specification

Status: Design document; parts may differ from the code. Profiles, gates, presets, `pending_gate`, gate confirmation decisions and the project Lifecycle settings are implemented. The MCP tool `confirm_gate` described in section 7.6 is not.

---

## 1. Overview

Lifecycle Profiles make Arbitra's case lifecycle autonomy configurable per project. Today, the `TRANSITION_MATRIX` in `packages/shared/src/constants/status-transitions.ts` hardcodes which transitions fire automatically (`auto_trigger: true`) and which require human action. Every project uses the same behavior.

Different projects have different governance needs:

- An **internal tool** project wants maximum automation -- humans only intervene when critical findings surface.
- A **standard product** project (the current default) requires explicit build confirmation but auto-flows through review unless findings demand a human decision.
- A **compliance/payments** project requires human approval at every phase boundary, including exploration sign-off before build starts.

Lifecycle Profiles solve this by introducing a per-project overlay that controls which transitions are automatic vs. require explicit human confirmation. The state machine itself -- its states, possible transitions, preconditions, and events -- remains unchanged.

---

## 2. Design Principles

1. **Same states, same transitions.** Profiles do not add, remove, or reorder states. The `TRANSITION_MATRIX` is the single source of truth for what transitions are structurally possible.

2. **Only autonomy changes.** A profile controls whether a transition that *could* fire automatically *does* fire automatically, or instead pauses for human confirmation.

3. **Event audit trail is unaffected.** Every transition -- whether auto or confirmed -- emits the same events to `case_events`. Confirmed transitions add a `gate_confirmation` event (see Section 5) but never skip existing events.

4. **Layered defaults.** Resolution order: per-gate override on the project > project's selected preset > system default ("Standard"). A project with no profile configured behaves exactly as it does today.

5. **Profiles are advisory, not permissive.** A profile can make an auto transition require confirmation, but it cannot bypass preconditions. If `auto_approve_criteria_met` fails, the case still routes to `needs_human_decision` regardless of profile.

---

## 3. Lifecycle Profile Model

### 3.1 Configurable Gates

Not every transition is meaningfully configurable. Some are inherently manual (user clicks "Start Build") and some are inherently automatic (PR merge triggers `done`). The configurable gates are the transitions where `auto_trigger: true` in the current `TRANSITION_MATRIX`:

| Gate ID | Transition | Current Default | Description |
|---------|-----------|----------------|-------------|
| `exploration_to_ready` | `exploration` -> `ready_for_build` | `auto` | Auto-advances when exploration run completes |
| `ready_to_build` | `ready_for_build` -> `in_build` | `confirm` | Currently always manual; becomes optionally automatic |
| `build_to_validation` | `in_build` -> `in_validation` | `auto` | Auto-advances when build run completes with diff |
| `validation_to_review` | `in_validation` -> `in_review` | `auto` | Auto-advances when rules pass and evidence satisfied |
| `review_to_approved` | `in_review` -> `approved` | `auto` | Auto-approves when no high/critical findings |
| `review_to_needs_human` | `in_review` -> `needs_human_decision` | `auto` | Auto-routes when high/critical findings exist |
| `review_to_verification` | `in_review` -> `verification_pending` | `auto` | Auto-routes manual track cases |
| `approved_to_pending_merge` | `approved` -> `pending_merge` | `auto` | Auto-advances when all steps completed |
| `pending_merge_to_done` | `pending_merge` -> `done` | `auto` | Auto-completes when PR merged |

### 3.2 GateBehavior Type

```typescript
// packages/shared/src/types/lifecycle-profile.ts

export type GateBehavior = 'auto' | 'confirm';
```

- **`auto`** -- The pipeline transitions automatically when all preconditions are satisfied. Current behavior for `auto_trigger: true` transitions.
- **`confirm`** -- The pipeline pauses even when preconditions are satisfied. A human must explicitly confirm the transition via the Decision Service. The UI shows a "Confirm Transition" action.

### 3.3 Gate Configuration Type

```typescript
export type GateId =
  | 'exploration_to_ready'
  | 'ready_to_build'
  | 'build_to_validation'
  | 'validation_to_review'
  | 'review_to_approved'
  | 'review_to_needs_human'
  | 'review_to_verification'
  | 'approved_to_pending_merge'
  | 'pending_merge_to_done';

export type GateConfig = Partial<Record<GateId, GateBehavior>>;
```

### 3.4 Lifecycle Profile Type

```typescript
export type LifecyclePresetId = 'autonomous' | 'standard' | 'strict';

export type GateConfirmerRole = 'reviewer' | 'tech_lead';

export interface LifecycleProfile {
  /** Selected preset. Provides defaults for all gates. */
  preset: LifecyclePresetId;
  /** Per-gate overrides. Takes precedence over the preset defaults. */
  overrides?: GateConfig;
  /** Roles allowed to confirm gates. Default: ['reviewer', 'tech_lead']. */
  gate_confirmer_roles?: GateConfirmerRole[];
}
```

### 3.5 Gate-to-Transition Mapping

A constant maps `GateId` to the `[from, to]` pair in the `TRANSITION_MATRIX`:

```typescript
// packages/shared/src/constants/lifecycle-gates.ts

import type { CaseStatus } from '../types/case.js';
import type { GateId } from '../types/lifecycle-profile.js';

export const GATE_TRANSITION_MAP: Record<GateId, { from: CaseStatus; to: CaseStatus }> = {
  exploration_to_ready:       { from: 'exploration',       to: 'ready_for_build' },
  ready_to_build:             { from: 'ready_for_build',   to: 'in_build' },
  build_to_validation:        { from: 'in_build',          to: 'in_validation' },
  validation_to_review:       { from: 'in_validation',     to: 'in_review' },
  review_to_approved:         { from: 'in_review',         to: 'approved' },
  review_to_needs_human:      { from: 'in_review',         to: 'needs_human_decision' },
  review_to_verification:     { from: 'in_review',         to: 'verification_pending' },
  approved_to_pending_merge:  { from: 'approved',          to: 'pending_merge' },
  pending_merge_to_done:      { from: 'pending_merge',     to: 'done' },
};
```

---

## 4. Built-in Presets

### 4.1 Autonomous

Maximum automation. Humans only intervene when the system explicitly routes to `needs_human_decision` (high/critical findings) or `verification_pending` (manual track). Build starts automatically after exploration — no manual confirmation.

| Gate | Behavior |
|------|----------|
| `exploration_to_ready` | `auto` |
| `ready_to_build` | `auto` |
| `build_to_validation` | `auto` |
| `validation_to_review` | `auto` |
| `review_to_approved` | `auto` |
| `review_to_needs_human` | `auto` |
| `review_to_verification` | `auto` |
| `approved_to_pending_merge` | `auto` |
| `pending_merge_to_done` | `auto` |

**Use case:** Internal tools, prototypes, low-risk repos where speed matters more than oversight.

### 4.2 Standard (System Default)

Build requires explicit user confirmation. Review flows automatically. This is the default for projects that have no profile configured.

| Gate | Behavior |
|------|----------|
| `exploration_to_ready` | `auto` |
| `ready_to_build` | `confirm` |
| `build_to_validation` | `auto` |
| `validation_to_review` | `auto` |
| `review_to_approved` | `auto` |
| `review_to_needs_human` | `auto` |
| `review_to_verification` | `auto` |
| `approved_to_pending_merge` | `auto` |
| `pending_merge_to_done` | `auto` |

> Note: The key difference from Autonomous is `ready_to_build: confirm` — Standard requires a human to explicitly start the build phase, while Autonomous auto-starts it.

### 4.3 Strict

Human approval required at every phase boundary. Every gate requires explicit confirmation.

| Gate | Behavior |
|------|----------|
| `exploration_to_ready` | `confirm` |
| `ready_to_build` | `confirm` |
| `build_to_validation` | `confirm` |
| `validation_to_review` | `confirm` |
| `review_to_approved` | `confirm` |
| `review_to_needs_human` | `auto` |
| `review_to_verification` | `auto` |
| `approved_to_pending_merge` | `confirm` |
| `pending_merge_to_done` | `auto` |

**Design decisions:**
- `review_to_needs_human` stays `auto` because routing to human decision is inherently a "require human" action -- adding a confirm gate before asking for a human decision would be redundant.
- `review_to_verification` stays `auto` for the same reason -- it routes to manual verification which already requires human action.
- `pending_merge_to_done` stays `auto` because it triggers on PR merge, which is itself a deliberate human/CI action in the git host.

**Use case:** Financial systems, compliance-sensitive projects, regulated environments where every phase transition must be signed off.

### 4.4 Preset Definitions in Code

```typescript
// packages/shared/src/constants/lifecycle-presets.ts

import type { GateConfig, LifecyclePresetId } from '../types/lifecycle-profile.js';

export const LIFECYCLE_PRESETS: Record<LifecyclePresetId, GateConfig> = {
  autonomous: {
    exploration_to_ready:      'auto',
    ready_to_build:            'auto',
    build_to_validation:       'auto',
    validation_to_review:      'auto',
    review_to_approved:        'auto',
    review_to_needs_human:     'auto',
    review_to_verification:    'auto',
    approved_to_pending_merge: 'auto',
    pending_merge_to_done:     'auto',
  },
  standard: {
    exploration_to_ready:      'auto',
    ready_to_build:            'confirm',
    build_to_validation:       'auto',
    validation_to_review:      'auto',
    review_to_approved:        'auto',
    review_to_needs_human:     'auto',
    review_to_verification:    'auto',
    approved_to_pending_merge: 'auto',
    pending_merge_to_done:     'auto',
  },
  strict: {
    exploration_to_ready:      'confirm',
    ready_to_build:            'confirm',
    build_to_validation:       'confirm',
    validation_to_review:      'confirm',
    review_to_approved:        'confirm',
    review_to_needs_human:     'auto',
    review_to_verification:    'auto',
    approved_to_pending_merge: 'confirm',
    pending_merge_to_done:     'auto',
  },
};
```

---

## 5. Resolution and Evaluation

### 5.1 Resolving the Effective Gate Behavior

```typescript
// packages/shared/src/utils/resolve-gate.ts

import type { GateId, LifecycleProfile, GateBehavior } from '../types/lifecycle-profile.js';
import { LIFECYCLE_PRESETS } from '../constants/lifecycle-presets.js';

export function resolveGateBehavior(
  gateId: GateId,
  profile?: LifecycleProfile,
): GateBehavior {
  // 1. Per-gate override on the project
  if (profile?.overrides?.[gateId]) {
    return profile.overrides[gateId];
  }
  // 2. Preset default
  if (profile?.preset) {
    return LIFECYCLE_PRESETS[profile.preset][gateId] ?? 'auto';
  }
  // 3. System default (Standard)
  return LIFECYCLE_PRESETS['standard'][gateId] ?? 'auto';
}
```

### 5.2 Pipeline Integration

The change is localized to `RunCompletionHandler.tryAutoTransition()` in `packages/backend/src/services/orchestration/pipeline.ts`.

**Current code** (simplified):

```typescript
private async tryAutoTransition(case_: Case): Promise<TransitionDefinition | null> {
  const candidates = getAutoTransitionsFrom(case_.status);
  // ... evaluate preconditions, execute first match
}
```

**Modified code:**

```typescript
private async tryAutoTransition(case_: Case): Promise<TransitionDefinition | null> {
  const candidates = getAutoTransitionsFrom(case_.status);
  if (candidates.length === 0) return null;

  const ctx = await this.adapter.loadPreconditionContext(case_);
  const evaluator = createPreconditionEvaluator(ctx);

  // Load project's lifecycle profile
  const profile = await this.adapter.getProjectLifecycleProfile(case_.project_id);

  for (const candidate of candidates) {
    const allSatisfied = await this.checkAllPreconditions(candidate, evaluator);
    if (!allSatisfied) continue;

    // Check gate behavior
    const gateId = findGateId(candidate.from, candidate.to);
    if (gateId) {
      const behavior = resolveGateBehavior(gateId, profile);
      if (behavior === 'confirm') {
        // Preconditions are met but gate requires confirmation.
        // Emit a gate_pending event and notify; do NOT execute the transition.
        await this.emitGatePending(case_, candidate, gateId);
        return null;
      }
    }

    await this.executeTransition(case_, candidate);
    return candidate;
  }

  return null;
}
```

### 5.3 The `gate_pending` Event

When a `confirm` gate blocks a transition, the pipeline emits a new event:

```typescript
// New EventType: 'gate_pending'

await this.adapter.emitEvent(
  case_.case_id,
  'gate_pending',
  {
    gate_id: gateId,
    from_status: case_.status,
    to_status: candidate.to,
    preconditions_satisfied: true,
    awaiting: 'human_confirmation',
  },
  SYSTEM_ACTOR,
);
```

This event:
- Appears in the case timeline, providing full auditability.
- Triggers a notification to the project's reviewer pool and tech leads.
- Updates a `pending_gate` field on the case (see Section 5.4).

### 5.4 Case Entity Extension

Add an optional field to the `Case` type in `packages/shared/src/types/case.ts`:

```typescript
export interface Case {
  // ... existing fields ...

  /** Set when a confirm gate blocks an auto-transition. Cleared on confirmation or rejection. */
  pending_gate?: {
    gate_id: GateId;
    target_status: CaseStatus;
    since: string; // ISO timestamp
  };
}
```

The UI uses `pending_gate` to show a confirmation prompt. The Board view can filter/highlight cases awaiting gate confirmation.

### 5.5 Confirming a Gate

Gate confirmation uses the existing Decision Service. A new decision type is added:

```typescript
// In packages/shared/src/types/decision.ts, add to DecisionType union:
| 'gate_confirmed'
```

When a user confirms a pending gate:

1. **POST** `/api/cases/:id/decisions` with `{ type: 'gate_confirmed', metadata: { gate_id, target_status } }`
2. The Decision Service records the decision (audit trail).
3. The backend clears `case.pending_gate` and calls `executeTransition()` for the target transition.
4. A `gate_confirmed` event is emitted.
5. `onRunCompleted` is called to continue the pipeline chain.

A gate confirmation is a phase progression, not an approval. It does not count toward the four-eyes requirement (see section 7.5). The case owner cannot confirm their own gate, and the confirming user must hold one of the roles in `gate_confirmer_roles`.

### 5.6 Helper: Finding the Gate ID for a Transition

```typescript
// packages/shared/src/constants/lifecycle-gates.ts

import type { CaseStatus } from '../types/case.js';
import type { GateId } from '../types/lifecycle-profile.js';

export function findGateId(from: CaseStatus, to: CaseStatus): GateId | null {
  for (const [gateId, mapping] of Object.entries(GATE_TRANSITION_MAP)) {
    if (mapping.from === from && mapping.to === to) {
      return gateId as GateId;
    }
  }
  return null;
}
```

---

## 6. Project Configuration

### 6.1 Storage

Add `lifecycle_profile` to the `Project` type in `packages/shared/src/types/project.ts`:

```typescript
export interface Project {
  // ... existing fields ...

  /** Lifecycle profile controlling case autonomy. Defaults to 'standard' if absent. */
  lifecycle_profile?: LifecycleProfile;
}
```

Stored directly on the project document in Firestore (`/projects/{project_id}`). No separate collection is needed: a profile is one preset id plus up to nine gate overrides.

### 6.2 API

Existing project CRUD endpoints handle the new field:

- **PATCH** `/api/projects/:id` -- accepts `lifecycle_profile` in the request body
- **GET** `/api/projects/:id` -- returns `lifecycle_profile` if set

Validation (Zod schema in `packages/shared/src/validation/lifecycle-profile-validators.ts`):

```typescript
const GateBehaviorSchema = z.enum(['auto', 'confirm']);

const GateConfigSchema = z.object({
  exploration_to_ready:      GateBehaviorSchema.optional(),
  ready_to_build:            GateBehaviorSchema.optional(),
  build_to_validation:       GateBehaviorSchema.optional(),
  validation_to_review:      GateBehaviorSchema.optional(),
  review_to_approved:        GateBehaviorSchema.optional(),
  review_to_needs_human:     GateBehaviorSchema.optional(),
  review_to_verification:    GateBehaviorSchema.optional(),
  approved_to_pending_merge: GateBehaviorSchema.optional(),
  pending_merge_to_done:     GateBehaviorSchema.optional(),
}).strict();

const LifecycleProfileSchema = z.object({
  preset: z.enum(['autonomous', 'standard', 'strict']),
  overrides: GateConfigSchema.optional(),
  gate_confirmer_roles: z.array(z.enum(['reviewer', 'tech_lead'])).optional(),
});
```

### 6.3 UI Design

**Settings > Projects > [Project] > Lifecycle** tab (new tab alongside existing project settings):

1. **Preset Selector** -- Three cards (Autonomous / Standard / Strict) with short descriptions and a visual indicator of which gates are auto vs. confirm. Selecting a preset applies its defaults immediately.

2. **Advanced: Per-Gate Overrides** -- Collapsible section below the preset selector. Shows all 9 configurable gates as toggle switches (Auto / Confirm). Only visible when expanded. Overrides are highlighted with a badge showing they diverge from the selected preset.

3. **Preview** -- A mini pipeline diagram showing the case lifecycle with gates colored green (auto) or amber (confirm) based on the resolved configuration.

**Case Detail View** -- When `pending_gate` is set:
- A prominent banner: "Awaiting confirmation to proceed to [target status]"
- "Confirm" and "Reject" buttons (reject sends case back or keeps it in current state)
- Shows who can confirm (based on project role: tech_lead or reviewer)

**Board View** -- Cases with `pending_gate` show a gate icon badge, filterable via a "Pending Confirmation" filter.

---

## 7. Impact on Existing Features

### 7.1 Evidence Policies -- Unaffected

Evidence policies define *what evidence is required* at each risk level. Lifecycle profiles define *when transitions happen*. These are orthogonal. A `confirm` gate at `validation_to_review` still requires `required_evidence_satisfied` before the gate even becomes confirmable.

### 7.2 Rule Engine -- Unaffected

Rules run when a case enters the appropriate state (e.g., `rule_run` triggers on entering `in_validation`). The gate controls how the case *gets to* that state, but once there, rules execute as usual.

### 7.3 Review Engine -- Unaffected

Reviews run when a case enters `in_review`. A `confirm` gate at `validation_to_review` means a human confirms the transition to `in_review`, after which the review engine runs normally.

### 7.4 Notifications -- Enhanced

New notification triggers:

| Event | Notification |
|-------|-------------|
| `gate_pending` | Push notification to project tech_leads and reviewer_pool: "Case [title] is ready to proceed to [target_status] and awaits your confirmation." |
| `gate_confirmed` | In-app notification to case owner: "Case [title] confirmed to proceed to [target_status] by [actor]." |

Uses existing `NotificationService` and `NotificationDispatcher` infrastructure. Google Chat webhook templates get new event types.

### 7.5 Four-Eyes Principle -- Interacts

Gate confirmation and approval are separate:
- A `gate_confirmed` decision at the `review_to_approved` gate lets the case proceed to `approved`. It does not satisfy the four-eyes requirement.
- If the evidence policy requires four-eyes for the case's risk level, a separate `approve` decision from a different user is still needed.
- The case owner cannot confirm their own gates.

### 7.6 IDE / MCP Integration -- Minor Updates

- The `GET /api/cases/:id` response includes `pending_gate` when set.
- `get_case_context` reports `lifecycle_profile` and `pending_gate`, so an agent can see that a case waits for a human.
- Confirming a gate is a human `gate_confirmed` decision. No MCP tool confirms gates, and the design does not require one; an IDE agent tells the user that confirmation is needed.

---

## 8. Migration and Backward Compatibility

### 8.1 No Data Migration Required

- Existing projects have no `lifecycle_profile` field. The resolver treats absent profiles as "Standard" preset, which matches current behavior exactly.
- The `TRANSITION_MATRIX` constant is unchanged. `auto_trigger` flags remain as-is. The profile overlay is a runtime check in the pipeline, not a mutation of the transition definitions.
- Existing `case_events` records are unaffected. New event types (`gate_pending`, `gate_confirmed`) appear only for cases that reach a confirm gate.

### 8.2 State Machine Constant Unchanged

The `TRANSITION_MATRIX` in `packages/shared/src/constants/status-transitions.ts` continues to be the structural definition of all possible transitions. `auto_trigger: true` remains on the same transitions. The lifecycle profile is a behavioral overlay that the pipeline consults at runtime -- it does not modify the static transition definitions.

### 8.3 API Backward Compatibility

- All existing API endpoints continue to work without changes.
- `lifecycle_profile` is an optional field on `Project` -- omitting it is valid and defaults to Standard.
- The `gate_confirmed` decision type is additive to the `DecisionType` union.

---

## 9. Resolved Design Decisions

1. **`ready_for_build` -> `in_build` becomes a configurable gate.** This transition will gain an optional `auto_trigger` path so the Autonomous preset can skip the manual "Start Build" confirmation. This is the key differentiator between Autonomous (fully hands-off until review findings) and Standard (build start requires confirmation). Implementation: add a new gate `ready_to_build` with default `confirm` in Standard/Strict and `auto` in Autonomous.

2. **Gate rejection: case stays in place.** When a human declines a pending gate, the case remains in its current state. The rejector (tech lead, reviewer, or the developer via IDE) can add comments explaining why, then the developer can re-do the work and the gate re-evaluates when preconditions are met again. This is uniform for all gates — `request_changes` is a separate action the user can take manually if appropriate.

3. **Gate confirmation permissions: configurable per project, default = reviewer pool + tech leads.** Projects can restrict gate confirmation to tech leads only or keep the default (same people who make decisions in the Courtroom). Stored as `gate_confirmer_roles` on the project's lifecycle profile. The developer/case owner can always trigger re-work (re-exploration, re-build) but cannot confirm their own gates (anti-gaming, consistent with self-approval prohibition).

4. **Four-eyes remains independent of gate confirmation.** A gate confirmation at `review_to_approved` says "yes, proceed to approved" but does NOT satisfy the four-eyes requirement. If the project's rules/evidence policy require four-eyes for that risk level, a separate approval decision from a different user is still needed. Gate = phase progression, approval = quality sign-off.

5. **No per-repository overrides.** The Arbitra model is 1 project = 1 repository. Projects needing different governance per repo create separate Arbitra projects. No repo-level profile overrides needed.

6. **Profile changes notify via Google Chat.** When a project's lifecycle profile is changed, a Google Chat notification is sent to the project's tech leads and reviewer pool. This uses the existing `NotificationDispatcher` with a new `profile_changed` event type.

## 10. Deferred Questions

1. **Gate confirmation timeout.** Should there be a configurable timeout after which a pending gate escalates (e.g., auto-confirms for low risk, or sends a reminder for high risk)? **Deferred** to a future iteration. The notification on `gate_pending` provides the nudge for now.

2. **Interaction with case templates.** Whether case templates should be able to override the project's lifecycle profile for specific case types. **Deferred.** Case templates can reference a profile ID, with resolution: case template profile > project profile > system default.
