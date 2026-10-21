export interface PromptTemplate {
  template_id: string;
  /** Unique identifier for the prompt type, e.g. 'review_system', 'rule_evaluation_system' */
  slug: string;
  name: string;
  description?: string;
  /** The actual prompt text */
  content: string;
  /** Incrementing version number (per slug) */
  version: number;
  /** Only one active version per slug */
  is_active: boolean;
  created_at: string;
  updated_at: string;
  created_by: string;
  updated_by?: string;
}
