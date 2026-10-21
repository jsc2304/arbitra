import type { RiskLevel } from './case.js';

export type LlmProviderName = 'anthropic' | 'openai' | 'google' | 'openrouter';

/** A model spec for multi-LLM consensus review. */
export interface ConsensusModelSpec {
  provider: LlmProviderName;
  model: string;
}

export interface LlmSettings {
  provider: LlmProviderName;
  models: Record<RiskLevel, string>;
  /** When set, multiple LLMs review in parallel and findings receive consensus metadata. */
  consensus_models?: ConsensusModelSpec[];
  updated_at: string;
  updated_by: string;
}
