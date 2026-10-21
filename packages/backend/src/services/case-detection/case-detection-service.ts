/**
 * Auto-detection service for case fields.
 *
 * Given git context (branch, changed files, PR info), derives:
 * - case_type (bugfix, feature, refactor, ...)
 * - risk_level (low, medium, high, critical)
 * - priority (low, normal, high, urgent)
 * - jira_refs (extracted ticket IDs)
 * - validation_track (direct or manual)
 */

import type {
  CaseType,
  RiskLevel,
  Priority,
  ValidationTrack,
  GitContext,
} from '@arbitra/shared';
import {
  isCodeProducingCaseType,
  isProtectedBranch,
  suggestBranchForCaseType,
} from '@arbitra/shared';

export interface DetectionInput {
  git_context?: GitContext;
  /** List of changed file paths (relative to repo root) */
  changed_files?: string[];
  /** PR title if available */
  pr_title?: string;
  /** PR body/description if available */
  pr_body?: string;
  /** PR labels if available */
  pr_labels?: string[];
  /** Commit messages from the branch */
  commit_messages?: string[];
}

export interface DetectionResult {
  case_type: CaseType;
  case_type_reason: string;
  risk_level: RiskLevel;
  risk_level_reason: string;
  priority: Priority;
  priority_reason: string;
  validation_track: ValidationTrack;
  validation_track_reason: string;
  jira_refs: string[];
  suggested_title?: string;
  /**
   * Proposed feature-branch name when the caller is on `main`/`master`
   * and the detected case_type produces code changes.
   */
  suggested_branch?: string;
}

// -- Branch pattern matching --------------------------------------------------

const BRANCH_TYPE_MAP: Array<{ pattern: RegExp; type: CaseType; label: string }> = [
  { pattern: /^(feat|feature|story)\//, type: 'ticket_implementation', label: 'feature branch prefix' },
  { pattern: /^(fix|bugfix|hotfix)\//, type: 'bugfix', label: 'fix branch prefix' },
  { pattern: /^(refactor|cleanup|chore)\//, type: 'refactoring', label: 'refactor branch prefix' },
  { pattern: /^(security|sec)\//, type: 'security_review', label: 'security branch prefix' },
];

// -- File pattern matching for risk -------------------------------------------

/**
 * Documentation paths never raise risk above `low`, whatever their name.
 * Without this, `docs/deployment.md` matched the deploy-config pattern and
 * `docs/auth-guide.md` the auth pattern — a docs-only PR was rated `critical`
 * and asked for integration-test evidence (PR #1076).
 * Mirrors the `low` file patterns declared in `.arbitra/case-spec.json`
 * (`**\/*.md`, `**\/docs/**`).
 */
const DOC_FILE_EXTENSION = /\.(md|mdx|markdown|rst|txt)$/i;
const DOCS_DIRECTORY = /(^|\/)docs\//i;
// A `docs/` segment inside an app tree (`src/app/docs/page.tsx`,
// `api/docs/route.ts`) is code that renders docs, not documentation.
const CODE_FILE_EXTENSION =
  /\.(ts|tsx|js|jsx|mjs|cjs|vue|svelte|py|go|rb|java|kt|swift|rs|cs|php|c|cc|cpp|h|hpp|sh|ya?ml|json|toml|tf)$/i;

export function isDocumentationPath(path: string): boolean {
  if (DOC_FILE_EXTENSION.test(path)) return true;
  return DOCS_DIRECTORY.test(path) && !CODE_FILE_EXTENSION.test(path);
}

const RISK_FILE_PATTERNS: Array<{ pattern: RegExp; level: RiskLevel; label: string }> = [
  // Critical
  { pattern: /migration/i, level: 'critical', label: 'migration files' },
  // Deployment config is matched by location and file kind, not by the bare
  // word "deploy" anywhere in the path (which also hit docs and source files
  // whose name merely contains it). Covered: deploy scripts under scripts/,
  // anything inside a deploy/ or deployment/ directory (the `**/deploy/**`
  // glob declared in .arbitra/case-spec.json; docs inside it are already
  // excluded above), YAML with "deploy" in the file name (CI workflows, Cloud
  // Run service manifests), Cloud Build / Cloud Run / App Engine manifests,
  // and Firebase Hosting configs.
  { pattern: /(^|\/)scripts\/deploy[^/]*$/i, level: 'critical', label: 'deploy script' },
  { pattern: /(^|\/)deploy(ment)?\//i, level: 'critical', label: 'deployment config' },
  { pattern: /[^/]*deploy[^/]*\.ya?ml$/i, level: 'critical', label: 'deployment config' },
  { pattern: /(^|\/)(cloudbuild|cloudrun|cloud-run|service|app)\.ya?ml$/i, level: 'critical', label: 'cloud deployment manifest' },
  { pattern: /(^|\/)firebase(\.[^/]+)?\.json$/i, level: 'critical', label: 'Firebase deployment config' },
  { pattern: /infrastructure/i, level: 'critical', label: 'infrastructure changes' },
  { pattern: /Dockerfile/i, level: 'critical', label: 'Docker config' },
  { pattern: /docker-compose/i, level: 'critical', label: 'Docker Compose' },
  { pattern: /\.github\/workflows/i, level: 'critical', label: 'CI/CD workflow' },
  // High
  { pattern: /auth/i, level: 'high', label: 'authentication code' },
  { pattern: /security/i, level: 'high', label: 'security-sensitive code' },
  { pattern: /middleware/i, level: 'high', label: 'middleware' },
  { pattern: /\/api\//, level: 'high', label: 'API routes' },
  { pattern: /crypto/i, level: 'high', label: 'cryptography code' },
  { pattern: /package-lock\.json|yarn\.lock|pnpm-lock/i, level: 'high', label: 'dependency lockfile' },
  // Medium
  { pattern: /\/services\//, level: 'medium', label: 'service layer' },
  { pattern: /\/lib\//, level: 'medium', label: 'library code' },
  { pattern: /\/hooks\//, level: 'medium', label: 'hooks' },
  // Low indicators are the "else" case
];

const RISK_PRIORITY: Record<RiskLevel, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

// -- JIRA extraction ----------------------------------------------------------

const JIRA_PATTERN = /([A-Z]{2,10}-\d+)/g;

// -- Detection logic ----------------------------------------------------------

export function detectCaseFields(input: DetectionInput): DetectionResult {
  const branch = input.git_context?.branch ?? '';
  const allText = [
    branch,
    input.pr_title ?? '',
    input.pr_body ?? '',
    ...(input.commit_messages ?? []),
  ].join(' ');

  const caseTypeDetection = detectCaseType(branch, input.pr_labels);
  const suggestedTitle = input.pr_title ?? suggestTitleFromBranch(branch);

  const result: DetectionResult = {
    ...caseTypeDetection,
    ...detectRiskLevel(input.changed_files ?? [], allText),
    ...detectPriority(branch, input.pr_labels, allText),
    ...detectTrack(),
    jira_refs: extractJiraRefs(allText),
    suggested_title: suggestedTitle,
  };

  if (
    isProtectedBranch(branch) &&
    isCodeProducingCaseType(caseTypeDetection.case_type)
  ) {
    result.suggested_branch = suggestBranchForCaseType(
      caseTypeDetection.case_type,
      suggestedTitle ?? '',
    );
  }

  return result;
}

function detectCaseType(
  branch: string,
  prLabels?: string[],
): { case_type: CaseType; case_type_reason: string } {
  // Check PR labels first
  if (prLabels?.some((l) => /bug/i.test(l))) {
    return { case_type: 'bugfix', case_type_reason: 'PR label contains "bug"' };
  }
  if (prLabels?.some((l) => /feature|enhancement/i.test(l))) {
    return { case_type: 'ticket_implementation', case_type_reason: 'PR label indicates feature/enhancement' };
  }

  // Check branch prefix
  for (const { pattern, type, label } of BRANCH_TYPE_MAP) {
    if (pattern.test(branch)) {
      return { case_type: type, case_type_reason: label };
    }
  }

  return { case_type: 'other', case_type_reason: 'no matching branch pattern or PR label' };
}

function detectRiskLevel(
  changedFiles: string[],
  allText: string,
): { risk_level: RiskLevel; risk_level_reason: string } {
  if (changedFiles.length === 0) {
    // No file info — try text heuristics
    if (/migration|deploy|infrastructure/i.test(allText)) {
      return { risk_level: 'critical', risk_level_reason: 'text mentions critical infrastructure' };
    }
    if (/auth|security|crypto/i.test(allText)) {
      return { risk_level: 'high', risk_level_reason: 'text mentions security-sensitive topics' };
    }
    return { risk_level: 'medium', risk_level_reason: 'default — no file paths available for analysis' };
  }

  let highest: RiskLevel = 'low';
  let reason = 'documentation/test-only changes';

  for (const file of changedFiles) {
    // Docs are the "else" case (low) regardless of what the path is called.
    if (isDocumentationPath(file)) continue;
    for (const { pattern, level, label } of RISK_FILE_PATTERNS) {
      if (pattern.test(file) && RISK_PRIORITY[level] > RISK_PRIORITY[highest]) {
        highest = level;
        reason = `${label} (${file})`;
      }
    }
  }

  return { risk_level: highest, risk_level_reason: reason };
}

function detectPriority(
  branch: string,
  prLabels?: string[],
  allText?: string,
): { priority: Priority; priority_reason: string } {
  // Hotfix branches are urgent
  if (/^hotfix\//.test(branch)) {
    return { priority: 'urgent', priority_reason: 'hotfix branch' };
  }

  // PR labels
  if (prLabels?.some((l) => /blocker|critical|urgent/i.test(l))) {
    return { priority: 'urgent', priority_reason: 'PR label indicates urgency' };
  }
  if (prLabels?.some((l) => /high/i.test(l))) {
    return { priority: 'high', priority_reason: 'PR label indicates high priority' };
  }

  // Text analysis
  if (allText && /production (incident|outage|down)/i.test(allText)) {
    return { priority: 'urgent', priority_reason: 'text mentions production incident' };
  }
  if (allText && /security (vulnerability|issue|fix)/i.test(allText)) {
    return { priority: 'high', priority_reason: 'text mentions security vulnerability' };
  }

  return { priority: 'normal', priority_reason: 'default' };
}

function detectTrack(): { validation_track: ValidationTrack; validation_track_reason: string } {
  // Default to direct — manual track needs explicit selection by the developer
  return {
    validation_track: 'direct',
    validation_track_reason: 'default — override to manual if target system requires GUI/VPN testing',
  };
}

function extractJiraRefs(text: string): string[] {
  const matches = text.match(JIRA_PATTERN);
  if (!matches) return [];
  return [...new Set(matches)];
}

function suggestTitleFromBranch(branch: string): string | undefined {
  if (!branch) return undefined;
  // Remove prefix and convert to readable title
  const cleaned = branch
    .replace(/^(feat|feature|fix|bugfix|hotfix|refactor|chore|security|sec|story)\//, '')
    .replace(/[A-Z]{2,10}-\d+[-_]?/g, '') // remove JIRA refs
    .replace(/[-_]/g, ' ')
    .trim();
  if (!cleaned) return undefined;
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}
