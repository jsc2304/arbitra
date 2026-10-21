import type { CaseType, RiskLevel, Priority, ValidationTrack } from './case.js';

export interface CaseTemplate {
  template_id: string;
  project_id: string;
  name: string;
  description: string;
  /** Pre-filled case fields */
  defaults: CaseTemplateDefaults;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface CaseTemplateDefaults {
  case_type?: CaseType;
  risk_level?: RiskLevel;
  priority?: Priority;
  validation_track?: ValidationTrack;
  title_prefix?: string;
  description_template?: string;
  active_rule_set_refs?: string[];
}

export interface CreateCaseTemplateInput {
  project_id: string;
  name: string;
  description?: string;
  defaults: CaseTemplateDefaults;
}
