/**
 * Searchable index of docs page content for the Command Palette.
 *
 * IMPORTANT: This index is manually maintained. When docs content in
 * app/docs/page.tsx changes, update the corresponding entries here.
 */

export interface DocsSearchEntry {
  id: string;
  title: string;
  section: string;
  text: string;
}

export const DOCS_INDEX: DocsSearchEntry[] = [
  // Getting Started
  {
    id: 'what-is-arbitra',
    title: 'What is Arbitra?',
    section: 'Getting Started',
    text: 'Arbitra is an AI-native Engineering Control Plane — an autonomous engineering manager that governs AI-assisted software development. It sits between your IDE, your Git workflow, and your team\'s approval process.',
  },
  {
    id: 'the-problem',
    title: 'The Problem',
    section: 'Getting Started',
    text: 'AI-assisted development is changing how code gets written. Tools like Claude Code, Cursor, and Copilot can implement entire features in minutes. But this creates new challenges: invisible AI work, review bottleneck, no governance framework, lost knowledge.',
  },
  {
    id: 'how-it-works',
    title: 'How It Works',
    section: 'Getting Started',
    text: 'Every code change flows through a defined lifecycle: PR/Change → Case Created → LLM Review → Rules Evaluated → Evidence Collected → Decision. Cases auto-transition through the lifecycle.',
  },
  {
    id: 'first-case',
    title: 'Your First Case',
    section: 'Getting Started',
    text: 'Create a Case, add context with branch and PR reference, run review for LLM analysis, review findings, provide evidence, enter courtroom, submit decision, done.',
  },
  {
    id: 'onboarding',
    title: 'Project Onboarding',
    section: 'Getting Started',
    text: 'Getting a new project into Arbitra takes about 15 minutes: create a project, add your repository, configure webhook, choose evidence policy, invite reviewers, open your first PR.',
  },

  // Core Concepts
  {
    id: 'cases-lifecycle',
    title: 'Cases & Lifecycle',
    section: 'Core Concepts',
    text: 'A Case is the central unit of work. Cases flow through a state machine with 11 statuses: Open, Exploration, Ready for Build, In Build, In Validation, In Review, Needs Decision, Verification Pending, Approved, Done, Rejected.',
  },
  {
    id: 'findings-severity',
    title: 'Findings & Severity',
    section: 'Core Concepts',
    text: 'Findings are issues discovered during review — by LLMs, rule evaluation, or humans. Each finding has severity (critical, high, medium, low, info), confidence, category, status, and origin.',
  },
  {
    id: 'evidence-policies',
    title: 'Evidence & Policies',
    section: 'Core Concepts',
    text: 'Evidence proves that your code works: CI results, test outputs, lint reports, screenshots, manual confirmations. Each project defines an Evidence Policy — what evidence is required at each risk level.',
  },
  {
    id: 'decisions-governance',
    title: 'Decisions & Governance',
    section: 'Core Concepts',
    text: 'Decisions are the human judgements that drive case progression: approve, request changes, waive, reject, escalate. Anti-gaming rules: self-approval prohibited, risk-downgrade audits enforced.',
  },
  {
    id: 'validation-tracks',
    title: 'Validation Tracks',
    section: 'Core Concepts',
    text: 'Direct Track: target system is CI/API-accessible, evidence collected automatically. Manual Track: requires manual testing (remote desktop, VPN, hardware), four-eyes principle at high/critical risk.',
  },
  {
    id: 'risk-levels',
    title: 'Risk Levels',
    section: 'Core Concepts',
    text: 'Low: cosmetic, docs, minor tweaks. Medium: standard feature work. High: core logic, auth, data models. Critical: security, infrastructure, compliance. Each level has different governance requirements.',
  },

  // Views
  {
    id: 'board-view',
    title: 'Board View',
    section: 'Views',
    text: 'Your dashboard. Shows all cases with filtering, sorting, and two view modes: list view (sortable table) and kanban view (cases grouped by status). Filters persist in URL for shareable links.',
  },
  {
    id: 'case-detail',
    title: 'Case Detail',
    section: 'Views',
    text: 'Deep view into a single case. Five tabs: Proof, Runs, Comments, Timeline, Related. Comment uploads carry unstructured context files, while evidence remains the validation artifact workflow.',
  },
  {
    id: 'courtroom-view',
    title: 'Courtroom',
    section: 'Views',
    text: 'The decision-making interface. Three-column layout: left (findings list), center (finding detail), right (evidence sidebar + decision form). Select a finding and submit a decision with rationale.',
  },
  {
    id: 'observatory-view',
    title: 'Observatory',
    section: 'Views',
    text: 'Metrics dashboard for team leads. Shows stat cards (total cases, pending review, approval rate, total findings), charts (risk distribution, findings by severity, track split), and activity feed.',
  },
  {
    id: 'knowledge-rules',
    title: 'Knowledge',
    section: 'Views',
    text: 'Three tabs: Rule Sets (configurable rules per evaluation mode), Evidence Policies (what evidence is required per risk/track), and Knowledge Assets (precedents, patterns, guidelines).',
  },
  {
    id: 'settings-projects',
    title: 'Settings & Projects',
    section: 'Views',
    text: 'Three tabs: General (theme), Projects (create and manage projects, add repositories with webhook URL), Connections (see and revoke per-tool × device connections from your IDEs; Advanced: mint CI service tokens).',
  },

  // Integration
  {
    id: 'llm-providers',
    title: 'LLM Provider Setup',
    section: 'Integration',
    text: 'Arbitra supports multiple LLM providers: Anthropic (Claude), OpenAI (GPT-4o), Google (Gemini), OpenRouter. Switch providers with a single environment variable — no lock-in.',
  },
  {
    id: 'git-webhooks',
    title: 'Git Webhook Setup',
    section: 'Integration',
    text: 'Connect your GitHub repository to automatically create cases from Pull Requests. Add webhook in GitHub Settings with payload URL and events: Pull requests, Pushes.',
  },
  {
    id: 'ide-integration',
    title: 'IDE Agent Integration',
    section: 'Integration',
    text: 'Developers can create cases directly from their IDE (Claude Code, Cursor, Codex) using the MCP server or agent instructions. Install the MCP server; the first tool call prints a one-time Connect link that authenticates this project — no tokens to copy.',
  },
  {
    id: 'access-tokens',
    title: 'Connecting your IDE',
    section: 'Integration',
    text: 'Install the MCP server (claude mcp add arbitra, or .cursor/mcp.json / ~/.codex/config.toml). The first tool call prints a one-time link — click to confirm, no tokens to copy. Manage per-tool × device credentials at Settings → Connections. Advanced: mint CI service tokens for headless pipelines.',
  },
  {
    id: 'api-reference',
    title: 'API Reference',
    section: 'Integration',
    text: 'REST API endpoints: GET/POST /api/cases, GET/PATCH /api/cases/:id, POST /api/cases/:id/transition, POST /api/cases/:id/decisions, POST /api/runs, GET/POST /api/projects, GET /api/search, webhooks.',
  },

  // Roles & Permissions
  {
    id: 'role-developer',
    title: 'Developer Role',
    section: 'Roles & Permissions',
    text: 'Creates cases, pushes code, responds to findings. Can waive low-severity findings with rationale. Cannot self-approve their own cases.',
  },
  {
    id: 'role-reviewer',
    title: 'Reviewer Role',
    section: 'Roles & Permissions',
    text: 'Reviews cases, examines findings and evidence, submits decisions. Can approve, request changes, or waive findings up to high severity.',
  },
  {
    id: 'role-tech-lead',
    title: 'Tech Lead Role',
    section: 'Roles & Permissions',
    text: 'Full governance authority. Can waive any finding including critical, approve cases, manage rules and evidence policies, verify knowledge assets. Required for four-eyes sign-off on critical risk.',
  },

  // FAQ
  {
    id: 'faq',
    title: 'FAQ',
    section: 'FAQ',
    text: 'Frequently asked questions about Arbitra: Why not GitHub reviews? Which LLMs? What does a review cost? Direct vs Manual Track? Custom rules? Onboarding time? Four-eyes principle? Data storage? IDE integration?',
  },
];

/** Check if all query words match as prefixes of words in the text */
export function matchesAllWordPrefixes(text: string, queryWords: string[]): boolean {
  const textWords = text.toLowerCase().split(/\s+/);
  return queryWords.every((qw) => textWords.some((tw) => tw.startsWith(qw)));
}

export function searchDocs(query: string, limit = 5): DocsSearchEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length >= 2);
  if (words.length === 0) return [];
  return DOCS_INDEX
    .filter((entry) => {
      const haystack = `${entry.title} ${entry.text}`;
      return matchesAllWordPrefixes(haystack, words);
    })
    .slice(0, limit);
}
