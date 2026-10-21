// Services — Case
export { CaseService } from './services/case/case-service.js';
export { CaseRepository } from './services/case/case-repository.js';
export { CaseExportService, formatAuditAsMarkdown } from './services/case/case-export-service.js';
export { CaseTemplateService } from './services/case/case-template-service.js';
export { assertBranchUniqueForCase, BranchConflictError } from './services/case/branch-uniqueness.js';
export { resolveCaseByBranch } from './services/case/branch-resolution.js';
export type { ResolveCaseByBranchInput, ResolveCaseByBranchResult } from './services/case/branch-resolution.js';

// Services — Assistant
export {
  AssistantIntakeService,
  AssistantIntakeLimitError,
  ClerkCoreNotProvisionedError,
  assistantIntakeReceiptId,
  assistantFollowUpReceiptKey,
  resolveAssistantIntakeLimits,
  resolveAssistantVersions,
  buildCaseDocument,
  deriveTitle as deriveAssistantTaskTitle,
  startOfUtcDay,
} from './services/assistant/assistant-intake-service.js';
export type {
  AssistantIntakeLimits,
  AssistantIntakeResult,
} from './services/assistant/assistant-intake-service.js';
export {
  AssistantFollowUpService,
  AssistantFollowUpError,
  assertPinnedFollowUpSources,
} from './services/assistant/assistant-follow-up-service.js';
export {
  AssistantFeedbackService,
  AssistantFeedbackError,
  assistantFeedbackId,
} from './services/assistant/assistant-feedback-service.js';
export {
  clerkCoreIds,
  CLERK_CORE_ID_SALT,
  CLERK_CORE_ID_SUFFIX_LENGTH,
} from './services/assistant/clerk-core.js';
export type { ClerkCoreIds } from './services/assistant/clerk-core.js';
export {
  TaskBlueprintService,
  TaskBlueprintArchivedError,
  TaskBlueprintOverlapError,
  buildBlueprintOccurrenceIdempotencyKey,
  findNonTerminalBlueprintCaseId,
  createBlueprintOccurrence,
} from './services/assistant/task-blueprint-service.js';
export type {
  TaskBlueprintServiceOptions,
  TaskBlueprintRunNowResult,
  BlueprintOccurrenceResult,
  BlueprintOccurrenceOutcome,
} from './services/assistant/task-blueprint-service.js';
export {
  BlueprintTickService,
  computeDueFireTimes,
  BLUEPRINT_TICK_WINDOW_MS,
  BLUEPRINT_TICK_SAFETY_MARGIN_MS,
} from './services/assistant/blueprint-tick-service.js';
export type {
  BlueprintTickServiceOptions,
  BlueprintTickSummary,
  BlueprintTickDispatch,
  BlueprintTickError,
} from './services/assistant/blueprint-tick-service.js';
export {
  CLERK_PROJECT_NAME,
  CLERK_PROJECT_DESCRIPTION,
  CLERK_REPOSITORY_NAME,
  CLERK_REPOSITORY_URL,
  CLERK_POLICY_RULES,
  buildClerkProject,
  buildClerkRepository,
  buildClerkEvidencePolicy,
} from './services/assistant/clerk-core-documents.js';
export { ProvisionClerkCoreService } from './services/assistant/provision-clerk-core-service.js';
export type {
  ClerkCoreDocumentKind,
  ClerkCoreProvisionStatus,
  ClerkCoreProvisionItem,
  ClerkCoreProvisionResult,
} from './services/assistant/provision-clerk-core-service.js';
export { AssistantTaskExecutor } from './services/assistant/assistant-task-executor.js';
export type {
  AssistantRunOutcome,
  AssistantTaskExecutorOptions,
  AssistantTaskRunner,
} from './services/assistant/assistant-task-executor.js';
export { AssistantAnswerLookup } from './services/assistant/assistant-answer-lookup.js';
export {
  AssistantCancellationService,
  AssistantCancellationConflictError,
} from './services/assistant/assistant-cancellation-service.js';
export type {
  AssistantCancellationResult,
  AssistantCancellationReconcileInput,
  AssistantCancellationReconcileResult,
} from './services/assistant/assistant-cancellation-service.js';
export {
  ASSISTANT_BOUND_IDS,
  boundFailureMessage,
  resolveAssistantBounds,
} from './services/assistant/assistant-bounds.js';
export type { AssistantBoundId, AssistantBounds } from './services/assistant/assistant-bounds.js';
export {
  checkAssistantTaskInput,
  decideAssistantPolicy,
} from './services/assistant/assistant-policy.js';
export type {
  AssistantPolicyDecision,
  AssistantTaskKind,
} from './services/assistant/assistant-policy.js';
export {
  ASSISTANT_SYSTEM_PROMPT,
  answerPreview,
  buildAssistantUserMessage,
  fenceUntrusted,
  validateAssistantAnswer,
} from './services/assistant/assistant-prompt.js';
export {
  ASSISTANT_TOOL_REGISTRY,
  TOOL_CONNECTORS,
  TOOL_EFFECTS,
  TOOL_RISK_CLASSES,
  TOOL_SCOPES,
  ToolDescriptorError,
  assertToolDescriptor,
  buildReadToolSet,
  findToolDescriptor,
  isReadToolDescriptor,
  selectReadTools,
  toolDescriptorNames,
} from './services/assistant/tool-registry.js';
export type {
  AnyReadToolDescriptor,
  AnyToolDescriptor,
  AssistantToolDescriptor,
  ProposeToolDescriptor,
  ReadToolDescriptor,
  ToolCallGuard,
  ToolCallRecord,
  ToolConnector,
  ToolEffect,
  ToolProposal,
  ToolReadContext,
  ToolRiskClass,
  ToolScope,
} from './services/assistant/tool-registry.js';

// Services — Event
export { EventService } from './services/event/event-service.js';
export { EventRepository } from './services/event/event-repository.js';

// Services — Orchestration
export { OrchestrationService } from './services/orchestration/orchestration-service.js';
export {
  applyTransitionInTransaction,
  loadTransactionPreconditionContext,
} from './services/orchestration/transition-core.js';
export type {
  TransitionCoreDeps,
  TransitionCoreOptions,
  TransitionCoreResult,
} from './services/orchestration/transition-core.js';
export { StateMachine } from './services/orchestration/state-machine.js';
export { createPreconditionEvaluator } from './services/orchestration/preconditions.js';
export type { PreconditionContext, PreconditionEvaluator, PreconditionResult } from './services/orchestration/preconditions.js';
export { RunCompletionHandler } from './services/orchestration/pipeline.js';
export type { PipelineResult, NextAction, RunScheduledCallback } from './services/orchestration/pipeline.js';
export type { PipelineAdapter } from './services/orchestration/pipeline-adapter.js';
export { FirestorePipelineAdapter } from './services/orchestration/firestore-pipeline-adapter.js';
export { closeOutstandingWaiverProposalsOnCompletion } from './services/orchestration/waiver-completion.js';
export type {
  WaiverCompletionContext,
  WaiverCompletionResult,
} from './services/orchestration/waiver-completion.js';
export { RunExecutor } from './services/orchestration/run-executor.js';
export {
  MAX_RUN_RETRIES,
  RUN_RETRY_BACKOFF_MS,
  classifyRunFailure,
  retryBackoffMs,
} from './services/orchestration/run-retry-policy.js';
export type { RunFailureClassification } from './services/orchestration/run-retry-policy.js';
export { RunSweepService } from './services/orchestration/run-sweep-service.js';
export type {
  RunSweepResult,
  SweptRunSummary,
  StaleRunEntry,
  StaleRunReason,
  AssistantSweepResult,
  AssistantClaimSummary,
  AssistantReattemptSummary,
  AssistantExhaustedSummary,
  AssistantFailureRepairSummary,
  AssistantCancellationReconcileSummary,
} from './services/orchestration/run-sweep-service.js';
export {
  acquireRunSweepLock,
  RunSweepLockHeldError,
  RUN_SWEEP_LOCKS_COLLECTION,
  RUN_SWEEP_LOCK_DOC_ID,
  ASSISTANT_SWEEP_LOCK_DOC_ID,
  RUN_SWEEP_LOCK_TTL_MS,
} from './services/orchestration/run-sweep-lock.js';
export type { RunSweepLockHandle, RunSweepLockRecord } from './services/orchestration/run-sweep-lock.js';

// Services — Evidence
export { EvidenceService } from './services/evidence/evidence-service.js';
export { EvidenceRepository } from './services/evidence/evidence-repository.js';
export { CompletenessEvaluator } from './services/evidence/completeness-evaluator.js';
export type { CompletenessResult } from './services/evidence/completeness-evaluator.js';

// Services — Rule
export { RuleService } from './services/rule/rule-service.js';
export { RuleRepository } from './services/rule/rule-repository.js';
export { resolveRuleLayers } from './services/rule/layering.js';
export { detectConflicts, computeRuleConflictSignature } from './services/rule/conflict-detector.js';
export type { RuleConflict } from './services/rule/conflict-detector.js';
export { RuleOverrideService } from './services/rule/rule-override-service.js';

// Services — Review
export { ReviewService } from './services/review/review-service.js';
export { consolidateObservations } from './services/review/consolidation.js';
export { computeFindingSignature } from './services/review/finding-signature.js';
export { LlmReviewAdapter, RetriesExhaustedError } from './services/review/adapters/llm-adapter.js';
export { PromptService, invalidatePromptCache } from './services/review/prompt-service.js';
export { DEFAULT_PROMPTS } from './services/review/default-prompts.js';

// Services — Decision
export { DecisionService } from './services/decision/decision-service.js';
export type { CreateDecisionResult } from './services/decision/decision-service.js';
export { checkFourEyes } from './services/decision/four-eyes-checker.js';
export type { FourEyesResult } from './services/decision/four-eyes-checker.js';
export { checkSelfApprovalProhibition, checkWaivePermission, shouldCreateRiskDowngradeAudit } from './services/decision/anti-gaming.js';

// Services — Knowledge
export { KnowledgeService } from './services/knowledge/knowledge-service.js';
export { KnowledgeRepository } from './services/knowledge/knowledge-repository.js';

// Services — Notification
export { NotificationService } from './services/notification/notification-service.js';
export { NotificationRepository } from './services/notification/notification-repository.js';
export { EventNotifier } from './services/notification/event-notifier.js';
export { GoogleChatNotifier } from './services/notification/google-chat-notifier.js';
export { NotificationDispatcher } from './services/notification/notification-dispatcher.js';

// Services — Chat
export { mapChatIdentity } from './services/chat/chat-identity-service.js';
export type {
  ChatIdentityMappingOutcome,
  MapChatIdentityParams,
  MapChatIdentityResult,
} from './services/chat/chat-identity-service.js';
export {
  GoogleChatReplyPoster,
  getChatReplyPoster,
  setChatReplyPosterForTesting,
  truncateForChat,
  markdownToChatText,
  CHAT_MESSAGE_MAX_BYTES,
} from './services/chat/chat-reply-poster.js';
export type {
  ChatReplyPoster,
  ChatReplyTarget,
  ChatReplyResult,
  ChatHttpResponse,
  ChatHttpSend,
} from './services/chat/chat-reply-poster.js';
export {
  resolveChatThreadCase,
  recordChatThreadTip,
  chatThreadLinkId,
} from './services/chat/chat-thread-link-service.js';
export type { ChatContinuityLink } from './services/chat/chat-thread-link-service.js';
export {
  shouldRestartChatConversation,
  resolveUserChatConversationWindow,
  CHAT_IDLE_GAP_MS,
} from './services/chat/chat-conversation-window.js';

// Services — Diff
export { DiffResolver } from './services/diff/diff-resolver.js';
export type { DiffResult } from './services/diff/diff-resolver.js';

// Services — Webhook
export { WebhookService, shouldBlockAutoCaseCreation, findCaseByPrUrl, parseRepoRef, sameRepoRef, GITHUB_HOST } from './services/webhook/webhook-service.js';
export type { ParsedRepoRef } from './services/webhook/webhook-service.js';
export type { CIWebhookResult } from './services/webhook/webhook-service.js';
export { verifyGitHubSignature, parseGitHubWebhook, fetchPullRequestChangedFiles } from './services/webhook/github-adapter.js';
export { parseCIWebhook, verifyCIWebhookSignature } from './services/webhook/ci-adapter.js';
export { PrMergeChecker } from './services/webhook/pr-merge-checker.js';
export { findDuplicateGithubRepositoryIds, repositoryUrlConflictEventId } from './services/webhook/repository-identity.js';
export type { DuplicateRepositoryIdGroup } from './services/webhook/repository-identity.js';
export {
  publishCaseCommitStatus,
  publishNoCaseCommitStatus,
  computeCommitStatusVerdict,
  isEnforcedCase,
  ARBITRA_COMMIT_STATUS_CONTEXT,
} from './services/webhook/commit-status-service.js';
export type {
  CommitStatusState,
  CommitStatusVerdict,
  PublishCommitStatusResult,
} from './services/webhook/commit-status-service.js';
export { republishCommitStatus } from './services/webhook/commit-status-admin-service.js';
export type {
  RepublishCommitStatusInput,
  RepublishCommitStatusResult,
} from './services/webhook/commit-status-admin-service.js';

// Services — Case Detection
export { detectCaseFields } from './services/case-detection/case-detection-service.js';
export type { DetectionInput, DetectionResult } from './services/case-detection/case-detection-service.js';

// Services — Artifact
export { ArtifactService } from './services/artifact/artifact-service.js';

// Services — Intelligence
export {
  IntelligenceService,
  FirestoreDetectorContext,
  ALL_DETECTORS,
  THRESHOLDS as INTELLIGENCE_THRESHOLDS,
  INTELLIGENCE_ACTOR_ID,
  INTELLIGENCE_CLIENT_NAME,
  buildSignature,
  intelligenceActorMetadata,
  parseEvidenceSummary,
  EVIDENCE_SUMMARY_DELIMITER,
  acquireIntelligenceRunLock,
  IntelligenceLockHeldError,
  INTELLIGENCE_LOCKS_COLLECTION,
  INTELLIGENCE_RUN_LOCK_DOC_ID,
  INTELLIGENCE_LOCK_TTL_MS,
  agingPendingMergeDetector,
  staleOpenDetector,
  orphanBranchDetector,
  repeatedReworkDetector,
  highRiskWithoutFourEyesDetector,
  RunHistoryRepository,
  DetectorConfigRepository,
  DETECTOR_CONFIG_DOC_ID,
} from './services/intelligence/index.js';
export type {
  Detector,
  DetectionResult as IntelligenceDetectionResult,
  DetectorContext,
  DetectorRunSummary,
  ParsedEvidenceSummary,
  IntelligenceLockHandle,
  IntelligenceLockRecord,
  IntelligenceRunOptions,
} from './services/intelligence/index.js';

// Services — Helper Bot
export { HelperBotService } from './services/helper-bot/helper-bot-service.js';
export type { HelperBotAnswer } from './services/helper-bot/helper-bot-service.js';
export { loadDocsCorpus } from './services/helper-bot/corpus-loader.js';
export { loadKnowledgeAssets } from './services/helper-bot/knowledge-loader.js';
export { assembleSystemPrompt } from './services/helper-bot/prompt-assembler.js';

// Services — Activity
export {
  listActivity,
  buildLeaderboard,
  aggregateLeaderboard,
  normalizeEvent,
  normalizeComment,
  normalizeEvidence,
  normalizeFinding,
  normalizeDecision,
  normalizeWorkspaceEvent,
  applyActivityFilters,
} from './services/activity/activity-service.js';
export type {
  ListActivityOptions,
  ListActivityResult,
} from './services/activity/activity-service.js';

// Services — Agent Presence
export {
  upsertPresence,
  safeHeartbeat,
  presenceDocId,
} from './services/agent-presence/agent-presence-service.js';
export type { UpsertPresenceInput } from './services/agent-presence/agent-presence-service.js';

// Services — WorkspaceEvent
export { WorkspaceEventService } from './services/workspace-event/workspace-event-service.js';
export type { RecordWorkspaceEventInput } from './services/workspace-event/workspace-event-service.js';

// Services — Session Signals (#983, #990)
export {
  ingestSessionSignalBatch,
  listActiveSessions,
  listSessionsSince,
  isSessionEntryActive,
  sessionSignalEventDocId,
} from './services/session/session-signal-service.js';
export type { IngestSessionSignalBatchOptions } from './services/session/session-signal-service.js';

// Services — Mission Control (#989, #990, bounded reads #1003)
export {
  buildMissionControlAggregate,
  buildActiveSessionsPanel,
  resolveSessionRepositories,
  applyMissionControlRowCap,
} from './services/session/mission-control-service.js';
export type {
  BuildMissionControlAggregateOptions,
  BuildActiveSessionsPanelOptions,
} from './services/session/mission-control-service.js';

// Services — Observed Cases (#986)
export {
  ensureObservedCaseForSignal,
  observedCaseClaimDocId,
} from './services/case/observed-case-service.js';
export type { ObservedCaseSignalInput } from './services/case/observed-case-service.js';

// Services — Observed Case Escalation (#987)
export { evaluateObservedCaseEscalation } from './services/case/case-escalation-service.js';
export type {
  EscalationSignalInput,
  EscalationDependencies,
  EscalationResult,
} from './services/case/case-escalation-service.js';

// Lib
export { getFirebaseApp } from './lib/firebase.js';
export { getDb, collections } from './lib/firestore.js';
export { sealSecret, openSecret, openRepositoryToken } from './lib/secret-box.js';
export { getCloudStorage, getBucket } from './lib/storage.js';
export { getArtifactStorage, setArtifactStorage, resetArtifactStorage, LocalStorageAdapter, CloudStorageAdapter } from './lib/artifact-storage.js';
export type { ArtifactStorageAdapter } from './lib/artifact-storage.js';
export { verifyToken, extractBearerToken } from './lib/auth.js';
export { getEffectiveMembers, isEffectiveMember, getAccessibleProjectIds, checkIsAdmin, checkCaseAccess, checkArtifactCaseAccess, checkProjectAccess } from './lib/project-access.js';
export type { ArtifactCaseAccessDecision } from './lib/project-access.js';
export { generateId } from './lib/ids.js';
export { resolveModel, resolveModelForRisk, getDefaultModel, getModelForRisk, getEffectiveLlmSettings, invalidateLlmSettingsCache, invalidateProjectConfigCache, getHardcodedDefaults } from './lib/llm-provider.js';

// Middleware
export { authenticateFromHeader, generatePAT, hashToken } from './middleware/auth-middleware.js';
export type { AuthenticatedRequest } from './middleware/auth-middleware.js';
export { formatError } from './middleware/error-handler.js';
export type { ErrorResponse } from './middleware/error-handler.js';
export { requireRole } from './middleware/role-middleware.js';
export { validateBody } from './middleware/request-validator.js';
export { formatValidationIssues } from './middleware/validation-issues.js';
export type { StructuredValidationIssue } from './middleware/validation-issues.js';
