/**
 * Customer-facing report rendering.
 *
 * Produces a business-language summary of a completed case for customer or
 * stakeholder consumption. Strips internal Arbitra vocabulary (findings,
 * evidence, decisions, rules, risk level, validation track, …) entirely —
 * both from the LLM prompt input and from the rendered output.
 *
 * The forbidden-vocabulary guard applies ONLY to generated prose
 * (summary, outcome_line, manual_test_steps). The "Changed Files" section is
 * exempt: real file paths (e.g. `packages/backend/src/services/evidence/foo.ts`)
 * are legitimate technical artifacts and must not be rewritten.
 *
 * A runtime guard in buildCustomerReportContent re-checks the LLM's prose
 * against FORBIDDEN_WORDS and falls back to deterministic-only rendering if
 * any forbidden word slips through.
 *
 * Used by CaseExportService via the 'customer-report-markdown' and
 * 'customer-report-html' export formats.
 */

import { generateObject } from 'ai';
import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import { z } from 'zod';
import type { Case, CaseEvent, CustomerReportContent } from '@arbitra/shared';
import { resolveModelForRiskWithProject } from '../../lib/llm-provider.js';
import { STRUCTURED_OUTPUT_PROVIDER_OPTIONS } from '../../lib/structured-output.js';

/**
 * Sentinel error thrown from the LLM path when the model's prose contains
 * internal vocabulary. Caught explicitly in buildCustomerReportContent to
 * switch to the deterministic fallback — documents the control flow and
 * avoids coupling to an error-message string prefix.
 */
class ForbiddenVocabularyError extends Error {
  constructor(public word: string) {
    super(`forbidden_vocabulary:${word}`);
    this.name = 'ForbiddenVocabularyError';
  }
}

// ---------------------------------------------------------------------------
// LLM schema — structured output to keep rendering deterministic
// ---------------------------------------------------------------------------

const customerReportSchema = z.object({
  summary: z
    .string()
    .describe(
      '2-4 sentence business-language summary of what changed and why. No internal jargon.',
    ),
  outcome_line: z
    .string()
    .describe(
      'One short line describing the outcome, e.g. "Delivered and merged on 2026-04-15."',
    ),
  manual_test_steps: z
    .array(z.string())
    // Claude omits the key when there are no steps instead of sending [];
    // .default([]) keeps the omitted-key case valid (same failure class as
    // the review adapter's .nullish() fields).
    .default([])
    .describe(
      'Manual verification steps extracted VERBATIM from the case description. Empty array if not explicitly present.',
    ),
});

const SYSTEM_PROMPT = `You write short customer-facing release notes for completed software changes.

You are producing a BUSINESS-FACING report that will be shared with non-technical customers and stakeholders. It must read as plain English release notes.

FORBIDDEN vocabulary — never use these words or any close paraphrase:
- "case", "case_id" (use "this change", "the update", "the delivery")
- "finding", "findings"
- "evidence"
- "decision", "approve as an internal state" (you may say "approved on <date>" naturally)
- "rule engine", "rule set", "rule_override"
- "risk level", "risk_level"
- "four-eyes", "four-eyes principle"
- "validation track", "direct track", "manual track"
- "reviewer_pool"
- "state machine", "case status", "case state"
- "waive", "waived"
- "build run", "review run", "review_run"

Common English words like "rule", "track", "gate", "pipeline", "reviewer",
and "autonomous" are allowed when they appear in normal prose (e.g.
"the permission rule", "CI pipeline"). Only the compounds above are
internal jargon.

Use instead: "this change", "the update", "We delivered", "We addressed", "released", "completed", "verified".

MANUAL TEST STEPS:
Only extract manual verification steps if they are EXPLICITLY present in the
case description under headings like "Validation", "Test steps", "Acceptance
criteria", or "Manual verification". Copy them close to verbatim. If they
are not clearly present, return an empty array. If unsure, omit. Do NOT
invent steps.

Keep summary between 2 and 4 sentences. No markdown formatting inside the
summary or outcome line — plain prose.`;

/**
 * Internal vocabulary that must never appear in the generated prose
 * (summary, outcome_line, manual_test_steps). File paths in the "Changed Files"
 * section are exempt — see module header.
 *
 * Kept aligned with the SYSTEM_PROMPT FORBIDDEN list above.
 */
export const FORBIDDEN_WORDS = [
  'finding',
  'findings',
  'evidence',
  'decision',
  'decisions',
  'rule_override',
  'rule engine',
  'rule set',
  'four-eyes',
  'waive',
  'waived',
  'validation track',
  'direct track',
  'manual track',
  'reviewer_pool',
  'case_status',
  'case state',
  'state machine',
  'risk_level',
  'risk level',
  'review_run',
  'build run',
  'review run',
] as const;

function containsForbiddenWord(text: string): string | null {
  for (const word of FORBIDDEN_WORDS) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Word-boundary match. For multi-word phrases, \b still works at the edges.
    const re = new RegExp(`\\b${escaped}\\b`, 'i');
    if (re.test(text)) return word;
  }
  return null;
}

/**
 * Validates that a URL uses the http: or https: scheme. Anything else —
 * javascript:, data:, file:, mailto:, relative URLs, parse failures — returns
 * false. Used at every <a href=...> site in the HTML renderer to block XSS.
 */
export function isSafeHttpUrl(value: string | null | undefined): boolean {
  if (!value || typeof value !== 'string') return false;
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export interface CustomerReportInput {
  case: Case;
  events: CaseEvent[];
  /** Deterministic list of file paths derived from the PR diff. */
  changedFiles: string[];
  /**
   * True when the diff those paths came from was truncated, so the list is
   * partial. Rendered as a plain note next to the file list — a customer
   * reading a short list off a very large change would otherwise take it for
   * the whole change (issue #877).
   */
  changedFilesTruncated?: boolean;
  /** Repository display name (e.g. "owner/repo"), resolved from repository entity. */
  repositoryName: string | null;
  /** Timestamp of the terminal event (done > approved fallback). */
  terminalEventAt: string | null;
  /** Whether this case used the manual validation track. */
  manualTrack: boolean;
}

// ---------------------------------------------------------------------------
// LLM call with graceful fallback
// ---------------------------------------------------------------------------

export async function buildCustomerReportContent(
  input: CustomerReportInput,
): Promise<CustomerReportContent> {
  const { case: c, changedFiles, changedFilesTruncated, repositoryName, terminalEventAt, manualTrack } = input;

  const deterministicFallback: Omit<CustomerReportContent, 'summary' | 'outcome_line' | 'manual_test_steps'> = {
    title: c.title,
    reference_id: c.case_id,
    completion_date: terminalEventAt ? terminalEventAt.slice(0, 10) : null,
    changed_files: changedFiles,
    changed_files_truncated: changedFilesTruncated === true,
    reference: {
      pr_url: c.current_pr_ref ?? null,
      branch: c.current_branch ?? null,
      repository: repositoryName,
    },
  };

  // Deterministic outcome line — the single source of truth for the non-LLM
  // outcome sentence. Used as the deepest fallback for the summary when both
  // the LLM path and the case description are unusable.
  const deterministicOutcomeLine = terminalEventAt
    ? `Completed on ${terminalEventAt.slice(0, 10)}.`
    : 'Completed.';

  let summary = '';
  let outcomeLine = '';
  let manualTestSteps: string[] = [];

  try {
    const model = await resolveModelForRiskWithProject(
      c.risk_level,
      c.project_id,
      undefined,
    );

    const userPrompt = buildUserPrompt({
      title: c.title,
      description: c.description ?? '',
      prUrl: c.current_pr_ref ?? null,
      branch: c.current_branch ?? null,
      repository: repositoryName,
      changedFiles: changedFiles.slice(0, 100),
      terminalEventAt,
      manualTrack,
    });

    const { object } = await generateObject({
      model,
      schema: customerReportSchema,
      system: SYSTEM_PROMPT,
      prompt: userPrompt,
      maxOutputTokens: 500,
      providerOptions: STRUCTURED_OUTPUT_PROVIDER_OPTIONS,
    });

    const candidateSummary = object.summary.trim();
    const candidateOutcome = object.outcome_line.trim();
    const candidateSteps = manualTrack
      ? object.manual_test_steps.map((s) => s.trim()).filter(Boolean)
      : [];

    // Runtime guard: even with a strict system prompt, models occasionally slip
    // internal vocabulary into the prose. If that happens, drop the LLM output
    // and use the deterministic fallback.
    const combined = [candidateSummary, candidateOutcome, candidateSteps.join(' ')].join(' ');
    const hit = containsForbiddenWord(combined);
    if (hit) {
      throw new ForbiddenVocabularyError(hit);
    }

    summary = candidateSummary;
    outcomeLine = candidateOutcome;
    manualTestSteps = candidateSteps;
  } catch (err) {
    if (err instanceof ForbiddenVocabularyError) {
      console.warn(
        '[customer-report] LLM output contained forbidden vocabulary, using fallback',
      );
    } else {
      console.error(
        '[CustomerReport] LLM generation failed — falling back to deterministic parts:',
        err instanceof Error ? err.message : err,
      );
    }
    // Fallback chain when the LLM path is unusable:
    //   1. case.description (verbatim, markdown-aware) if non-empty after trim
    //   2. the deterministic outcome line ("Completed on <date>." / "Completed.")
    // The old "Summary generation unavailable." placeholder is intentionally
    // never returned — users saw it as broken output.
    const trimmedDescription = (c.description ?? '').trim();
    summary = trimmedDescription.length > 0 ? trimmedDescription : deterministicOutcomeLine;
    outcomeLine = deterministicOutcomeLine;
    manualTestSteps = [];
  }

  return {
    ...deterministicFallback,
    summary,
    outcome_line: outcomeLine,
    manual_test_steps: manualTestSteps,
  };
}

function buildUserPrompt(fields: {
  title: string;
  description: string;
  prUrl: string | null;
  branch: string | null;
  repository: string | null;
  changedFiles: string[];
  terminalEventAt: string | null;
  manualTrack: boolean;
}): string {
  const lines: string[] = [];
  lines.push(`Title: ${fields.title}`);
  if (fields.terminalEventAt) {
    lines.push(`Completion timestamp: ${fields.terminalEventAt}`);
  }
  if (fields.repository) lines.push(`Repository: ${fields.repository}`);
  if (fields.branch) lines.push(`Branch: ${fields.branch}`);
  if (fields.prUrl) lines.push(`PR URL: ${fields.prUrl}`);
  lines.push('');
  lines.push('Description (may contain Markdown):');
  lines.push(fields.description || '(no description provided)');
  lines.push('');
  lines.push(`Changed files (${fields.changedFiles.length}):`);
  for (const f of fields.changedFiles) lines.push(`- ${f}`);
  lines.push('');
  lines.push(
    fields.manualTrack
      ? 'This change required manual verification. Extract manual test steps only if explicitly present in the description.'
      : 'This change was verified automatically. Return an empty array for manual_test_steps.',
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Deterministic file-path extraction from a unified diff
// ---------------------------------------------------------------------------

/**
 * Extract a deduplicated, sorted list of file paths from a unified git diff.
 * Parses `diff --git a/<path> b/<path>` headers; falls back to `+++ b/<path>`.
 */
export function extractChangedFiles(diff: string): string[] {
  const files = new Set<string>();
  for (const line of diff.split('\n')) {
    const diffMatch = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (diffMatch) {
      files.add(diffMatch[2]!);
      continue;
    }
    const plusMatch = /^\+\+\+ b\/(.+)$/.exec(line);
    if (plusMatch && plusMatch[1] !== '/dev/null') {
      files.add(plusMatch[1]!);
    }
  }
  return [...files].sort();
}

/**
 * Note printed next to a partial file list. Plain customer language, no
 * internal vocabulary — a customer must be able to see that the list under-
 * reports the change rather than read a short list as the full scope.
 */
export const PARTIAL_FILE_LIST_NOTE =
  'This list is incomplete. The change was too large to read in full, so only the files visible in the part that could be read are shown.';

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

export function renderCustomerReportMarkdown(content: CustomerReportContent): string {
  const lines: string[] = [];
  lines.push(`# ${content.title}`);
  lines.push('');
  lines.push(`**Reference:** ${content.reference_id}  `);
  if (content.completion_date) {
    lines.push(`**Completed:** ${content.completion_date}  `);
  }
  lines.push('');

  lines.push('## Summary');
  lines.push('');
  lines.push(content.summary);
  lines.push('');

  lines.push('## Outcome');
  lines.push('');
  lines.push(content.outcome_line);
  lines.push('');

  lines.push('## Changed Files');
  lines.push('');
  if (content.changed_files_truncated) {
    lines.push(`_${PARTIAL_FILE_LIST_NOTE}_`);
    lines.push('');
  }
  if (content.changed_files.length === 0) {
    lines.push('_No files recorded for this change._');
  } else {
    const grouped = groupFilesByDirectory(content.changed_files);
    for (const [dir, files] of grouped) {
      lines.push(dir === '' ? '**(root)**' : `**${dir}/**`);
      for (const f of files) lines.push(`- \`${f}\``);
      lines.push('');
    }
  }

  if (content.manual_test_steps.length > 0) {
    lines.push('## Manual Verification Steps');
    lines.push('');
    for (const step of content.manual_test_steps) {
      lines.push(`- ${step}`);
    }
    lines.push('');
  }

  const ref = content.reference;
  if (ref.pr_url || ref.branch || ref.repository) {
    lines.push('## Reference');
    lines.push('');
    if (ref.repository) lines.push(`- Repository: ${ref.repository}`);
    if (ref.branch) lines.push(`- Branch: \`${ref.branch}\``);
    if (ref.pr_url) lines.push(`- Pull Request: ${ref.pr_url}`);
    lines.push('');
  }

  return lines.join('\n').trimEnd() + '\n';
}

/**
 * Group file paths by their top-level directory for readable display.
 * Returns an array of [dir, files] pairs sorted by directory name.
 */
function groupFilesByDirectory(files: string[]): Array<[string, string[]]> {
  const groups = new Map<string, string[]>();
  for (const f of files) {
    const idx = f.indexOf('/');
    const dir = idx === -1 ? '' : f.slice(0, f.lastIndexOf('/'));
    const arr = groups.get(dir) ?? [];
    arr.push(f);
    groups.set(dir, arr);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

// ---------------------------------------------------------------------------
// HTML rendering — print-friendly, inline CSS
// ---------------------------------------------------------------------------

/**
 * Render user-authored prose (markdown) into sanitized HTML for the HTML
 * export path. Needed because `case.description` — the summary fallback when
 * the LLM path is unusable — can contain markdown (`## headings`, `**bold**`,
 * bullet lists, code fences). Without conversion customers would see raw
 * markdown syntax as literal text in the HTML export.
 *
 * marked does NOT sanitize by default, so we pass the parsed HTML through
 * sanitize-html with a conservative allow-list that matches what the markdown
 * grammar can produce. Anything outside the allow-list (script, style,
 * iframe, inline event handlers, javascript: URLs, …) is stripped.
 *
 * The Markdown export path is unchanged — it's already a markdown document
 * and passthrough is correct there.
 */
function renderMarkdownToHtml(source: string): string {
  const rawHtml = marked.parse(source, { async: false, gfm: true, breaks: true }) as string;
  return sanitizeHtml(rawHtml, {
    allowedTags: [
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'p', 'br', 'hr',
      'strong', 'em', 'del', 's',
      'code', 'pre',
      'ul', 'ol', 'li',
      'blockquote',
      'a', 'img',
      'table', 'thead', 'tbody', 'tr', 'th', 'td',
    ],
    allowedAttributes: {
      a: ['href', 'title'],
      img: ['src', 'alt', 'title'],
      code: ['class'],
      th: ['align'],
      td: ['align'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { img: ['http', 'https'] },
    disallowedTagsMode: 'discard',
  });
}

export function renderCustomerReportHtml(content: CustomerReportContent): string {
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const filesSection = (() => {
    const partialNote = content.changed_files_truncated
      ? `<p><em>${esc(PARTIAL_FILE_LIST_NOTE)}</em></p>`
      : '';
    if (content.changed_files.length === 0) {
      return `${partialNote}<p><em>No files recorded for this change.</em></p>`;
    }
    const grouped = groupFilesByDirectory(content.changed_files);
    return (
      partialNote +
      grouped
        .map(([dir, files]) => {
          const heading = dir === '' ? '<strong>(root)</strong>' : `<strong>${esc(dir)}/</strong>`;
          const items = files.map((f) => `<li><code>${esc(f)}</code></li>`).join('');
          return `<div class="file-group">${heading}<ul>${items}</ul></div>`;
        })
        .join('')
    );
  })();

  const manualSteps = content.manual_test_steps.length
    ? `<section><h2>Manual Verification Steps</h2><ol>${content.manual_test_steps
        .map((s) => `<li>${esc(s)}</li>`)
        .join('')}</ol></section>`
    : '';

  const ref = content.reference;
  const referenceSection = (ref.pr_url || ref.branch || ref.repository)
    ? `<section><h2>Reference</h2><ul>${
        (ref.repository ? `<li>Repository: ${esc(ref.repository)}</li>` : '') +
        (ref.branch ? `<li>Branch: <code>${esc(ref.branch)}</code></li>` : '') +
        (ref.pr_url
          ? (isSafeHttpUrl(ref.pr_url)
              ? `<li>Pull Request: <a href="${esc(ref.pr_url)}">${esc(ref.pr_url)}</a></li>`
              : `<li>Pull Request: ${esc(ref.pr_url)}</li>`)
          : '')
      }</ul></section>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${esc(content.title)}</title>
<style>
  :root { color-scheme: light; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 780px; margin: 0 auto; padding: 40px 24px; color: #1a1a1a; line-height: 1.55; background: #fff; }
  h1 { border-bottom: 2px solid #333; padding-bottom: 8px; margin-top: 0; font-size: 28px; }
  h2 { margin-top: 1.8em; font-size: 18px; color: #222; border-bottom: 1px solid #e5e5e5; padding-bottom: 4px; }
  .meta { color: #555; font-size: 14px; margin: 4px 0; }
  ul, ol { padding-left: 22px; }
  li { margin: 3px 0; }
  code { background: #f3f3f3; padding: 2px 5px; border-radius: 3px; font-size: 13px; font-family: 'SF Mono', Menlo, Consolas, monospace; }
  a { color: #1a5490; }
  .file-group { margin: 10px 0; }
  .file-group ul { margin-top: 4px; }
  section { margin-top: 24px; }
  @media print {
    body { padding: 20px; max-width: none; }
    a { color: #000; text-decoration: none; }
    h1 { font-size: 22px; }
    h2 { font-size: 15px; }
  }
</style>
</head>
<body>
<h1>${esc(content.title)}</h1>
<p class="meta"><strong>Reference:</strong> ${esc(content.reference_id)}</p>
${content.completion_date ? `<p class="meta"><strong>Completed:</strong> ${esc(content.completion_date)}</p>` : ''}
<section class="summary"><h2>Summary</h2>${renderMarkdownToHtml(content.summary)}</section>
<section><h2>Outcome</h2><p>${esc(content.outcome_line)}</p></section>
<section><h2>Changed Files</h2>${filesSection}</section>
${manualSteps}
${referenceSection}
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Terminal-event resolution
// ---------------------------------------------------------------------------

/**
 * Find the timestamp of the terminal event (case_completed preferred, then
 * pr_merged, then case_approved). Returns null if none has occurred.
 */
export function findTerminalEventAt(events: CaseEvent[]): string | null {
  const byTypeReversed = (type: string) =>
    [...events].reverse().find((e) => e.type === type);

  const completed = byTypeReversed('case_completed');
  if (completed) return completed.created_at;

  const merged = byTypeReversed('pr_merged');
  if (merged) return merged.created_at;

  const approved = byTypeReversed('case_approved');
  if (approved) return approved.created_at;

  return null;
}
