import type {
  Finding,
  Decision,
  Comment,
  Run,
  Project,
  Repository,
  CaseExportData,
  CaseExportFormat,
  CaseExportResult,
  AuditExport,
  FindingSeverity,
  FindingStatus,
  CustomerReportContent,
} from '@arbitra/shared';
import { CaseRepository } from './case-repository.js';
import { EventRepository } from '../event/event-repository.js';
import { EvidenceRepository } from '../evidence/evidence-repository.js';
import { DiffResolver } from '../diff/diff-resolver.js';
import {
  buildCustomerReportContent,
  extractChangedFiles,
  findTerminalEventAt,
  renderCustomerReportHtml,
  renderCustomerReportMarkdown,
} from './customer-report-renderer.js';
import { collections } from '../../lib/firestore.js';
import { openRepositoryToken } from '../../lib/secret-box.js';

// ── User resolution ────────────────────────────────────────────────────────

type UserMap = Record<string, string>; // userId → display name

async function buildUserMap(data: CaseExportData | AuditExport): Promise<UserMap> {
  const ids = new Set<string>();
  const caseData = data.case;
  if (caseData.owner_user_id) ids.add(caseData.owner_user_id);
  if (caseData.assigned_reviewer_id) ids.add(caseData.assigned_reviewer_id);

  const decisions = 'decisions' in data ? data.decisions : [];
  const comments = 'comments' in data ? data.comments : [];
  const events = 'events' in data ? data.events : ('timeline' in data ? (data as AuditExport).timeline : []);

  for (const d of decisions) ids.add(d.actor_id);
  for (const c of comments) ids.add(c.author_id);
  for (const e of events) {
    if (e.actor_id && !e.actor_id.startsWith('system')) ids.add(e.actor_id);
  }

  if ('exported_by' in data && data.exported_by) ids.add(data.exported_by);

  const map: UserMap = {};
  const uniqueIds = [...ids].filter(Boolean);
  if (uniqueIds.length === 0) return map;

  // Firestore getAll supports up to 500 docs
  const refs = uniqueIds.map(id => collections.users().doc(id));
  const docs = await collections.users().firestore.getAll(...refs);
  for (const doc of docs) {
    if (doc.exists) {
      const d = doc.data()!;
      map[doc.id] = d.display_name || d.email || doc.id;
    }
  }
  return map;
}

function resolveUser(map: UserMap, id: string): string {
  if (!id) return 'Unknown';
  if (id.startsWith('system:')) return 'Arbitra ' + id.slice(7).replace(/_/g, ' ');
  return map[id] ?? id;
}

export class CaseExportService {
  constructor(
    private readonly caseRepo = new CaseRepository(),
    private readonly eventRepo = new EventRepository(),
    private readonly evidenceRepo = new EvidenceRepository(),
  ) {}

  async gatherExportData(caseId: string, actorId?: string): Promise<CaseExportData> {
    const caseData = await this.caseRepo.getById(caseId);

    const [findingsSnap, decisionsSnap, commentsSnap, runsSnap] = await Promise.all([
      collections.findings().where('case_id', '==', caseId).orderBy('created_at', 'asc').get(),
      collections.decisions().where('case_id', '==', caseId).orderBy('created_at', 'asc').get(),
      collections.comments().where('parent_type', '==', 'case').where('parent_id', '==', caseId).orderBy('created_at', 'asc').get(),
      collections.runs().where('case_id', '==', caseId).orderBy('created_at', 'asc').get(),
    ]);

    const [evidence, events] = await Promise.all([
      this.evidenceRepo.getByCaseId(caseId),
      this.eventRepo.getByCaseId(caseId),
    ]);

    return {
      case: caseData,
      findings: findingsSnap.docs.map((d) => d.data() as Finding),
      evidence,
      decisions: decisionsSnap.docs.map((d) => d.data() as Decision),
      events,
      runs: runsSnap.docs.map((d) => d.data() as Run),
      comments: commentsSnap.docs.map((d) => d.data() as Comment),
      exported_at: new Date().toISOString(),
      exported_by: actorId,
    };
  }

  async gatherAuditData(caseId: string, actorId: string): Promise<AuditExport> {
    const exportData = await this.gatherExportData(caseId, actorId);

    let project: Project | null = null;
    if (exportData.case.project_id) {
      try {
        const projectDoc = await collections.projects().doc(exportData.case.project_id).get();
        if (projectDoc.exists) {
          project = projectDoc.data() as Project;
        }
      } catch {
        // Project lookup is best-effort
      }
    }

    return {
      case: exportData.case,
      project,
      timeline: exportData.events,
      findings: exportData.findings,
      evidence: exportData.evidence,
      decisions: exportData.decisions,
      comments: exportData.comments,
      runs: exportData.runs,
      exported_at: exportData.exported_at,
      exported_by: actorId,
    };
  }

  async formatExport(data: CaseExportData, format: CaseExportFormat): Promise<CaseExportResult> {
    const slug = data.case.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
    const date = data.exported_at.slice(0, 10);
    const userMap = format !== 'json' ? await buildUserMap(data) : {};

    switch (format) {
      case 'markdown':
        return {
          case_id: data.case.case_id,
          format,
          content: renderMarkdown(data, userMap),
          filename: `case-${slug}-${date}.md`,
          content_type: 'text/markdown',
        };
      case 'html':
        return {
          case_id: data.case.case_id,
          format,
          content: renderHtml(data, userMap),
          filename: `case-${slug}-${date}.html`,
          content_type: 'text/html',
        };
      case 'json':
      default:
        return {
          case_id: data.case.case_id,
          format: 'json',
          content: JSON.stringify(data, null, 2),
          filename: `case-${slug}-${date}.json`,
          content_type: 'application/json',
        };
    }
  }

  /**
   * Gather the data needed for a customer-facing report. Does NOT pull
   * findings, decisions, rules, or evidence into scope — those must never
   * leak into customer-facing output or the LLM prompt.
   */
  async gatherCustomerReportData(
    caseId: string,
    _actorId?: string,
  ): Promise<{
    case: import('@arbitra/shared').Case;
    events: import('@arbitra/shared').CaseEvent[];
    changedFiles: string[];
    /**
     * True when the diff behind `changedFiles` was truncated, so the list
     * names only the files present in the prefix (issue #877).
     */
    changedFilesTruncated: boolean;
    repositoryName: string | null;
    terminalEventAt: string | null;
  }> {
    const caseData = await this.caseRepo.getById(caseId);
    const events = await this.eventRepo.getByCaseId(caseId);

    // Resolve repository display name + GitHub token for diff fetch
    let repositoryName: string | null = null;
    let repositoryToken: string | undefined;
    if (caseData.repository_id) {
      try {
        const repoDoc = await collections.repositories().doc(caseData.repository_id).get();
        if (repoDoc.exists) {
          const r = repoDoc.data() as Repository;
          repositoryName = r.name ?? null;
          repositoryToken = openRepositoryToken(r.github_token, r.repository_id);
        }
      } catch {
        // best-effort
      }
    }

    // Deterministic file list from PR diff. A truncated diff only contains the
    // files that fit inside the line cap, so the list is a lower bound on what
    // the change touched — carry that fact out instead of dropping it and
    // presenting a partial list as complete (issue #877).
    let changedFiles: string[] = [];
    let changedFilesTruncated = false;
    try {
      const resolver = new DiffResolver(repositoryToken);
      const diffResult = await resolver.resolve(caseData);
      if (diffResult.ok && diffResult.diff) {
        changedFiles = extractChangedFiles(diffResult.diff);
        changedFilesTruncated = diffResult.truncated;
      }
    } catch (err) {
      console.warn('[CustomerReport] diff fetch failed:', err instanceof Error ? err.message : err);
    }

    return {
      case: caseData,
      events,
      changedFiles,
      changedFilesTruncated,
      repositoryName,
      terminalEventAt: findTerminalEventAt(events),
    };
  }

  /**
   * Build and format a customer-facing report. Calls the LLM for the
   * summary + outcome line; falls back to deterministic parts if that fails.
   */
  async formatCustomerReport(
    input: Awaited<ReturnType<CaseExportService['gatherCustomerReportData']>>,
    format: 'customer-report-markdown' | 'customer-report-html',
  ): Promise<CaseExportResult> {
    const content = await buildCustomerReportContent({
      case: input.case,
      events: input.events,
      changedFiles: input.changedFiles,
      changedFilesTruncated: input.changedFilesTruncated,
      repositoryName: input.repositoryName,
      terminalEventAt: input.terminalEventAt,
      manualTrack: input.case.validation_track === 'manual',
    });

    return this.renderCustomerReport(content, format);
  }

  /**
   * Render pre-built content into the requested format. Exposed for tests
   * that want to exercise rendering without the LLM path.
   */
  renderCustomerReport(
    content: CustomerReportContent,
    format: 'customer-report-markdown' | 'customer-report-html',
  ): CaseExportResult {
    const slug = content.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
    const date = (content.completion_date ?? new Date().toISOString().slice(0, 10)).slice(0, 10);

    if (format === 'customer-report-html') {
      return {
        case_id: content.reference_id,
        format,
        content: renderCustomerReportHtml(content),
        filename: `customer-report-${slug}-${date}.html`,
        content_type: 'text/html',
      };
    }

    return {
      case_id: content.reference_id,
      format,
      content: renderCustomerReportMarkdown(content),
      filename: `customer-report-${slug}-${date}.md`,
      content_type: 'text/markdown',
    };
  }

  async formatAuditExport(data: AuditExport, format: 'audit' | 'audit-markdown'): Promise<CaseExportResult> {
    const date = data.exported_at.slice(0, 10);

    if (format === 'audit-markdown') {
      const userMap = await buildUserMap(data);
      return {
        case_id: data.case.case_id,
        format,
        content: formatAuditAsMarkdown(data, userMap),
        filename: `arbitra-audit-${data.case.case_id}-${date}.md`,
        content_type: 'text/markdown',
      };
    }

    return {
      case_id: data.case.case_id,
      format: 'audit',
      content: JSON.stringify(data, null, 2),
      filename: `arbitra-audit-${data.case.case_id}-${date}.json`,
      content_type: 'application/json',
    };
  }
}

// ── Markdown rendering ──────────────────────────────────────────────────────

function renderMarkdown(data: CaseExportData, userMap: UserMap): string {
  const c = data.case;
  const lines: string[] = [];

  lines.push(`# ${c.title}`);
  lines.push('');
  lines.push(`**Case ID:** ${c.case_id}  `);
  lines.push(`**Status:** ${formatStatus(c.status)}  `);
  lines.push(`**Risk Level:** ${capitalize(c.risk_level)}  `);
  lines.push(`**Priority:** ${capitalize(c.priority)}  `);
  lines.push(`**Validation Track:** ${capitalize(c.validation_track)}  `);
  if (c.case_type) lines.push(`**Type:** ${formatCaseType(c.case_type)}  `);
  lines.push(`**Created:** ${formatDate(c.created_at)}  `);
  lines.push(`**Last Updated:** ${formatDate(c.updated_at)}  `);
  if (c.current_branch) lines.push(`**Branch:** \`${c.current_branch}\`  `);
  if (c.current_pr_ref) lines.push(`**PR:** ${c.current_pr_ref}  `);
  if (c.jira_refs?.length) lines.push(`**Jira:** ${c.jira_refs.join(', ')}  `);
  lines.push('');

  // Description
  lines.push('## Description');
  lines.push('');
  lines.push(c.description || '_No description provided._');
  lines.push('');

  // Findings summary
  lines.push('## Findings');
  lines.push('');
  if (data.findings.length === 0) {
    lines.push('_No findings recorded._');
  } else {
    const bySeverity = groupBy(data.findings, (f) => f.severity);
    const severityOrder: FindingSeverity[] = ['critical', 'high', 'medium', 'low', 'info'];
    const statusCounts = countBy(data.findings, (f) => f.status);

    lines.push(`**Total:** ${data.findings.length} findings — ${Object.entries(statusCounts).map(([s, n]) => `${n} ${s}`).join(', ')}`);
    lines.push('');

    lines.push('| Severity | Status | Title |');
    lines.push('|----------|--------|-------|');
    for (const sev of severityOrder) {
      for (const f of bySeverity[sev] ?? []) {
        lines.push(`| ${severityIcon(f.severity)} ${capitalize(f.severity)} | ${statusIcon(f.status)} ${capitalize(f.status)} | ${f.title} |`);
      }
    }
  }
  lines.push('');

  // Evidence summary
  lines.push('## Evidence');
  lines.push('');
  if (data.evidence.length === 0) {
    lines.push('_No evidence registered._');
  } else {
    lines.push(`**Total:** ${data.evidence.length} items  `);
    lines.push(`**Decision Ready:** ${data.case.decision_ready ? 'Yes' : 'No'}`);
    lines.push('');
    lines.push('| Type | Source | Summary | Registered |');
    lines.push('|------|--------|---------|------------|');
    for (const e of data.evidence) {
      lines.push(`| ${formatEvidenceType(e.type)} | ${capitalize(e.source_type)} | ${e.summary ?? '—'} | ${formatDate(e.created_at)} |`);
    }
  }
  lines.push('');

  // Decisions
  lines.push('## Decisions');
  lines.push('');
  if (data.decisions.length === 0) {
    lines.push('_No decisions recorded._');
  } else {
    for (const d of data.decisions) {
      lines.push(`- **${formatDecisionType(d.type)}** by ${resolveUser(userMap, d.actor_id)} on ${formatDate(d.created_at)}`);
      if (d.finding_id) lines.push(`  - Finding: \`${d.finding_id}\``);
      if (d.rationale) lines.push(`  - Rationale: ${d.rationale}`);
    }
  }
  lines.push('');

  // Runs
  if (data.runs.length > 0) {
    lines.push('## Runs');
    lines.push('');
    lines.push('| Type | Status | Summary | Started | Finished |');
    lines.push('|------|--------|---------|---------|----------|');
    for (const r of data.runs) {
      lines.push(`| ${formatRunType(r.run_type)} | ${capitalize(r.status)} | ${r.summary ?? '—'} | ${r.started_at ? formatDate(r.started_at) : '—'} | ${r.finished_at ? formatDate(r.finished_at) : '—'} |`);
    }
    lines.push('');
  }

  // Comments
  if (data.comments.length > 0) {
    lines.push('## Comments');
    lines.push('');
    for (const cm of data.comments) {
      lines.push(`> **${resolveUser(userMap, cm.author_id)}** — ${formatDate(cm.created_at)}`);
      lines.push(`> ${cm.body}`);
      lines.push('');
    }
  }

  // Timeline (last 20 events)
  lines.push('## Timeline');
  lines.push('');
  const recentEvents = data.events.slice(-20);
  if (recentEvents.length === 0) {
    lines.push('_No events recorded._');
  } else {
    if (data.events.length > 20) {
      lines.push(`_Showing last 20 of ${data.events.length} events._`);
      lines.push('');
    }
    for (const ev of recentEvents) {
      lines.push(`- **${formatDate(ev.created_at)}** — ${formatEventType(ev.type)} (by ${resolveUser(userMap, ev.actor_id)})`);
    }
  }
  lines.push('');

  // Footer
  lines.push('---');
  lines.push(`_Exported from Arbitra on ${formatDate(data.exported_at)}_`);

  return lines.join('\n');
}

// ── HTML rendering ──────────────────────────────────────────────────────────

function renderHtml(data: CaseExportData, userMap: UserMap): string {
  const md = renderMarkdown(data, userMap);
  // Convert markdown to basic HTML for email/Teams compatibility
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Case Export: ${escapeHtml(data.case.title)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; color: #1a1a1a; line-height: 1.6; }
  h1 { border-bottom: 2px solid #4f46e5; padding-bottom: 8px; color: #1e1b4b; }
  h2 { color: #312e81; margin-top: 1.5em; }
  table { width: 100%; border-collapse: collapse; margin: 12px 0; }
  th, td { border: 1px solid #e5e7eb; padding: 8px 12px; text-align: left; font-size: 14px; }
  th { background: #f3f4f6; font-weight: 600; }
  tr:nth-child(even) { background: #fafafa; }
  code { background: #f1f5f9; padding: 2px 6px; border-radius: 3px; font-size: 13px; }
  blockquote { border-left: 3px solid #4f46e5; margin: 8px 0; padding: 4px 16px; background: #f8f9ff; }
  .meta { color: #6b7280; font-size: 13px; }
  ul { padding-left: 20px; }
  li { margin: 4px 0; }
  hr { border: none; border-top: 1px solid #e5e7eb; margin: 24px 0; }
</style>
</head>
<body>
${markdownToHtml(md)}
</body>
</html>`;
}

/** Minimal markdown-to-HTML converter for structured export content */
function markdownToHtml(md: string): string {
  let lastWasTable = false;
  return md
    .split('\n')
    .map((line) => {
      // Headers
      if (line.startsWith('# ')) { lastWasTable = false; return `<h1>${inlineFormat(line.slice(2))}</h1>`; }
      if (line.startsWith('## ')) { lastWasTable = false; return `<h2>${inlineFormat(line.slice(3))}</h2>`; }
      // Table separator (marks that the previous row was a header)
      if (line.startsWith('|') && line.includes('---')) return '';
      // Table rows — first row after a non-table line is the header
      if (line.startsWith('|')) {
        const cells = line.split('|').filter((c) => c.trim());
        const isHeader = !lastWasTable;
        lastWasTable = true;
        const tag = isHeader ? 'th' : 'td';
        return `<tr>${cells.map((c) => `<${tag}>${inlineFormat(c.trim())}</${tag}>`).join('')}</tr>`;
      }
      lastWasTable = false;
      // Blockquotes
      if (line.startsWith('> ')) return `<blockquote>${inlineFormat(line.slice(2))}</blockquote>`;
      // List items
      if (line.startsWith('- ')) return `<li>${inlineFormat(line.slice(2))}</li>`;
      if (line.startsWith('  - ')) return `<li style="margin-left:20px">${inlineFormat(line.slice(4))}</li>`;
      // Horizontal rule
      if (line.startsWith('---')) return '<hr />';
      // Italic-only lines
      if (line.startsWith('_') && line.endsWith('_')) return `<p class="meta"><em>${line.slice(1, -1)}</em></p>`;
      // Empty line
      if (line.trim() === '') return '';
      // Regular paragraph
      return `<p>${inlineFormat(line)}</p>`;
    })
    .filter((l) => l !== '')
    .join('\n')
    // Wrap adjacent <tr> in <table>
    .replace(/((?:<tr>.*?<\/tr>\n?)+)/g, '<table>$1</table>')
    // Wrap adjacent <li> in <ul>
    .replace(/((?:<li.*?<\/li>\n?)+)/g, '<ul>$1</ul>');
}

function inlineFormat(text: string): string {
  return escapeHtml(text)
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.*?)`/g, '<code>$1</code>')
    .replace(/(?<=\s|^)_(.*?)_(?=\s|$)/g, '<em>$1</em>');
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Audit markdown rendering ───────────────────────────────────────────────

export function formatAuditAsMarkdown(audit: AuditExport, userMap: UserMap = {}): string {
  const c = audit.case;
  const lines: string[] = [];

  lines.push(`# Arbitra Audit Report: ${c.title}`);
  lines.push('');
  lines.push(`**Case ID:** ${c.case_id}  `);
  lines.push(`**Status:** ${formatStatus(c.status)}  `);
  lines.push(`**Risk Level:** ${capitalize(c.risk_level)}  `);
  lines.push(`**Validation Track:** ${capitalize(c.validation_track)}  `);
  if (c.priority) lines.push(`**Priority:** ${capitalize(c.priority)}  `);
  if (c.case_type) lines.push(`**Type:** ${formatCaseType(c.case_type)}  `);
  lines.push(`**Created:** ${formatDate(c.created_at)}  `);
  lines.push(`**Last Updated:** ${formatDate(c.updated_at)}  `);
  if (c.owner_user_id) lines.push(`**Owner:** ${resolveUser(userMap, c.owner_user_id)}  `);
  if (c.current_branch) lines.push(`**Branch:** \`${c.current_branch}\`  `);
  if (c.current_pr_ref) lines.push(`**PR:** ${c.current_pr_ref}  `);
  if (audit.project) lines.push(`**Project:** ${audit.project.name}  `);
  lines.push('');

  // Description
  if (c.description) {
    lines.push('## Description');
    lines.push('');
    lines.push(c.description);
    lines.push('');
  }

  // Timeline (full)
  lines.push('## Timeline');
  lines.push('');
  if (audit.timeline.length === 0) {
    lines.push('_No events recorded._');
  } else {
    lines.push('| Time | Event | Actor |');
    lines.push('|------|-------|-------|');
    for (const ev of audit.timeline) {
      lines.push(`| ${formatDate(ev.created_at)} | ${formatEventType(ev.type)} | ${resolveUser(userMap, ev.actor_id)} |`);
    }
  }
  lines.push('');

  // Findings
  lines.push(`## Findings (${audit.findings.length})`);
  lines.push('');
  if (audit.findings.length === 0) {
    lines.push('_No findings recorded._');
  } else {
    for (const f of audit.findings) {
      lines.push(`### Finding: ${f.title}`);
      lines.push('');
      lines.push(`- **Severity:** ${capitalize(f.severity)}`);
      lines.push(`- **Status:** ${capitalize(f.status)}`);
      if (f.description) lines.push(`- **Description:** ${f.description}`);
      if (f.category) lines.push(`- **Category:** ${capitalize(f.category)}`);
      lines.push('');
    }
  }

  // Evidence
  lines.push(`## Evidence (${audit.evidence.length})`);
  lines.push('');
  if (audit.evidence.length === 0) {
    lines.push('_No evidence registered._');
  } else {
    lines.push('| Type | Source | Summary | Registered |');
    lines.push('|------|--------|---------|------------|');
    for (const e of audit.evidence) {
      lines.push(`| ${formatEvidenceType(e.type)} | ${capitalize(e.source_type)} | ${e.summary ?? '\u2014'} | ${formatDate(e.created_at)} |`);
    }
  }
  lines.push('');

  // Decisions
  lines.push(`## Decisions (${audit.decisions.length})`);
  lines.push('');
  if (audit.decisions.length === 0) {
    lines.push('_No decisions recorded._');
  } else {
    for (const d of audit.decisions) {
      lines.push(`- **${formatDecisionType(d.type)}** by ${resolveUser(userMap, d.actor_id)} on ${formatDate(d.created_at)}`);
      if (d.finding_id) lines.push(`  - Finding: \`${d.finding_id}\``);
      if (d.rationale) lines.push(`  - Rationale: ${d.rationale}`);
    }
  }
  lines.push('');

  // Runs
  if (audit.runs.length > 0) {
    lines.push(`## Runs (${audit.runs.length})`);
    lines.push('');
    lines.push('| Type | Status | Summary | Started | Finished |');
    lines.push('|------|--------|---------|---------|----------|');
    for (const r of audit.runs) {
      lines.push(`| ${formatRunType(r.run_type)} | ${capitalize(r.status)} | ${r.summary ?? '\u2014'} | ${r.started_at ? formatDate(r.started_at) : '\u2014'} | ${r.finished_at ? formatDate(r.finished_at) : '\u2014'} |`);
    }
    lines.push('');
  }

  // Comments
  if (audit.comments.length > 0) {
    lines.push(`## Comments (${audit.comments.length})`);
    lines.push('');
    for (const cm of audit.comments) {
      lines.push(`> **${resolveUser(userMap, cm.author_id)}** \u2014 ${formatDate(cm.created_at)}`);
      lines.push(`> ${cm.body}`);
      lines.push('');
    }
  }

  // Footer
  lines.push('---');
  lines.push(`_Arbitra Audit Report \u2014 exported on ${formatDate(audit.exported_at)} by ${resolveUser(userMap, audit.exported_by)}_`);

  return lines.join('\n');
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ');
}

function formatStatus(status: string): string {
  const map: Record<string, string> = {
    open: 'Open',
    exploration: 'Exploration',
    ready_for_build: 'Ready for Build',
    in_build: 'In Build',
    in_validation: 'In Validation',
    in_review: 'In Review',
    needs_human_decision: 'Needs Human Decision',
    verification_pending: 'Verification Pending',
    approved: 'Approved',
    pending_merge: 'Pending Merge',
    done: 'Done',
    rejected: 'Rejected',
  };
  return map[status] ?? capitalize(status);
}

function formatCaseType(t: string): string {
  const map: Record<string, string> = {
    ticket_implementation: 'Ticket Implementation',
    bugfix: 'Bug Fix',
    refactoring: 'Refactoring',
    pr_review: 'PR Review',
    manual_verification: 'Manual Verification',
    other: 'Other',
  };
  return map[t] ?? capitalize(t);
}

function formatDecisionType(t: string): string {
  const map: Record<string, string> = {
    approve: 'Approved',
    auto_approve: 'Auto-Approved',
    request_changes: 'Changes Requested',
    waive: 'Waived',
    reject: 'Rejected',
    escalate: 'Escalated',
    manual_validation_confirmed: 'Manual Validation Confirmed',
    merge_not_applicable: 'Merge Not Applicable',
    review_not_applicable: 'Review Not Applicable',
    waived_on_completion: 'Waived on Completion (System)',
  };
  return map[t] ?? capitalize(t);
}

function formatRunType(t: string): string {
  return capitalize(t.replace(/_run$/, ''));
}

function formatEvidenceType(t: string): string {
  return capitalize(t.replace(/_result$/, '').replace(/_/g, ' '));
}

function formatEventType(t: string): string {
  return capitalize(t.replace(/_/g, ' '));
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toISOString().replace('T', ' ').slice(0, 16);
  } catch {
    return iso;
  }
}

function severityIcon(s: FindingSeverity): string {
  const icons: Record<FindingSeverity, string> = {
    critical: '🔴', high: '🟠', medium: '🟡', low: '🔵', info: '⚪',
  };
  return icons[s] ?? '';
}

function statusIcon(s: FindingStatus): string {
  const icons: Record<FindingStatus, string> = {
    open: '⏳', accepted: '✅', fixed: '🔧', waived: '↩️', contested: '⚠️', resolved: '✅',
    waiver_proposed: '🕓', waived_on_completion: '↩️',
  };
  return icons[s] ?? '';
}

function groupBy<T>(arr: T[], fn: (item: T) => string): Record<string, T[]> {
  const result: Record<string, T[]> = {};
  for (const item of arr) {
    const key = fn(item);
    (result[key] ??= []).push(item);
  }
  return result;
}

function countBy<T>(arr: T[], fn: (item: T) => string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const item of arr) {
    const key = fn(item);
    result[key] = (result[key] ?? 0) + 1;
  }
  return result;
}
