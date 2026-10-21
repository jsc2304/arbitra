export interface Artifact {
  artifact_id: string;
  case_id?: string;
  run_id?: string;
  comment_id?: string;
  filename: string;
  content_type: string;
  storage_path: string;
  size_bytes: number;
  created_by: string;
  created_at: string;
}

export interface CreateArtifactInput {
  case_id?: string;
  run_id?: string;
  filename: string;
  content_type: string;
  size_bytes: number;
}

/**
 * Inline attachment for case creation — allows files to be sent
 * as base64-encoded data alongside the case payload in a single API call.
 * Used by IDE integrations and CLI clients.
 */
export interface InlineAttachment {
  filename: string;
  content_type: string;
  /** Base64-encoded file content (without data URL prefix) */
  data: string;
}

/**
 * Git context auto-detected by IDE/CLI clients.
 * Allows pre-filling branch, repo, and PR information from the working directory.
 * The API uses this to populate case fields and link to the correct repository.
 */
export interface GitContext {
  /** Current branch name, e.g. "feature/ARB-101-user-auth" */
  branch?: string;
  /** Git remote URL, e.g. "https://github.com/org/repo.git" or "git@github.com:org/repo.git" */
  remote_url?: string;
  /** Current commit SHA */
  commit_sha?: string;
  /** Pull request reference (URL or number) */
  pr_ref?: string;
  /** Absolute path to repository root */
  repo_root?: string;
  /** PR title (provided by IDE agents or webhooks) */
  pr_title?: string;
  /** PR body/description */
  pr_body?: string;
  /** PR labels */
  pr_labels?: string[];
  /** List of changed file paths relative to repo root */
  changed_files?: string[];
  /** Commit messages from the branch (e.g., git log main..HEAD --oneline) */
  commit_messages?: string[];
}
