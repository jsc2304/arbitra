import { agingPendingMergeDetector } from './detectors/aging-pending-merge.js';
import { staleOpenDetector } from './detectors/stale-open.js';
import { orphanBranchDetector } from './detectors/orphan-branch.js';
import { repeatedReworkDetector } from './detectors/repeated-rework.js';
import { highRiskWithoutFourEyesDetector } from './detectors/high-risk-without-four-eyes.js';
import { incompleteRepoSetupDetector } from './detectors/incomplete-repo-setup.js';
import type { Detector } from './detector-types.js';

/**
 * Registered V1 detectors, in the order they run each cycle.
 *
 * To disable a detector in production: comment out its entry here and
 * redeploy. No config flag is exposed in V1 — the call-site is the source
 * of truth.
 */
export const ALL_DETECTORS: Detector[] = [
  agingPendingMergeDetector,
  staleOpenDetector,
  orphanBranchDetector,
  repeatedReworkDetector,
  highRiskWithoutFourEyesDetector,
  incompleteRepoSetupDetector,
];

export { IntelligenceService } from './intelligence-service.js';
export {
  parseEvidenceSummary,
  EVIDENCE_SUMMARY_DELIMITER,
  type ParsedEvidenceSummary,
  type IntelligenceRunOptions,
} from './intelligence-service.js';
export { RunHistoryRepository } from './run-history-repository.js';
export { DetectorConfigRepository, CONFIG_DOC_ID as DETECTOR_CONFIG_DOC_ID } from './detector-config-repository.js';
export {
  acquireIntelligenceRunLock,
  IntelligenceLockHeldError,
  INTELLIGENCE_LOCKS_COLLECTION,
  INTELLIGENCE_RUN_LOCK_DOC_ID,
  INTELLIGENCE_LOCK_TTL_MS,
  type IntelligenceLockHandle,
  type IntelligenceLockRecord,
} from './intelligence-lock.js';
export { FirestoreDetectorContext } from './firestore-context.js';
export { THRESHOLDS, INTELLIGENCE_ACTOR_ID, INTELLIGENCE_CLIENT_NAME } from './config.js';
export { buildSignature, intelligenceActorMetadata } from './detector-types.js';
export type {
  Detector,
  DetectionResult,
  DetectorContext,
  DetectorRunSummary,
} from './detector-types.js';

export { agingPendingMergeDetector } from './detectors/aging-pending-merge.js';
export { staleOpenDetector } from './detectors/stale-open.js';
export { orphanBranchDetector } from './detectors/orphan-branch.js';
export { repeatedReworkDetector } from './detectors/repeated-rework.js';
export { highRiskWithoutFourEyesDetector } from './detectors/high-risk-without-four-eyes.js';
export { incompleteRepoSetupDetector } from './detectors/incomplete-repo-setup.js';
