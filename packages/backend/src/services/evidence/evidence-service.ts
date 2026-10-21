import type { Case, Evidence, CreateEvidenceInput } from '@arbitra/shared';
import { normalizeActorMetadata } from '@arbitra/shared';
import { EvidenceRepository } from './evidence-repository.js';
import { CompletenessEvaluator, type CompletenessResult } from './completeness-evaluator.js';
import { EventService } from '../event/event-service.js';
import { CaseRepository } from '../case/case-repository.js';
import { generateId } from '../../lib/ids.js';
import { RunCompletionHandler } from '../orchestration/pipeline.js';
import type { PipelineAdapter } from '../orchestration/pipeline-adapter.js';

export class EvidenceService {
  private readonly pipeline: RunCompletionHandler | null;

  constructor(
    private readonly evidenceRepo = new EvidenceRepository(),
    private readonly completenessEvaluator = new CompletenessEvaluator(),
    private readonly eventService = new EventService(),
    private readonly caseRepo = new CaseRepository(),
    pipelineAdapter?: PipelineAdapter,
  ) {
    this.pipeline = pipelineAdapter ? new RunCompletionHandler(pipelineAdapter) : null;
  }

  async registerEvidence(input: CreateEvidenceInput, actorId: string): Promise<Evidence> {
    const case_ = await this.caseRepo.getById(input.case_id);

    const actorMetadata = normalizeActorMetadata(input.actor_metadata);

    // Dedupe path: `file_edit` evidence with an `artifact_ref` collapses
    // onto a single row per `(case_id, artifact_ref)`. The Cursor
    // `afterFileEdit` hook fires on every save, which would otherwise
    // produce 7+ rows per build for a single file. Only the first
    // create emits a `case_event` and triggers the pipeline; repeats
    // just bump `edit_count` + `updated_at`.
    if (input.type === 'file_edit' && input.artifact_ref) {
      const existing = await this.evidenceRepo.findFileEditByArtifact(
        input.case_id,
        input.artifact_ref,
      );
      if (existing) {
        const updatedAt = new Date().toISOString();
        await this.evidenceRepo.incrementEditCount(existing.evidence_id, updatedAt);
        return {
          ...existing,
          edit_count: (existing.edit_count ?? 1) + 1,
          updated_at: updatedAt,
        };
      }
    }

    const evidence: Evidence = {
      evidence_id: generateId('evidence'),
      case_id: input.case_id,
      run_id: input.run_id,
      type: input.type,
      source_type: input.source_type,
      artifact_ref: input.artifact_ref,
      summary: input.summary,
      machine_readable: input.machine_readable ?? false,
      validation_track: case_.validation_track,
      created_at: new Date().toISOString(),
      created_by: actorId,
      ...(input.type === 'file_edit' && input.artifact_ref && { edit_count: 1 }),
      ...(actorMetadata !== undefined && { actor_metadata: actorMetadata }),
    };

    await this.evidenceRepo.create(evidence);

    await this.eventService.emit(
      input.case_id,
      'evidence_registered',
      { evidence_id: evidence.evidence_id, type: input.type },
      actorId,
    );

    // Re-evaluate completeness and update case.decision_ready
    await this.updateDecisionReady(case_);

    return evidence;
  }

  async getEvidenceForCase(caseId: string): Promise<Evidence[]> {
    return this.evidenceRepo.getByCaseId(caseId);
  }

  async evaluateCompleteness(caseId: string): Promise<CompletenessResult> {
    const case_ = await this.caseRepo.getById(caseId);
    const evidence = await this.evidenceRepo.getByCaseId(caseId);
    return this.completenessEvaluator.evaluate(case_, evidence);
  }

  private async updateDecisionReady(case_: Case): Promise<void> {
    const evidence = await this.evidenceRepo.getByCaseId(case_.case_id);
    const completeness = await this.completenessEvaluator.evaluate(case_, evidence);

    if (completeness.satisfied !== case_.decision_ready) {
      await this.caseRepo.update(case_.case_id, {
        decision_ready: completeness.satisfied,
        updated_at: new Date().toISOString(),
      });

      // When evidence becomes satisfied, trigger pipeline for auto-transitions.
      // Non-critical: pipeline failure doesn't block the evidence update — but
      // log it so silent drops are visible in Cloud Logging / CI output.
      if (completeness.satisfied && this.pipeline) {
        this.pipeline.onRunCompleted(case_.case_id).catch((err) => {
          console.error(
            `[pipeline] onRunCompleted failed after evidence registration (case ${case_.case_id}):`,
            err,
          );
        });
      }
    }
  }
}
