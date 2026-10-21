export type KnowledgeType =
  | 'precedent'
  | 'pattern'
  | 'anti_pattern'
  | 'mock_template'
  | 'implementation_note'
  | 'review_guideline'
  | 'architecture_decision'
  | 'exception_policy'
  | (string & {});

export type KnowledgeStatus =
  | 'suggested'
  | 'verified'
  | 'canonical'
  | 'deprecated'
  | 'superseded';

export type KnowledgeScopeType = 'global' | 'org' | 'team' | 'project' | 'repo';

export interface KnowledgeAsset {
  knowledge_id: string;
  type: KnowledgeType;
  title: string;
  summary: string;
  body: string;
  scope_type: KnowledgeScopeType;
  scope_ref: string;
  status: KnowledgeStatus;
  version: number;
  trust_level: number;
  source_case_refs: string[];
  source_decision_refs: string[];
  tags: string[];
  artifact_refs: string[];
  created_by: string;
  approved_by?: string;
  last_referenced_at?: string;
  expires_at?: string;
  created_at: string;
  updated_at: string;
  /**
   * Marks a `type: 'clerk_context'` asset as standing context for its owner:
   * injected verbatim into every one of their Clerk task prompts (bounded —
   * `AssistantBounds.maxInjectedContextEntries`/`maxInjectedContextChars`),
   * rather than merely findable through `arbitra_search_knowledge` (#832
   * slice A). A dedicated boolean over a tag convention, so "is this entry
   * always-relevant" is explicit and queryable rather than inferred from
   * string matching on `tags`. Absent/`false` on every asset outside Clerk's
   * own context tab.
   */
  always_inject?: boolean;
}

export interface CreateKnowledgeAssetInput {
  type: KnowledgeType;
  title: string;
  summary: string;
  body: string;
  scope_type: KnowledgeScopeType;
  scope_ref: string;
  tags?: string[];
  expires_at?: string;
  source_case_refs?: string[];
  source_decision_refs?: string[];
  /** See `KnowledgeAsset.always_inject`. */
  always_inject?: boolean;
}

/**
 * Partial update payload for an existing KnowledgeAsset.
 *
 * All fields are optional. Lifecycle / provenance fields (status, version,
 * trust_level, approved_by, created_by, source_case_refs, source_decision_refs,
 * artifact_refs) are excluded — those have separate transition paths.
 */
export interface UpdateKnowledgeAssetInput {
  title?: string;
  summary?: string;
  body?: string;
  type?: KnowledgeType;
  scope_type?: KnowledgeScopeType;
  scope_ref?: string;
  tags?: string[];
  expires_at?: string;
  /** See `KnowledgeAsset.always_inject`. */
  always_inject?: boolean;
}
