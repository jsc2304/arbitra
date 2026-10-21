import { z } from 'zod';
import { inlineAttachmentSchema, gitContextSchema } from './artifact-validators.js';
import { prRefSchema } from './pr-ref-schema.js';

const caseStatusSchema = z.enum([
  'open', 'exploration', 'ready_for_build', 'in_build', 'in_validation',
  'in_review', 'needs_human_decision', 'verification_pending',
  'approved', 'pending_merge', 'done', 'rejected',
]);

const validationTrackSchema = z.enum(['direct', 'manual']);
const riskLevelSchema = z.enum(['low', 'medium', 'high', 'critical']);
const prioritySchema = z.enum(['low', 'normal', 'high', 'urgent']);
const sourceTypeSchema = z.enum(['jira', 'manual', 'git', 'google_chat', 'other']);
const caseTypeSchema = z.enum([
  'ticket_implementation', 'bugfix', 'refactoring', 'security_review',
  'pr_review', 'manual_verification', 'assistant_task', 'observed', 'other',
]);
// Mirrors `AssistantContext` in ../types/case.ts. The Chat coordinates and
// `task_kind` are optional there (only the Chat channel has a space/thread/
// message, and the task kind is classified by the executor, not at intake), so
// they are optional here too.
const assistantContextSchema = z.object({
  channel: z.string().min(1).max(100),
  space_name: z.string().min(1).max(500).optional(),
  thread_name: z.string().min(1).max(500).optional(),
  source_message_name: z.string().min(1).max(500).optional(),
  chat_user_name: z.string().min(1).max(500).optional(),
  conversation_visibility: z.enum(['direct', 'space']),
  requester_user_id: z.string().min(1).max(200).optional(),
  task_kind: z.string().min(1).max(100).optional(),
  risk_level: z.string().min(1).max(50),
  policy_version: z.string().min(1).max(100),
  prompt_version: z.string().min(1).max(100),
  wait_reason: z.enum(['clarification', 'retry_exhausted', 'failed_permanently']).optional(),
  wait_run_id: z.string().min(1).max(200).optional(),
  wait_attempt: z.number().int().positive().optional(),
})
  // `failed_permanently` without `wait_run_id` cannot satisfy the terminal edge
  // out of `open` / `in_build`: `assistant_terminal_failure_documented` requires it to name the
  // case's most recent assistant run. Accepting the combination would let
  // POST/PATCH /api/cases and MCP `update_case` wedge a case through the
  // validated boundary, with no run marker for the sweep to find it by.
  //
  // Only that reason is constrained. Legacy `clarification` / `retry_exhausted`
  // documents remain round-trippable even when they predate run scoping; neither
  // value drives a live assistant transition anymore.
  .superRefine((assistant, ctx) => {
    if (assistant.wait_reason === 'failed_permanently' && !assistant.wait_run_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['wait_run_id'],
        message: "wait_run_id is required when wait_reason is 'failed_permanently'",
      });
    }
  });

export const createCaseSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(10000).default(''),
  source_type: sourceTypeSchema,
  source_ref: z.string().optional(),
  project_id: z.string().min(1),
  repository_id: z.string().min(1),
  validation_track: validationTrackSchema.optional(),
  risk_level: riskLevelSchema,
  priority: prioritySchema,
  case_type: caseTypeSchema.optional(),
  assistant_context: assistantContextSchema.optional(),
  current_branch: z.string().optional(),
  current_pr_ref: prRefSchema.optional(),
  jira_refs: z.array(z.string().min(1).max(50)).optional(),
  assigned_reviewer_id: z.string().optional(),
  active_rule_set_refs: z.array(z.string()).optional(),
  knowledge_context_refs: z.array(z.string()).optional(),
  attachments: z.array(inlineAttachmentSchema).max(20).optional(),
  git_context: gitContextSchema.optional(),
});

export const updateCaseSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().min(1).max(10000).optional(),
  project_id: z.string().min(1).optional(),
  validation_track: validationTrackSchema.optional(),
  risk_level: riskLevelSchema.optional(),
  priority: prioritySchema.optional(),
  case_type: caseTypeSchema.optional(),
  assistant_context: assistantContextSchema.optional(),
  current_branch: z.string().optional(),
  current_pr_ref: prRefSchema.optional(),
  jira_refs: z.array(z.string().min(1).max(50)).optional(),
  assigned_reviewer_id: z.string().optional(),
  active_rule_set_refs: z.array(z.string()).optional(),
  knowledge_context_refs: z.array(z.string()).optional(),
});

export const caseFiltersSchema = z.object({
  status: caseStatusSchema.optional(),
  project_id: z.string().optional(),
  repository_id: z.string().optional(),
  owner_user_id: z.string().optional(),
  validation_track: validationTrackSchema.optional(),
  risk_level: riskLevelSchema.optional(),
  priority: prioritySchema.optional(),
  current_branch: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(20),
});

export const resolveCaseByBranchSchema = z.object({
  repository_id: z.string().min(1),
  branch: z.string().min(1),
});

export type CreateCasePayload = z.infer<typeof createCaseSchema>;
export type UpdateCasePayload = z.infer<typeof updateCaseSchema>;
export type CaseFiltersPayload = z.infer<typeof caseFiltersSchema>;
export type ResolveCaseByBranchPayload = z.infer<typeof resolveCaseByBranchSchema>;
