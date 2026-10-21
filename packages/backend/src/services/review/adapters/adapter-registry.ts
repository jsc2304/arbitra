import type { ConsensusModelSpec } from '@arbitra/shared';
import type { ReviewerAdapter } from './reviewer-adapter.js';
import { LlmReviewAdapter } from './llm-adapter.js';

const adapters = new Map<string, ReviewerAdapter>();

export function registerAdapter(adapter: ReviewerAdapter): void {
  adapters.set(adapter.name, adapter);
}

export function getAdapter(name: string): ReviewerAdapter | undefined {
  return adapters.get(name);
}

export function getAllAdapters(): ReviewerAdapter[] {
  return Array.from(adapters.values());
}

/**
 * Build an adapter list for consensus mode.
 * Creates one LlmReviewAdapter per model spec, each with an explicit provider + model.
 * The returned adapters are independent of the global registry.
 */
export function buildConsensusAdapters(specs: ConsensusModelSpec[]): ReviewerAdapter[] {
  return specs.map((spec) => new LlmReviewAdapter(spec.provider, spec.model));
}

// Register built-in adapters (single-model default)
registerAdapter(new LlmReviewAdapter());
