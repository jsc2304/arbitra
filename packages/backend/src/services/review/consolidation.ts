import type { FindingSeverity, FindingCategory, FindingConsensus } from '@arbitra/shared';
import type { ReviewObservation } from './adapters/reviewer-adapter.js';
import { computeFindingSignature } from './finding-signature.js';

const SEVERITY_ORDER: Record<string, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export interface ConsolidatedFinding {
  signature: string;
  category: FindingCategory;
  severity: FindingSeverity;
  confidence: number;
  severity_contested: boolean;
  title: string;
  description: string;
  location?: string;
  source_refs: string[];
  observations: ReviewObservation[];
  /** Present when multiple LLM reviewers ran (consensus mode). */
  consensus?: FindingConsensus;
}

/**
 * Phase 1: Deterministic hash-based deduplication.
 * Groups observations by finding_signature, then:
 * - Severity = max(group)
 * - Confidence = avg(group), adjusted by consensus agreement
 * - severity_contested = true if spread >= 2 severity levels
 *
 * @param reviewerCount - Total number of independent reviewers that ran.
 *   When >= 2, consensus metadata is computed and confidence is adjusted:
 *   - agreement_ratio >= 0.67 → confidence boosted by 0.15 (cap 1.0)
 *   - agreement_ratio <= 0.33 → confidence reduced by 0.15 (floor 0.1)
 */
export function consolidateObservations(
  caseId: string,
  observations: ReviewObservation[],
  reviewerCount?: number,
): ConsolidatedFinding[] {
  const isConsensus = reviewerCount != null && reviewerCount >= 2;

  // Group by signature
  const groups = new Map<string, ReviewObservation[]>();

  for (const obs of observations) {
    const sig = computeFindingSignature(caseId, obs);
    const existing = groups.get(sig) ?? [];
    existing.push(obs);
    groups.set(sig, existing);
  }

  // Consolidate each group
  const findings: ConsolidatedFinding[] = [];

  for (const [signature, group] of groups) {
    const first = group[0]!;

    // Severity = max
    let maxSeverityOrder = -1;
    let minSeverityOrder = Infinity;
    let maxSeverity: FindingSeverity = 'info';

    for (const obs of group) {
      const order = SEVERITY_ORDER[obs.severity] ?? 0;
      if (order > maxSeverityOrder) {
        maxSeverityOrder = order;
        maxSeverity = obs.severity as FindingSeverity;
      }
      if (order < minSeverityOrder) {
        minSeverityOrder = order;
      }
    }

    // Confidence = avg
    let avgConfidence =
      group.reduce((sum, obs) => sum + obs.confidence, 0) / group.length;

    // severity_contested if spread >= 2
    const severityContested = maxSeverityOrder - minSeverityOrder >= 2;

    // Consensus metadata
    let consensus: FindingConsensus | undefined;
    if (isConsensus) {
      // Count unique source refs (each adapter produces a unique source like "llm-google")
      const uniqueSources = new Set(group.map((obs) => obs.source));
      const agreementCount = uniqueSources.size;
      const agreementRatio = agreementCount / reviewerCount;

      // Extract model names from observations (prefer model field, fall back to source)
      const models = [...new Set(
        group.map((obs) => obs.model ?? obs.source).filter(Boolean) as string[],
      )];

      consensus = {
        reviewer_count: reviewerCount,
        agreement_count: agreementCount,
        agreement_ratio: Math.round(agreementRatio * 100) / 100,
        models,
      };

      // Adjust confidence based on consensus agreement.
      // Use < 0.34 / > 0.66 to handle exact fractions like 1/3 and 2/3 correctly.
      if (agreementRatio > 0.66) {
        avgConfidence = Math.min(1.0, avgConfidence + 0.15);
      } else if (agreementRatio < 0.34) {
        avgConfidence = Math.max(0.1, avgConfidence - 0.15);
      }
    }

    findings.push({
      signature,
      category: first.category as FindingCategory,
      severity: maxSeverity,
      confidence: Math.round(avgConfidence * 100) / 100,
      severity_contested: severityContested,
      title: first.title,
      description: first.description,
      location: first.location,
      source_refs: group.map((obs) => obs.source),
      observations: group,
      consensus,
    });
  }

  return findings;
}
