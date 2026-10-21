import crypto from 'node:crypto';
import type { ReviewObservation } from './adapters/reviewer-adapter.js';

/**
 * Generates a deterministic signature for deduplication.
 * finding_signature = SHA-256(case_id + normalized_location + rule_ref + category + normalized_claim)
 */
export function computeFindingSignature(
  caseId: string,
  observation: ReviewObservation,
): string {
  const normalizedLocation = normalizeLocation(observation.location ?? '');
  const normalizedClaim = normalizeClaim(observation.title + ' ' + observation.description);

  const input = [
    caseId,
    normalizedLocation,
    '', // rule_ref — empty for reviewer observations
    observation.category,
    normalizedClaim,
  ].join('|');

  return crypto.createHash('sha256').update(input).digest('hex');
}

function normalizeLocation(location: string): string {
  return location
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/lines?\s*\d+-\d+/g, (match) => match.replace(/\s/g, ''));
}

function normalizeClaim(claim: string): string {
  return claim
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s]/g, '');
}
