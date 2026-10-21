'use client';

import { useState, useEffect, useRef } from 'react';

// ---------------------------------------------------------------------------
// Sidebar structure
// ---------------------------------------------------------------------------

interface SidebarItem {
  id: string;
  label: string;
  children?: { id: string; label: string }[];
}

const sidebar: SidebarItem[] = [
  {
    id: 'getting-started',
    label: 'Getting Started',
    children: [
      { id: 'what-is-arbitra', label: 'What is Arbitra?' },
      { id: 'the-problem', label: 'The Problem' },
      { id: 'how-it-works', label: 'How It Works' },
      { id: 'first-case', label: 'Your First Case' },
      { id: 'onboarding', label: 'Project Onboarding' },
    ],
  },
  {
    id: 'core-concepts',
    label: 'Core Concepts',
    children: [
      { id: 'cases-lifecycle', label: 'Cases & Lifecycle' },
      { id: 'case-templates', label: 'Case Templates' },
      { id: 'lifecycle-profiles', label: 'Lifecycle Profiles & Gates' },
      { id: 'findings-severity', label: 'Findings & Severity' },
      { id: 'evidence-policies', label: 'Evidence & Policies' },
      { id: 'decisions-governance', label: 'Decisions & Governance' },
      { id: 'validation-tracks', label: 'Validation Tracks' },
      { id: 'risk-levels', label: 'Risk Levels' },
      { id: 'knowledge-assets', label: 'Knowledge Assets' },
    ],
  },
  {
    id: 'views',
    label: 'Views',
    children: [
      { id: 'board-view', label: 'Board View' },
      { id: 'review-session', label: 'Review Session' },
      { id: 'case-detail', label: 'Case Detail' },
      { id: 'dossier', label: 'Dossier' },
      { id: 'courtroom-view', label: 'Courtroom' },
      { id: 'observatory-view', label: 'Observatory' },
      { id: 'intelligence-view', label: 'Intelligence' },
      { id: 'knowledge-rules', label: 'Knowledge' },
      { id: 'clerk-view', label: 'Clerk' },
      { id: 'helper-bot-view', label: 'Arbitra Helper' },
      { id: 'agent-presence-view', label: 'Agent Presence' },
      { id: 'projects-view', label: 'Projects' },
      { id: 'settings-projects', label: 'Settings' },
    ],
  },
  {
    id: 'integration',
    label: 'Integration',
    children: [
      { id: 'llm-providers', label: 'LLM Provider Setup' },
      { id: 'git-webhooks', label: 'Git Webhook Setup' },
      { id: 'notifications', label: 'Chat Notifications' },
      { id: 'ide-integration', label: 'IDE Agent Integration' },
      { id: 'mcp-integration', label: 'MCP Server' },
      { id: 'concurrency', label: 'Concurrency: One Case per Working Tree' },
      { id: 'access-tokens', label: 'Connecting your IDE' },
      { id: 'api-reference', label: 'API Reference' },
    ],
  },
  {
    id: 'roles-permissions',
    label: 'Roles & Permissions',
    children: [
      { id: 'role-developer', label: 'Developer' },
      { id: 'role-reviewer', label: 'Reviewer' },
      { id: 'role-tech-lead', label: 'Tech Lead' },
      { id: 'role-admin', label: 'Admin' },
    ],
  },
  {
    id: 'faq',
    label: 'FAQ',
  },
];

// Flatten IDs for IntersectionObserver
function getAllIds(): string[] {
  const ids: string[] = [];
  for (const item of sidebar) {
    ids.push(item.id);
    if (item.children) {
      for (const child of item.children) ids.push(child.id);
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Reusable doc components
// ---------------------------------------------------------------------------

function H2({ id, children }: { id: string; children: React.ReactNode }) {
  return <h2 id={id} className="scroll-mt-20 text-2xl font-semibold text-gray-900 dark:text-gray-100 mt-12 mb-4 pb-2 border-b border-gray-200 dark:border-border-subtle">{children}</h2>;
}
function H3({ id, children }: { id: string; children: React.ReactNode }) {
  return <h3 id={id} className="scroll-mt-20 text-lg font-semibold text-gray-900 dark:text-gray-100 mt-8 mb-3">{children}</h3>;
}
function P({ children }: { children: React.ReactNode }) {
  return <p className="text-sm leading-relaxed text-gray-600 dark:text-gray-400 mb-3 break-words">{children}</p>;
}
function Code({ children }: { children: React.ReactNode }) {
  return <pre className="bg-surface-base dark:bg-surface-base border border-gray-200 dark:border-border-subtle rounded-lg px-4 py-3 text-xs font-mono text-gray-800 dark:text-gray-200 overflow-x-auto mb-4 whitespace-pre-wrap break-words">{children}</pre>;
}
function InlineCode({ children }: { children: React.ReactNode }) {
  return <code className="bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 rounded text-xs font-mono text-secondary-700 dark:text-secondary-400 break-all">{children}</code>;
}
function Callout({ type = 'info', children }: { type?: 'info' | 'warning' | 'tip'; children: React.ReactNode }) {
  const styles = {
    info: 'border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-400',
    warning: 'border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/50 text-amber-700 dark:text-amber-400',
    tip: 'border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-950/50 text-green-700 dark:text-green-400',
  };
  const icons = { info: 'i', warning: '!', tip: '\u2713' };
  return (
    <div className={`rounded-lg border px-4 py-3 mb-4 text-sm ${styles[type]}`}>
      <span className="font-semibold mr-1">[{icons[type]}]</span>
      {children}
    </div>
  );
}
function Table({ headers, rows }: { headers: string[]; rows: string[][] }) {
  return (
    <div className="overflow-x-auto mb-4">
      <table className="w-full text-sm border border-gray-200 dark:border-border-subtle rounded-lg overflow-hidden">
        <thead><tr className="bg-surface-base dark:bg-surface-base">{headers.map((h, i) => <th key={i} className="text-left px-3 py-2 font-semibold text-gray-700 dark:text-gray-300 border-b border-gray-200 dark:border-border-subtle">{h}</th>)}</tr></thead>
        <tbody>{rows.map((row, i) => <tr key={i} className="border-b border-gray-100 dark:border-border-subtle">{row.map((cell, j) => <td key={j} className="px-3 py-2 text-gray-600 dark:text-gray-400">{cell}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}
function FeatureCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-surface-raised border border-gray-200 dark:border-border-subtle rounded-lg p-4">
      <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-1.5">{title}</h4>
      <div className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function DocsPage() {
  const [activeId, setActiveId] = useState('what-is-arbitra');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const appUrl = typeof window !== 'undefined' ? window.location.origin : '';

  // IntersectionObserver to highlight current section
  useEffect(() => {
    const ids = getAllIds();
    const elements = ids.map((id) => document.getElementById(id)).filter(Boolean) as HTMLElement[];
    if (elements.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveId(entry.target.id);
            break;
          }
        }
      },
      { rootMargin: '-80px 0px -60% 0px', threshold: 0 },
    );
    for (const el of elements) observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Handle initial hash on page load (e.g. /docs#evidence-policies)
  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (hash) {
      // Small delay to ensure content is rendered before scrolling
      setTimeout(() => document.getElementById(hash)?.scrollIntoView({ behavior: 'smooth' }), 100);
    }
  }, []);

  function scrollTo(id: string) {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
    setSidebarOpen(false);
  }

  return (
    <div className="flex min-h-[calc(100vh-3.5rem)]">
      {/* Mobile sidebar toggle */}
      <button
        onClick={() => setSidebarOpen(!sidebarOpen)}
        className="fixed bottom-4 right-4 z-50 md:hidden rounded-full bg-accent p-3 text-white shadow-lg"
      >
        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
        </svg>
      </button>

      {/* Sidebar */}
      <aside className={`w-60 flex-shrink-0 border-r border-gray-200 dark:border-border-subtle bg-surface-base dark:bg-surface-base overflow-y-auto fixed top-[57px] bottom-0 z-40 transition-transform md:translate-x-0 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}`}>
        <nav className="px-4 py-6">
          {sidebar.map((group) => (
            <div key={group.id} className="mb-4">
              <button
                onClick={() => scrollTo(group.id)}
                className={`block w-full text-left text-[11px] font-semibold uppercase tracking-wider mb-1.5 transition-colors ${
                  activeId === group.id ? 'text-accent-700 dark:text-accent-300' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
                }`}
              >
                {group.label}
              </button>
              {group.children && (
                <ul className="space-y-0.5">
                  {group.children.map((child) => (
                    <li key={child.id}>
                      <button
                        onClick={() => scrollTo(child.id)}
                        className={`block w-full text-left text-xs px-2 py-1 rounded transition-colors ${
                          activeId === child.id
                            ? 'text-accent-700 dark:text-accent-300 bg-accent-light dark:bg-accent-light font-medium'
                            : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200 hover:bg-surface-base dark:hover:bg-border-subtle'
                        }`}
                      >
                        {child.label}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </nav>
      </aside>

      {/* Backdrop for mobile */}
      {sidebarOpen && <div className="fixed inset-0 z-30 bg-black/50 md:hidden" onClick={() => setSidebarOpen(false)} />}

      {/* Content */}
      <section ref={contentRef} className="flex-1 md:ml-60 px-4 md:px-8 py-8 max-w-4xl overflow-hidden break-words">
        {/* Hero */}
        <div className="mb-12">
          <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100 mb-2">Arbitra Documentation</h1>
          <p className="text-base text-gray-500 dark:text-gray-400">
            Everything you need to set up, use, and integrate Arbitra — the autonomous engineering manager.
          </p>
          <div className="mt-6 grid grid-cols-1 sm:grid-cols-3 gap-3">
            <button onClick={() => scrollTo('how-it-works')} className="text-left bg-surface-raised border border-gray-200 dark:border-border-subtle rounded-lg p-4 hover:border-accent dark:hover:border-accent transition-colors">
              <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">How It Works</p>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">From PR to approval in 6 steps</p>
            </button>
            <button onClick={() => scrollTo('onboarding')} className="text-left bg-surface-raised border border-gray-200 dark:border-border-subtle rounded-lg p-4 hover:border-accent dark:hover:border-accent transition-colors">
              <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">Project Onboarding</p>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">15 minutes to get started</p>
            </button>
            <button onClick={() => scrollTo('git-webhooks')} className="text-left bg-surface-raised border border-gray-200 dark:border-border-subtle rounded-lg p-4 hover:border-accent dark:hover:border-accent transition-colors">
              <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">Connect Your Repo</p>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Git webhooks & IDE integration</p>
            </button>
          </div>
        </div>

        {/* ============================================================= */}
        {/* GETTING STARTED                                                */}
        {/* ============================================================= */}
        <H2 id="getting-started">Getting Started</H2>

        <H3 id="what-is-arbitra">What is Arbitra?</H3>
        <P>Arbitra is an <strong>AI-native Engineering Control Plane</strong> — an autonomous engineering manager that governs AI-assisted software development. It sits between your IDE, your Git workflow, and your team&apos;s approval process.</P>
        <P>When developers or AI assistants write code, Arbitra makes sure that code gets reviewed by LLMs, validated against project-specific rules, backed by evidence (CI results, tests, screenshots), and approved through a governed decision process before it ships.</P>
        <P>Arbitra is not a chatbot, not a Jira replacement, and not just another code review tool. It combines multi-model AI reviews, configurable rule evaluation, evidence management, and organizational knowledge capture into one system — with the human always in control of the final decision.</P>

        <H3 id="the-problem">The Problem</H3>
        <P>AI-assisted development is changing how code gets written. Tools like Claude Code, Cursor, and Copilot can implement entire features in minutes. But this creates new challenges:</P>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
          <FeatureCard title="Invisible AI Work">AI work happens locally in IDE sessions — no team-wide visibility, no structured handoff, no audit trail of what was generated vs. hand-written.</FeatureCard>
          <FeatureCard title="Review Bottleneck">Manual code review doesn&apos;t scale when 50%+ of code comes from AI. One reviewer per PR becomes a bottleneck, not a quality gate.</FeatureCard>
          <FeatureCard title="No Governance Framework">GitHub PRs have no concept of risk levels, evidence requirements, four-eyes principles, or compliance rules. Every PR gets the same lightweight treatment.</FeatureCard>
          <FeatureCard title="Lost Knowledge">Decisions, precedents, and patterns discovered during review disappear into Slack threads and forgotten PR comments instead of becoming reusable organizational knowledge.</FeatureCard>
        </div>
        <P>Arbitra solves this by turning each piece of work into a <strong>Case</strong> — a governed, trackable unit with structured reviews, configurable rules, evidence requirements, and documented decisions.</P>

        <H3 id="how-it-works">How It Works</H3>
        <P>Every code change flows through a defined lifecycle:</P>
        <div className="flex flex-wrap items-center gap-2 mb-4 justify-center">
          {[
            { label: 'PR / Change', color: 'bg-blue-100 dark:bg-blue-950 text-blue-700 dark:text-blue-400 border-blue-200 dark:border-blue-800' },
            { label: 'Case Created', color: 'bg-blue-100 dark:bg-blue-950 text-blue-700 dark:text-blue-400 border-blue-200 dark:border-blue-800' },
            { label: 'LLM Review', color: 'bg-amber-100 dark:bg-amber-950 text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-800' },
            { label: 'Rules Evaluated', color: 'bg-amber-100 dark:bg-amber-950 text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-800' },
            { label: 'Evidence Collected', color: 'bg-amber-100 dark:bg-amber-950 text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-800' },
            { label: 'Decision', color: 'bg-green-100 dark:bg-green-950 text-green-700 dark:text-green-400 border-green-200 dark:border-green-800' },
          ].map((step, i) => (
            <div key={step.label} className="flex items-center gap-2">
              {i > 0 && <span className="text-gray-300 dark:text-gray-600">&rarr;</span>}
              <span className={`inline-flex items-center rounded-md border px-2.5 py-1 text-xs font-semibold ${step.color}`}>{step.label}</span>
            </div>
          ))}
        </div>
        <P>A developer opens a PR or creates a case manually. Arbitra automatically reviews the code with one or more LLMs, evaluates project rules, checks that required evidence (CI, tests, screenshots) is present, and surfaces findings for human decision. The reviewer approves, requests changes, or waives individual findings — all with a documented rationale and full audit trail.</P>
        <Callout type="info">Most transitions are automatic. A project&apos;s <strong>Lifecycle Profile</strong> controls which phase boundaries (&quot;gates&quot;) require explicit human confirmation and which auto-advance — see <em>Lifecycle Profiles &amp; Gates</em> below.</Callout>

        <H3 id="first-case">Your First Case</H3>
        <P>Here&apos;s how to create and resolve your first case:</P>
        <div className="space-y-2 mb-4">
          {[
            ['1. Create a Case', 'From the IDE: use the Arbitra skill in Cursor or /create-case in Claude Code. From the UI: click "+ New Case" on the Board. A PR also auto-creates a case via webhook.'],
            ['2. Explore', 'The agent analyses the codebase and calls signal_exploration_complete. Case auto-transitions to ready_for_build (unless the preset gates it).'],
            ['3. Build', 'The agent implements the change, commits, pushes, creates a PR, and calls signal_build_complete with evidence items. Case advances to in_validation.'],
            ['4. Validation & Review', 'Rule runs execute, the evidence evaluator checks required items, and the LLM review runs against the diff. Check the Runs tab for model, token usage (prompt/completion/total), and duration.'],
            ['5. Auto-route on Findings', 'No high/critical findings + direct track low/medium risk → auto-approve. High/critical findings OR direct track with high/critical risk → needs_human_decision. Manual track without high/critical → verification_pending.'],
            ['6. Enter Courtroom', 'Open the Courtroom to see findings, evidence, and the decision form side by side. Select a finding, pick Waive/Accept, add rationale.'],
            ['7. Submit Decision', 'Approve, request changes, reject, or waive individual findings. Every decision is logged with actor, timestamp, and rationale.'],
            ['8. Merge & Done', 'Once approved the case enters pending_merge. When the PR merge webhook arrives, case closes to done.'],
          ].map(([step, desc]) => (
            <div key={step} className="flex gap-3 text-sm">
              <span className="font-semibold text-accent-700 dark:text-accent-300 whitespace-nowrap">{step}</span>
              <span className="text-gray-600 dark:text-gray-400">{desc}</span>
            </div>
          ))}
        </div>

        <H3 id="onboarding">Project Onboarding</H3>
        <P>Getting a new project into Arbitra takes about 15 minutes:</P>
        <div className="space-y-2 mb-4">
          {[
            ['1. Create a Project', 'Go to Projects \u2192 New. Name, description, default validation track (direct or manual), and lifecycle preset (autonomous / standard / strict).'],
            ['2. Add Your Repository', 'In the project detail, open the Repositories tab and click "Add Repository". Enter the GitHub URL, provider, and optional repo-specific GitHub token.'],
            ['3. Configure Webhook', 'Copy the webhook URL shown in the project detail. Add it in GitHub \u2192 Settings \u2192 Webhooks. Select these events: Pull requests, Pushes, Repositories. Missing Pull requests means merges will not auto-close cases.'],
            ['4. Tune the Evidence Policy', 'Open the Evidence Policy tab. Defaults work for most teams; override any risk\u00D7track cell to add or drop required evidence.'],
            ['5. Add Rule Sets', 'Open the Rules tab. Use the Rule Set Wizard to pick starter rules (e.g., test coverage, diff size, security patterns).'],
            ['6. Invite Reviewers & Tech Leads', 'Overview tab \u2192 Members. Add team members to the reviewer pool and designate tech leads. They log in with Google Workspace \u2014 no separate registration.'],
            ['7. (Optional) Chat Notifications', 'Overview tab \u2192 Notifications. Paste a Google Chat webhook URL and customise per-event message templates.'],
            ['8. Init Your Repo', `Run: curl -sL ${appUrl || 'YOUR_ARBITRA_URL'}/api/init/init.sh | bash -s -- <project_id>. This writes .arbitra/ with AGENT.md, CREATE-CASE.md, and case-spec.json.`],
            ['9. Open Your First PR', 'A case is automatically created via webhook. Or use the Arbitra skill in Cursor / the MCP server in Claude Code to drive the full lifecycle from the IDE.'],
          ].map(([step, desc]) => (
            <div key={step} className="flex gap-3 text-sm">
              <span className="font-semibold text-accent-700 dark:text-accent-300 whitespace-nowrap">{step}</span>
              <span className="text-gray-600 dark:text-gray-400">{desc}</span>
            </div>
          ))}
        </div>
        <Callout type="tip">For developers, onboarding is even simpler: sign in with your Google Workspace account. That&apos;s it — no separate registration, no API keys, no configuration.</Callout>

        {/* ============================================================= */}
        {/* CORE CONCEPTS                                                  */}
        {/* ============================================================= */}
        <H2 id="core-concepts">Core Concepts</H2>

        <H3 id="cases-lifecycle">Cases & Lifecycle</H3>
        <P>A <strong>Case</strong> is the central unit of work. Every code change that needs governance becomes a case. Cases flow through a state machine with 12 statuses, defined in <InlineCode>packages/shared/src/types/case.ts</InlineCode>:</P>
        <div className="flex flex-wrap gap-1.5 mb-4">
          {['open', 'exploration', 'ready_for_build', 'in_build', 'in_validation', 'in_review', 'needs_human_decision', 'verification_pending', 'approved', 'pending_merge', 'done', 'rejected'].map((s) => (
            <span key={s} className="inline-flex items-center rounded-full bg-gray-100 dark:bg-gray-800 px-2.5 py-0.5 text-xs font-mono font-medium text-gray-700 dark:text-gray-300">{s}</span>
          ))}
        </div>
        <P>Transitions have <strong>formal preconditions</strong> enforced server-side (see <InlineCode>status-transitions.ts</InlineCode>). For example, <InlineCode>needs_human_decision &rarr; approved</InlineCode> requires <InlineCode>human_approve_documented</InlineCode>, <InlineCode>all_high_critical_resolved</InlineCode>, <InlineCode>required_evidence_satisfied</InlineCode>, and <InlineCode>four_eyes_if_required</InlineCode>. Every transition emits an immutable event in the audit trail.</P>
        <P>Terminal statuses are <InlineCode>done</InlineCode> and <InlineCode>rejected</InlineCode> — no further automation runs against them. <InlineCode>pending_merge</InlineCode> is the handoff state between approval and the actual merge: the case waits for the PR merge webhook, then auto-closes to <InlineCode>done</InlineCode>.</P>
        <Callout type="info">Auto-close on merge: if a GitHub webhook reports a merged PR while the case is still in <InlineCode>in_build</InlineCode>, <InlineCode>in_validation</InlineCode>, <InlineCode>in_review</InlineCode>, or <InlineCode>approved</InlineCode>, the case short-circuits to <InlineCode>done</InlineCode> — but only for low/medium-risk work, or a high/critical-risk case that already has an approval decision documented. An escalated or otherwise high/critical-risk case with unmet evidence does NOT get this shortcut: like a merge reported while the case is at a human-gated state (<InlineCode>needs_human_decision</InlineCode>, <InlineCode>verification_pending</InlineCode>), it emits a <InlineCode>case_anomaly_merge_on_gated_status</InlineCode> event instead and stays open for the normal review/approval path.</Callout>

        <H3 id="case-templates">Case Templates</H3>
        <P>A project can define reusable <strong>Case Templates</strong> — pre-filled defaults for new cases: case type, risk level, priority, validation track, a title prefix, a description template, and a set of rule sets to activate. Schema in <InlineCode>packages/shared/src/types/case-template.ts</InlineCode>.</P>
        <P>Templates show up as a dropdown in the <InlineCode>+ New Case</InlineCode> modal — pick one to pre-fill the form, or start from scratch. There is no template management screen yet; templates are created via <InlineCode>POST /api/case-templates</InlineCode> by any project member (owner, reviewer, tech lead, or admin).</P>

        <H3 id="lifecycle-profiles">Lifecycle Profiles & Gates</H3>
        <P>Each phase boundary is a <strong>gate</strong>. A gate is either <InlineCode>auto</InlineCode> (pipeline advances without asking) or <InlineCode>confirm</InlineCode> (an authorised user must confirm before the transition fires). Gate behaviour is chosen per project via a <strong>Lifecycle Profile</strong>.</P>
        <P>Three presets ship out of the box (<InlineCode>packages/shared/src/constants/lifecycle-presets.ts</InlineCode>):</P>
        <Table
          headers={['Preset', 'When to use', 'Gates that require confirmation']}
          rows={[
            ['autonomous', 'Trusted agents, low-risk projects, demos', 'none — every gate auto-advances'],
            ['standard (default)', 'Day-to-day engineering work', 'ready_to_build only'],
            ['strict', 'Regulated domains, critical systems', 'exploration_to_ready, ready_to_build, build_to_validation, validation_to_review, review_to_approved, approved_to_pending_merge'],
          ]}
        />
        <P>Individual gates can be overridden on top of a preset. Nine gate IDs exist: <InlineCode>exploration_to_ready</InlineCode>, <InlineCode>ready_to_build</InlineCode>, <InlineCode>build_to_validation</InlineCode>, <InlineCode>validation_to_review</InlineCode>, <InlineCode>review_to_approved</InlineCode>, <InlineCode>review_to_needs_human</InlineCode>, <InlineCode>review_to_verification</InlineCode>, <InlineCode>approved_to_pending_merge</InlineCode>, <InlineCode>pending_merge_to_done</InlineCode>.</P>
        <P>When a confirm gate is reached the case sets a <InlineCode>pending_gate</InlineCode> marker and stops advancing. The lifecycle tracker surfaces this as an explicit &quot;Action required&quot; step, and only users whose role is listed in <InlineCode>gate_confirmer_roles</InlineCode> (default: <InlineCode>reviewer</InlineCode> and <InlineCode>tech_lead</InlineCode>) can clear it. Configure under Projects &rarr; your project &rarr; Overview &rarr; Lifecycle.</P>

        <H3 id="findings-severity">Findings & Severity</H3>
        <P>Findings are issues discovered during review — by LLMs, rule evaluation, or humans. Schema in <InlineCode>packages/shared/src/types/finding.ts</InlineCode>:</P>
        <Table
          headers={['Field', 'Values / Description']}
          rows={[
            ['severity', 'info, low, medium, high, critical — determines governance rigor'],
            ['confidence', '0–100 — how certain the reviewer is about this finding'],
            ['category', 'bug, architecture_violation, rule_violation, rule_override_conflict, missing_evidence, test_gap, security_risk, performance_risk, maintainability_issue, clarification_needed, large_diff_warning, diff_exceeds_limit, risk_downgrade_audit'],
            ['status', 'open, accepted, fixed, waived, contested, resolved, waiver_proposed, waived_on_completion'],
            ['origin_type', 'reviewer (LLM), rule_engine, test_engine, human'],
            ['consensus', 'Populated when multiple LLMs reviewed: reviewer_count, agreement_count, agreement_ratio, models[]'],
            ['signature', 'Deterministic dedup hash. Repeated reviews merge rather than duplicate.'],
          ]}
        />
        <P>When a decision is submitted against a finding (e.g. <InlineCode>waive</InlineCode>), the finding&apos;s status updates immediately. Waived / resolved / fixed findings are visually greyed out in the Courtroom and Findings list. Severity can be contested via <InlineCode>severity_contested</InlineCode> — the original severity is preserved and the contest is audited.</P>
        <P>An IDE agent can propose waiving or resolving a finding via the MCP <InlineCode>resolve_finding</InlineCode> tool without acting unilaterally: the finding moves to <InlineCode>waiver_proposed</InlineCode> and still blocks approval wherever it would otherwise gate; a human confirms it with a Waive/Approve decision in the Courtroom. If the case reaches <InlineCode>done</InlineCode> before that confirmation, the proposal closes automatically as <InlineCode>waived_on_completion</InlineCode> — a system-recorded outcome, not a human decision.</P>
        <Callout type="tip">Multi-LLM reviews produce consensus metadata. A finding flagged by 3 of 3 models (agreement_ratio 1.0) is a strong signal; one flagged by 1 of 3 is worth a second look before acting on it.</Callout>

        <H3 id="evidence-policies">Evidence & Policies</H3>
        <P>Evidence proves the change is safe to ship: CI results, test outputs, lint reports, screenshots, manual confirmations. Each project has an <strong>Evidence Policy</strong> (stored risk-first, track-second) that defines what is required and what is optional per <InlineCode>risk_level &times; validation_track</InlineCode> cell.</P>
        <P>Evidence types (<InlineCode>packages/shared/src/types/evidence.ts</InlineCode>):</P>
        <div className="flex flex-wrap gap-1.5 mb-4">
          {['unit_test_result', 'integration_test_result', 'ci_result', 'lint_result', 'runtime_log', 'screenshot', 'diff_snapshot', 'manual_confirmation', 'benchmark_result', 'external_reference', 'pr_merged', 'detection_report'].map((t) => (
            <span key={t} className="inline-flex items-center rounded-full bg-gray-100 dark:bg-gray-800 px-2.5 py-0.5 text-xs font-mono font-medium text-gray-700 dark:text-gray-300">{t}</span>
          ))}
        </div>
        <P>Each evidence item also carries a <InlineCode>source_type</InlineCode> (<InlineCode>automated</InlineCode>, <InlineCode>manual</InlineCode>, <InlineCode>webhook</InlineCode>, <InlineCode>agent</InlineCode>) and a <InlineCode>machine_readable</InlineCode> flag so the pipeline can tell CI output apart from human-supplied attachments.</P>
        <P>Default policy (from <InlineCode>evidence-policy-defaults.ts</InlineCode>; project admins can override any cell):</P>
        <Table
          headers={['Risk', 'Direct Track — required', 'Manual Track — required', 'Four-eyes']}
          rows={[
            ['low', 'ci_result', 'ci_result, manual_confirmation', 'no'],
            ['medium', 'ci_result, unit_test_result', 'ci_result, unit_test_result, manual_confirmation', 'no'],
            ['high', 'ci_result, unit_test_result, runtime_log', 'ci_result, unit_test_result, runtime_log, screenshot, manual_confirmation', 'yes'],
            ['critical', 'ci_result, unit_test_result, runtime_log, integration_test_result', 'ci_result, unit_test_result, runtime_log, screenshot, manual_confirmation', 'yes'],
          ]}
        />
        <P>The Evidence Completeness Evaluator re-reads the policy from Firestore on every check and gates transitions on <InlineCode>required_evidence_satisfied</InlineCode>. <InlineCode>allow_self_approval</InlineCode> defaults to <InlineCode>false</InlineCode> at every cell — the case owner cannot tick their own manual_confirmation unless the policy explicitly opts in.</P>
        <Callout type="info">Evidence policies are edited per project under Projects &rarr; your project &rarr; Evidence Policy. There is no global policy editor — each project owns its own matrix and changes are versioned.</Callout>

        <H3 id="decisions-governance">Decisions & Governance</H3>
        <P>Decisions are the human judgements that drive case progression:</P>
        <Table
          headers={['Decision', 'Scope', 'Effect']}
          rows={[
            ['Approve', 'Case', 'Case progresses toward Done (approved → pending_merge → done)'],
            ['Request Changes', 'Case', 'Case returns to in_build for iteration'],
            ['Waive', 'Finding', 'Specific finding status → waived; may unblock approval'],
            ['Reject', 'Case', 'Case terminates at rejected (allowed from exploration onwards)'],
            ['Escalate', 'Both', 'Escalates to senior reviewer / tech lead'],
          ]}
        />
        <P><strong>Anti-gaming rules:</strong> Self-approval is prohibited by default (<InlineCode>allow_self_approval: false</InlineCode> in every cell of the default policy). High/critical findings can only be waived by reviewers, tech leads, or admins. Risk-level downgrades on existing cases emit a <InlineCode>risk_downgrade_audit</InlineCode> finding for traceability. Four-eyes, when required by the policy cell, means two different reviewers must confirm — and the owner cannot be one of them.</P>

        <H3 id="validation-tracks">Validation Tracks</H3>
        <P>Each case has a <InlineCode>validation_track</InlineCode> of either <InlineCode>direct</InlineCode> or <InlineCode>manual</InlineCode>. New cases inherit the project&apos;s <InlineCode>default_validation_track</InlineCode> (fallback <InlineCode>direct</InlineCode>); IDE agents can override per case.</P>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
          <FeatureCard title="Direct Track">
            Target system is CI/API-accessible. Evidence is collected automatically: CI results, test outputs, lint reports. Machine-verifiable. High/critical risk still routes through needs_human_decision — four-eyes applies per policy.
          </FeatureCard>
          <FeatureCard title="Manual Track">
            Target system requires manual testing (remote desktop, VPN, hardware). Evidence: screenshots, manual_confirmation, runtime logs. After review, low/medium cases go to verification_pending for a reviewer to confirm the manual test result; high/critical still routes through needs_human_decision.
          </FeatureCard>
        </div>

        <H3 id="risk-levels">Risk Levels</H3>
        <Table
          headers={['Level', 'Description', 'Governance']}
          rows={[
            ['low', 'Cosmetic, docs, minor tweaks', 'May auto-approve if all evidence satisfied and no high/critical findings'],
            ['medium', 'Standard feature work', 'LLM review + evidence required; auto-approve possible on direct track'],
            ['high', 'Core logic, auth, data models', 'Always routes through needs_human_decision on direct track; four-eyes on manual track'],
            ['critical', 'Security, infrastructure, compliance', 'Human decision required; four-eyes enforced; integration tests required by default'],
          ]}
        />

        <H3 id="knowledge-assets">Knowledge Assets</H3>
        <P>Knowledge Assets turn one-off decisions into reusable organisational memory. A reviewer hits the same architectural choice three times → promote it to a canonical pattern, and every future case gets the precedent as context. The data model lives in <InlineCode>packages/shared/src/types/knowledge.ts</InlineCode>.</P>

        <P><strong>Types</strong> (eight built in; <InlineCode>KnowledgeType</InlineCode> is an open union, custom types are allowed):</P>
        <Table
          headers={['Type', 'What it captures']}
          rows={[
            ['precedent', 'A specific decision made on a past case that should inform similar future cases'],
            ['pattern', 'A positive pattern to follow (e.g., "use the repository class for Firestore access")'],
            ['anti_pattern', 'A pattern to avoid, usually discovered via a post-mortem or review finding'],
            ['mock_template', 'Reusable test-double/mock scaffolding'],
            ['implementation_note', 'Free-form engineering note — tips, gotchas, cross-references'],
            ['review_guideline', 'Rubric or checklist a reviewer should apply to a class of cases'],
            ['architecture_decision', 'Short-form ADR capturing the "why" behind a structural choice'],
            ['exception_policy', 'Documented carve-out from a rule (e.g., "legacy module X is exempt from …")'],
          ]}
        />

        <P><strong>Lifecycle</strong> — every asset moves through a status progression enforced server-side:</P>
        <Table
          headers={['Status', 'Meaning', 'Who can move here']}
          rows={[
            ['suggested', 'Newly created. Visible but does not influence reviews.', 'Anyone'],
            ['verified', 'A tech lead or admin has confirmed the asset is accurate.', 'tech_lead, admin'],
            ['canonical', 'Authoritative. Referenced by AI reviewers as binding context.', 'tech_lead, admin'],
            ['deprecated', 'No longer recommended but kept for historical lookup.', 'tech_lead, admin'],
            ['superseded', 'Replaced by another asset; a pointer may live in the body.', 'tech_lead, admin'],
          ]}
        />

        <P><strong>Scope</strong> controls visibility and which cases pick the asset up as context. Stored as <InlineCode>scope_type</InlineCode> + <InlineCode>scope_ref</InlineCode>:</P>
        <Table
          headers={['scope_type', 'scope_ref', 'Typical use']}
          rows={[
            ['global', '*', 'Company-wide policy (e.g., security baseline)'],
            ['org', 'org_id', 'Organisation-level standard'],
            ['team', 'team_id', 'Team convention'],
            ['project', 'project_id', 'Project-specific pattern or decision'],
            ['repo', 'repository_id', 'Repo-specific quirk (legacy module, generated code layout)'],
          ]}
        />

        <P><strong>Provenance fields</strong> that make knowledge auditable rather than free-form wiki content:</P>
        <Table
          headers={['Field', 'Purpose']}
          rows={[
            ['source_case_refs', 'Cases that gave rise to this knowledge — click through to see the original decision'],
            ['source_decision_refs', 'Specific decisions that established the precedent'],
            ['trust_level', '0–100 integer. Raised over time as the asset gets referenced and re-confirmed.'],
            ['version', 'Incremented on every update; previous versions are retained.'],
            ['tags', 'Free-form labels for search and filtering'],
            ['artifact_refs', 'Supporting files stored in Cloud Storage (diagrams, sample code, …)'],
            ['last_referenced_at', 'Updated whenever a case picks this asset up as context'],
            ['expires_at', 'Optional TTL. After expiry the asset is eligible for review / deprecation.'],
          ]}
        />

        <P><strong>How assets enter a case.</strong> A case carries <InlineCode>knowledge_context_refs</InlineCode> — a list of asset IDs pulled in as LLM review context. At review time the system loads the referenced assets and prepends their bodies to the reviewer prompt. <InlineCode>suggested</InlineCode> assets are NOT automatically pulled in — only <InlineCode>verified</InlineCode> and <InlineCode>canonical</InlineCode> assets influence reviews.</P>

        <P><strong>Creation flow.</strong> Create from the Knowledge page (<InlineCode>/knowledge</InlineCode>) — title, summary, body, type, scope, tags, optional expiry. Newly-created assets start as <InlineCode>suggested</InlineCode>. A tech lead or admin promotes via the detail panel. Creation emits a <InlineCode>knowledge_asset_created</InlineCode> event on the originating case (if any), keeping the audit chain intact.</P>

        <Callout type="info">Role gating is uniform: every write path (promote to canonical, edit, delete) is guarded by the same <InlineCode>tech_lead | admin</InlineCode> check in <InlineCode>KnowledgeService</InlineCode>. Developers and reviewers can suggest new assets but cannot self-promote them.</Callout>

        {/* ============================================================= */}
        {/* VIEWS                                                          */}
        {/* ============================================================= */}
        <H2 id="views">Views</H2>

        <H3 id="board-view">Board View</H3>
        <P>Your dashboard. Shows all cases with filtering, sorting, and multiple view modes:</P>
        <div className="grid grid-cols-2 gap-3 mb-4">
          <FeatureCard title="List View">Sortable table with status, risk, priority, owner. Click column headers to sort.</FeatureCard>
          <FeatureCard title="Board (Kanban) View">Cases grouped by status in swim-lane columns. Use transitions — no drag.</FeatureCard>
          <FeatureCard title="Lifecycle View">Cases arranged along the lifecycle pipeline — quick read on where work is stuck.</FeatureCard>
          <FeatureCard title="Filters">Status, risk level, validation track, priority, owner, archived toggle. Filters persist in URL — shareable links.</FeatureCard>
        </div>
        <P>The default view mode is configurable in Settings &rarr; General (<InlineCode>boardDefault</InlineCode>). Create new cases via the <InlineCode>+ New Case</InlineCode> button — title, description, project, risk level, track.</P>

        <H3 id="review-session">Review Session</H3>
        <P>Review Session (<InlineCode>/review-session</InlineCode>) turns the Board&apos;s triage views into a queue: one case at a time, ordered by urgency — a <InlineCode>pending_gate</InlineCode> first, then <InlineCode>needs_human_decision</InlineCode>, then <InlineCode>verification_pending</InlineCode>, then cases with open findings, then everything else. Skip a case to move it to the back of the session without leaving the page.</P>
        <P>Reached from the Board&apos;s triage-view tabs (<InlineCode>Needs Me</InlineCode>, <InlineCode>Ready to Approve</InlineCode>, <InlineCode>Blocked</InlineCode>, <InlineCode>Waiting on Others</InlineCode>, <InlineCode>Recently Updated</InlineCode>, <InlineCode>My Active</InlineCode>, <InlineCode>All</InlineCode>) — the session inherits whichever view and filters were active on the Board. Default view is <InlineCode>Needs Me</InlineCode> for reviewers, tech leads, and admins; <InlineCode>My Active</InlineCode> for developers.</P>

        <H3 id="case-detail">Case Detail</H3>
        <P>Deep view into a single case. Five tabs (see <InlineCode>packages/frontend/src/app/cases/[caseId]/page.tsx</InlineCode>):</P>
        <Table
          headers={['Tab', 'Content']}
          rows={[
            ['Proof', 'Combined evaluation signal: findings, evidence, and decisions in one review surface.'],
            ['Runs', 'Execution history: every exploration, build, validation, rule, and AI review run. Model, token usage (prompt/completion/total), duration, trigger source.'],
            ['Comments', 'Threaded discussion. Supports Markdown and attached context files.'],
            ['Timeline', 'Append-only event log. Review events show model + token counts inline.'],
            ['Related', 'Cases sharing the same branch, repository, project, or owner — spot duplicate work.'],
          ]}
        />
        <P>The <strong>Lifecycle Tracker</strong> at the top shows the case&apos;s journey. Blue dot = current step. Orange dot = action required (<InlineCode>pending_gate</InlineCode>, <InlineCode>needs_human_decision</InlineCode>, <InlineCode>verification_pending</InlineCode>).</P>
        <Callout type="info">Cases in early phases (open, exploration, ready_for_build) can be edited — title, description, risk level, project, validation track. Click the pencil icon next to the title. Later phases are frozen except for decisions and comments.</Callout>

        <H3 id="dossier">Dossier</H3>
        <P>Every case has a <strong>Dossier</strong> view (<InlineCode>/cases/&lt;id&gt;/dossier</InlineCode>, opened via the <InlineCode>View Dossier</InlineCode> button in the case header) — a flat, chronological, print-friendly rendering of the case&apos;s full audit trail: findings, evidence, decisions, comments, events, and run history in one scrollable page, plus any knowledge assets linked to the case. Print chrome (sidebar, header, footer, the assistant launcher) is hidden automatically.</P>
        <P>It is a read-only, additive view — it does not replace the tabbed Case Detail page above and does not require a separate backend route; it fetches from the same per-case endpoints the tabs already use.</P>

        <H3 id="courtroom-view">Courtroom</H3>
        <P>The decision-making interface. Three-column layout:</P>
        <div className="grid grid-cols-3 gap-3 mb-4">
          <FeatureCard title="Left: Findings">List of all findings. Click to select. Resolved findings are greyed out.</FeatureCard>
          <FeatureCard title="Center: Detail">Full finding description, confidence bar, category, origin, reviewer model, consensus metadata.</FeatureCard>
          <FeatureCard title="Right: Evidence + Decision">Evidence sidebar with detail slide-over. Decision form: type selector, scope, linked finding IDs, rationale.</FeatureCard>
        </div>
        <P>Selecting a finding and choosing <InlineCode>Waive</InlineCode> auto-links the finding ID into the decision. The finding status updates immediately on submit.</P>

        <H3 id="observatory-view">Observatory</H3>
        <P>Metrics dashboard for team leads. Stat cards (total cases, pending review, approval rate, total findings), charts (status/risk distribution, findings by severity, direct vs manual split), throughput leaderboard (fastest cases to completion), and an activity feed timeline. Date range switcher: 7 / 30 / 90 days / all time.</P>

        <H3 id="intelligence-view">Intelligence</H3>
        <P>Admin-only page at <InlineCode>/observatory/intelligence</InlineCode>. A scheduled job scans the workspace for operational problems the normal review lifecycle does not catch on its own — six detectors ship today:</P>
        <Table
          headers={['Detector', 'What it flags']}
          rows={[
            ['Aging pending merge', 'Cases parked in pending_merge beyond 7 days.'],
            ['Stale open case', 'Non-terminal cases with no activity for 7 days.'],
            ['Orphan branch', 'Remote branches untouched for 30 days with no linked case.'],
            ['Repeated rework', 'Non-terminal cases with 3 or more request_changes events.'],
            ['High-risk without four-eyes', 'Done high/critical-risk cases with fewer than 2 distinct human approvers.'],
            ['Incomplete repository setup', 'Repositories with a missing or broken GitHub webhook / auth configuration.'],
          ]}
        />
        <P>A finding on a specific case is written in place on the case record (<InlineCode>intelligence_flags</InlineCode>) rather than as a comment or evidence item — there is no dedicated panel for it in Case Detail yet. Branch- and project-level findings post a dismissible entry to the Activity feed instead. This page shows run history and lets an admin enable or disable individual detectors and trigger a run manually.</P>
        <P>Thresholds (7 / 7 / 30 days, 3 rework events, 2 approvers) are fixed constants in <InlineCode>services/intelligence/config.ts</InlineCode> — there is no tuning UI yet.</P>

        <H3 id="knowledge-rules">Knowledge</H3>
        <P>The Knowledge page at <InlineCode>/knowledge</InlineCode> is the cross-project browser for <strong>Knowledge Assets</strong> only. List + detail layout, with create/edit modals and status promotion controls gated by role.</P>
        <Callout type="info">Rule Sets and Evidence Policies are <strong>no longer managed on the Knowledge page</strong>. They moved to per-project configuration — open <InlineCode>/projects/&lt;id&gt;</InlineCode> and use the Rules or Evidence Policy tab.</Callout>

        <H3 id="clerk-view">Clerk</H3>
        <P>Clerk is a governed, read-only task assistant, separate from case review. Ask it something and it runs a bounded tool loop, then records the request, the method it used, and its answer as a case in your own private <InlineCode>Clerk</InlineCode> project — every answer links back to that case. Clerk has no write tools: nothing it does can change a case, a rule, or any other record without a human acting on the result separately.</P>
        <P>There are three ways to reach it: the <InlineCode>/clerk</InlineCode> page, a direct message or an @mention to Clerk in Google Chat, and a Scheduled task that runs Clerk automatically on a recurring basis.</P>
        <Table
          headers={['Tab', 'Content']}
          rows={[
            ['Ask', 'Submit a question or task, see prior requests grouped by thread, open follow-ups.'],
            ['Context', 'Durable facts Clerk should know about you or your team (e.g. a roster). Entries marked "always inject" are read into every one of your prompts; others stay search-only.'],
            ['Scheduled', 'Your own task blueprints that re-run Clerk on a schedule, with create/edit/archive and a manual run-now.'],
          ]}
        />
        <P><strong>Read-only tool surface.</strong> Clerk can search or read cases (including the owner and assigned reviewer, with an owner filter for &quot;my cases&quot; questions), count completed or rejected cases over a time window grouped by project, search or read knowledge assets.</P>
        <P><strong>Google Chat.</strong> A direct message to the Clerk app, or an @mention of Clerk in a space, becomes a Clerk task. Clerk immediately replies in the same message thread with a 🔗 acknowledgement linking the case, then posts the answer into that thread once the task finishes — ✅ on success, &#9888; on failure — formatted for Chat (Markdown bold and lists are converted) and written in the requester&apos;s own language. Senders are matched to Arbitra users by exact e-mail address; a sender with no match gets a polite decline instead of a task.</P>
        <P>Follow-up routing depends on the channel. In a Chat <strong>space</strong>, replying inside the same thread continues the conversation; a quote-reply opens a new Chat thread and therefore starts a new task — that is how Chat itself handles quote-replies, not an Arbitra choice. In a <strong>DM</strong>, replying inside an existing thread always continues that conversation; a new top-level message continues according to your conversation window setting — <InlineCode>continuous</InlineCode>, <InlineCode>daily</InlineCode>, <InlineCode>idle_gap</InlineCode> (the default: a new conversation starts after 4 hours without a message), or <InlineCode>per_message</InlineCode> — configurable per user under Settings &rarr; Connections. Starting a top-level DM message with <InlineCode>neu:</InlineCode> or <InlineCode>new:</InlineCode> always begins a fresh conversation, regardless of that window setting. Sending a message while that conversation&apos;s task is still running gets a short &quot;still working&quot; reply instead of a second task.</P>
        <P>Independently of the Chat app above, any Clerk answer — including a Scheduled task run — can also be pushed to a personal Google Chat space through a webhook pasted under Settings &rarr; Connections. That is a one-way delivery mechanism, distinct from the two-way Chat app: it only pushes finished answers out, it does not accept DMs or @mentions as tasks.</P>
        <Callout type="info">Clerk and the Arbitra Helper below answer different questions. Clerk performs a task against your Arbitra data and leaves a case behind; the Helper answers questions about using Arbitra itself and creates nothing.</Callout>

        <H3 id="helper-bot-view">Arbitra Helper</H3>
        <P>A floating launcher (bottom-right corner, on every signed-in page) opens a choice between starting a Clerk task and asking the <strong>Arbitra Helper</strong>. The Helper gives an immediate conversational answer about Arbitra itself — setup, concepts, rules, integrations — drawn from the platform docs and knowledge assets, with the conversation history kept for multi-turn follow-ups. No case is created. Code- or case-specific questions are redirected to the IDE agent rather than answered here.</P>

        <H3 id="agent-presence-view">Agent Presence</H3>
        <P>A pill in the sidebar shows whether any IDE agent or run is currently active, and links to <InlineCode>/activity</InlineCode>. It combines two signals: active <InlineCode>Run</InlineCode> rows (exploration/build/validation/review in progress) and <InlineCode>AgentPresence</InlineCode> heartbeats — written whenever an authenticated call touches a case via comment, evidence, or transition. The source is labelled <InlineCode>ide_agent</InlineCode> for token-authenticated (MCP) calls and <InlineCode>web</InlineCode> for browser sessions.</P>

        <H3 id="projects-view">Projects</H3>
        <P>The Projects page lists every project you can see. Open a project for its tabs:</P>
        <Table
          headers={['Tab', 'Content']}
          rows={[
            ['Overview', 'Name, description, members, reviewer pool, tech leads, Lifecycle Profile (preset + gate overrides + confirmer roles), default validation track, LLM overrides (per-risk model selection), notification webhook URL + per-event templates.'],
            ['Repositories', 'Add / edit repositories. Shows the webhook URL with a copy button. Optional per-repo GitHub token for private repo diff fetch.'],
            ['Rules', 'Rule Sets and individual Rules scoped to this project. Rule Set Wizard for quick starts.'],
            ['Evidence Policy', 'The risk × track policy matrix for this project. Edit any cell; changes are versioned.'],
          ]}
        />

        <H3 id="settings-projects">Settings</H3>
        <P>Personal / workspace settings (<InlineCode>/settings</InlineCode>):</P>
        <Table
          headers={['Group', 'Tab', 'Content']}
          rows={[
            ['Workspace', 'General', 'Theme (light/dark/system), default board view mode.'],
            ['Workspace', 'Users', 'User management (admin only).'],
            ['Workspace', 'Connections', 'Per-tool × device tokens minted by the unified Connect flow; revoke individual tools or all credentials for a device. Advanced: mint CI service tokens.'],
            ['AI', 'AI Models', 'LLM provider & model selection per risk level (workspace-wide defaults). Projects can override.'],
            ['AI', 'Prompts', 'Edit review/exploration prompt templates.'],
            ['—', 'Setup', 'Deployment/init helpers for admins.'],
          ]}
        />
        <Callout type="info">Project management is no longer a settings tab. <InlineCode>/settings?tab=projects</InlineCode> now redirects to <InlineCode>/projects</InlineCode>.</Callout>

        {/* ============================================================= */}
        {/* INTEGRATION                                                    */}
        {/* ============================================================= */}
        <H2 id="integration">Integration</H2>

        <H3 id="llm-providers">LLM Provider Setup</H3>
        <P>Arbitra supports multiple LLM providers for AI reviews. No lock-in — switch with an environment variable, a workspace-wide admin setting, or a per-project override.</P>
        <P>The operated default is Anthropic&apos;s <InlineCode>claude-sonnet-5</InlineCode> across all four risk levels (low, medium, high, critical). Provider and per-risk model are configured workspace-wide in Firestore under <InlineCode>/settings/llm</InlineCode> (admins: Settings &rarr; AI &rarr; AI Models), which overrides the environment variable and the hardcoded fallbacks below; <InlineCode>ANTHROPIC_API_KEY</InlineCode> is the required provider secret for that default. Google remains a configurable alternative, not the default.</P>
        <Table
          headers={['Provider', 'Env Var', 'Fallback Model']}
          rows={[
            ['Anthropic', 'ANTHROPIC_API_KEY', 'claude-sonnet-5'],
            ['OpenAI', 'OPENAI_API_KEY', 'gpt-4o'],
            ['Google', 'GOOGLE_GENERATIVE_AI_API_KEY', 'gemini-3.5-flash'],
            ['OpenRouter', 'OPENROUTER_API_KEY', 'Various'],
          ]}
        />
        <Code>{`# .env
ARBITRA_LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...`}</Code>
        <P>Reviews use structured output (Zod schemas) — no hallucinated JSON. Token usage is tracked per run. A project can also override the provider and pick a specific model per risk level under Projects &rarr; Overview &rarr; LLM Overrides (fields <InlineCode>llm_overrides.provider</InlineCode> and <InlineCode>llm_overrides.models[risk_level]</InlineCode>), which takes precedence over the workspace-wide setting for that project.</P>

        <H3 id="git-webhooks">Git Webhook Setup</H3>
        <P>Connect your GitHub repository to automatically create cases from Pull Requests:</P>
        <div className="space-y-2 mb-4 text-sm">
          <div className="flex gap-3"><span className="font-semibold text-accent-700 dark:text-accent-300">1.</span><span className="text-gray-600 dark:text-gray-400">Go to your GitHub repository → Settings → Webhooks → Add webhook</span></div>
          <div className="flex gap-3"><span className="font-semibold text-accent-700 dark:text-accent-300">2.</span><span className="text-gray-600 dark:text-gray-400">Payload URL: <InlineCode>https://your-arbitra-domain/api/webhooks/git</InlineCode></span></div>
          <div className="flex gap-3"><span className="font-semibold text-accent-700 dark:text-accent-300">3.</span><span className="text-gray-600 dark:text-gray-400">Content type: <InlineCode>application/json</InlineCode></span></div>
          <div className="flex gap-3"><span className="font-semibold text-accent-700 dark:text-accent-300">4.</span><span className="text-gray-600 dark:text-gray-400">Choose &quot;Let me select individual events&quot; and select these events: <InlineCode>Pull requests</InlineCode>, <InlineCode>Pushes</InlineCode>, <InlineCode>Repositories</InlineCode>.</span></div>
        </div>
        <Callout type="warning">
          All three events are required. <InlineCode>Pull requests</InlineCode> drives case creation and auto-close on merge. <InlineCode>Pushes</InlineCode> links commits to cases. <InlineCode>Repositories</InlineCode> keeps routing alive across renames. A subscription limited to <InlineCode>push</InlineCode> will leave merged cases stuck at <InlineCode>approved</InlineCode>.
        </Callout>
        <details className="mb-4 rounded border border-gray-200 dark:border-border-subtle bg-surface-raised">
          <summary className="cursor-pointer px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300">Prefer CLI?</summary>
          <div className="px-4 pb-3 text-sm text-gray-600 dark:text-gray-400 space-y-2">
            <P>Patch an existing hook to the correct event set:</P>
            <Code>{`gh api -X PATCH repos/<owner>/<repo>/hooks/<hook_id> \\
  -f 'events[]=pull_request' \\
  -f 'events[]=push' \\
  -f 'events[]=repository'`}</Code>
            <P>Or list existing hooks to find the id:</P>
            <Code>{`gh api repos/<owner>/<repo>/hooks --jq '.[] | {id, events, config: .config.url}'`}</Code>
          </div>
        </details>
        <P>When a PR is opened, Arbitra auto-creates a case with detected risk level, case type (from branch prefix <InlineCode>feat/</InlineCode>, <InlineCode>fix/</InlineCode>, <InlineCode>refactor/</InlineCode>, …), extracted JIRA references, and a suggested title. CI webhooks (<InlineCode>/api/webhooks/ci</InlineCode>) auto-register evidence of type <InlineCode>ci_result</InlineCode> — the payload must include an explicit <InlineCode>case_id</InlineCode> (no branch fallback; requests without one are rejected with <InlineCode>400</InlineCode>). Merged-PR events trigger the auto-close paths described in Cases &amp; Lifecycle.</P>
        <Callout type="tip">Find the webhook URL in Projects → select your project → Repositories. A copy button is provided. Arbitra will surface an inline warning on the repository row if only <InlineCode>push</InlineCode> events have ever arrived — this means <InlineCode>Pull requests</InlineCode> is missing from the subscription.</Callout>

        <H3 id="notifications">Chat Notifications</H3>
        <P>Arbitra can post notifications to a Google Chat space when important case events happen. Configured per project under Overview &rarr; Notifications. The webhook URL must start with <InlineCode>https://chat.googleapis.com/</InlineCode> — other URLs are rejected by the notifier.</P>
        <P>Events that trigger a chat message (see <InlineCode>packages/backend/src/services/notification/event-notifier.ts</InlineCode>):</P>
        <Table
          headers={['Event', 'When it fires']}
          rows={[
            ['case_needs_decision', 'A case enters needs_human_decision (human_decision_requested)'],
            ['manual_validation_pending', 'A case enters verification_pending on the manual track'],
            ['case_approved', 'A case reaches approved'],
            ['case_rejected', 'A case is rejected'],
            ['changes_requested', 'A reviewer requests changes — case returns to in_build'],
            ['rule_violation', 'A critical rule run result is recorded'],
            ['evidence_missing', 'Required evidence is missing and blocks a transition'],
          ]}
        />
        <P>Each event has a per-project message template with <InlineCode>{`{{placeholder}}`}</InlineCode> variables (case title, case ID, deep link, reviewer, risk level, …). If a project omits the template field, a sensible default is used. Notifications are also always written to the in-app notifications feed — the chat webhook is additive, not a replacement.</P>
        <Callout type="info">This is a separate mechanism from Clerk in Google Chat (see <em>Clerk</em> above): this webhook pushes outbound case-event notifications for a project; the Clerk Chat app instead takes inbound questions (a DM or an @mention) and posts its answers back into the same thread.</Callout>

        <H3 id="ide-integration">IDE Agent Integration</H3>
        <P>Set up any Git repository for Arbitra with a single command. No special tools required — just <InlineCode>curl</InlineCode> and <InlineCode>git</InlineCode>.</P>
        <Code>{`# Inside your git repository:
curl -sL ${appUrl || 'YOUR_ARBITRA_URL'}/api/init/init.sh | bash -s -- <project_id>`}</Code>
        <P>This writes <InlineCode>.arbitra/</InlineCode> containing <InlineCode>AGENT.md</InlineCode> (agent instructions), <InlineCode>CREATE-CASE.md</InlineCode> (the case creation flow), <InlineCode>case-spec.json</InlineCode> (schema reference), plus CLI helpers and the Cursor skill under <InlineCode>.cursor/</InlineCode>. The <InlineCode>project_id</InlineCode> comes from the Projects page.</P>
        <Callout type="tip">No token paste needed. The MCP server obtains its credential from the OS keychain via the Connect flow on the first tool call. <InlineCode>.arbitra/.env</InlineCode> only carries the project pin (<InlineCode>ARBITRA_URL</InlineCode> + <InlineCode>ARBITRA_PROJECT_ID</InlineCode>), and is gitignored.</Callout>
        <P>In Cursor, the Arbitra skill auto-triggers when you mention cases, reviews, or the workflow. You can say &quot;drive the case through the workflow&quot; for the full lifecycle: Create → Explore → Build + Push + PR → Signal build-complete → Review → Merge.</P>
        <P>In Claude Code, the same lifecycle runs through the <InlineCode>arbitra-mcp</InlineCode> MCP server (create_case, detect_case_fields, signal_exploration_complete, signal_build_complete, transition_case, add_comment, register_evidence, …) plus <InlineCode>.arbitra/AGENT.md</InlineCode> which the agent reads automatically.</P>
        <Callout type="info">Agents must run their implementation-review step before calling <InlineCode>signal_build_complete</InlineCode>. Skipping self-review is the most common source of avoidable findings.</Callout>

        <H3 id="mcp-integration">MCP Server</H3>
        <P>IDE agents (Claude Code, Cursor, Codex) talk to Arbitra exclusively through the <strong>Model Context Protocol</strong>. The bridge is a small Node.js server, <InlineCode>arbitra-mcp</InlineCode>, run via <InlineCode>npx</InlineCode>. The IDE spawns it as a subprocess, exchanges an MCP <InlineCode>initialize</InlineCode> handshake, and then translates every tool call into an authenticated REST call against your Arbitra instance.</P>
        <P>The bridge exists for three reasons: a curated, agent-shaped tool surface (<InlineCode>progress_case</InlineCode> dispatches state-driven, evidence is a typed array), automatic <InlineCode>actor_metadata</InlineCode> stamping from the MCP handshake (<InlineCode>client_name</InlineCode>, <InlineCode>client_version</InlineCode>), and one-line setup in the IDE side.</P>
        <P><strong>Tool catalog — lifecycle:</strong> <InlineCode>get_case_context</InlineCode>, <InlineCode>progress_case</InlineCode>, <InlineCode>transition_case</InlineCode>, <InlineCode>create_case</InlineCode>, <InlineCode>detect_case_fields</InlineCode>, <InlineCode>update_case</InlineCode>.
        <br/><strong>Workflow:</strong> <InlineCode>add_comment</InlineCode>, <InlineCode>create_decision</InlineCode>, <InlineCode>resolve_finding</InlineCode>, (deprecated) <InlineCode>signal_build_complete</InlineCode>, <InlineCode>signal_exploration_complete</InlineCode>, <InlineCode>register_evidence</InlineCode>.
        <br/><strong>Read-only:</strong> <InlineCode>get_case</InlineCode>, <InlineCode>list_cases</InlineCode>, <InlineCode>list_findings</InlineCode>, <InlineCode>get_evidence_requirements</InlineCode>, <InlineCode>list_projects</InlineCode>, <InlineCode>get_project</InlineCode>, <InlineCode>list_repositories</InlineCode>, <InlineCode>search</InlineCode>, <InlineCode>list_knowledge_assets</InlineCode>, <InlineCode>list_rules</InlineCode>.
        <br/><strong>Rules &amp; knowledge:</strong> <InlineCode>create_rule</InlineCode>, <InlineCode>update_rule</InlineCode>, <InlineCode>create_rule_set</InlineCode>, <InlineCode>update_rule_set</InlineCode>, <InlineCode>create_knowledge_asset</InlineCode>.
        <br/><strong>Session:</strong> <InlineCode>reconnect</InlineCode> — clears a stale stored token and starts a new Connect flow when auth is broken.</P>
        <P><strong>Setup — Claude Code / Cursor / Codex.</strong> Add an entry to the IDE&apos;s MCP config (<InlineCode>claude mcp add</InlineCode>, <InlineCode>.cursor/mcp.json</InlineCode>, or <InlineCode>~/.codex/config.toml</InlineCode> respectively). Same shape in all three — no token in the env block; the server resolves it from the OS keychain via the Connect flow on the first tool call:</P>
        <Code>{`{
  "mcpServers": {
    "arbitra": {
      "command": "npx",
      "args": ["-y", "arbitra-mcp"],
      "env": {
        "ARBITRA_URL": "${appUrl || 'https://your-arbitra-instance.example.com'}"
      }
    }
  }
}`}</Code>
        <P>On macOS with a GUI-launched IDE, use an absolute <InlineCode>command</InlineCode> path (e.g. <InlineCode>/usr/local/node/bin/npx</InlineCode> or <InlineCode>/opt/homebrew/bin/npx</InlineCode>) and include <InlineCode>PATH</InlineCode> in <InlineCode>env</InlineCode> — IDEs launched from Finder often inherit a stripped environment. The first MCP tool call will print a one-time link to connect this project; click it to confirm and you&apos;re done.</P>
        <P><strong>Actor metadata &amp; self-signing.</strong> The bridge captures <InlineCode>clientInfo.name</InlineCode> and <InlineCode>clientInfo.version</InlineCode> from the MCP <InlineCode>initialize</InlineCode> handshake and stamps them on every comment, evidence item, build-complete signal, and decision. The agent does not have to pass them. The <InlineCode>model</InlineCode> field is intentionally <strong>not</strong> auto-injected — users switch LLM models per-prompt, so a startup-time env var would go stale. Convention from <InlineCode>AGENT.md</InlineCode>: agents self-sign comments with their identity, e.g. <InlineCode>— cursor · Codex 5.3</InlineCode> or <InlineCode>— claude-code · Claude Opus 4.7</InlineCode>.</P>
        <P><strong>Pinning a version.</strong> For reproducible installs (CI, regulated environments), pin to a specific package version: <InlineCode>arbitra-mcp@&lt;version&gt;</InlineCode>. Without a suffix, <InlineCode>npx</InlineCode> resolves to the latest published version — fine for interactive use, not recommended for CI.</P>
        <Callout type="info">Full tool catalog, per-client config details (Claude Code / Cursor / Codex), actor-metadata contract, and troubleshooting: <a className="underline" href="https://github.com/jsc2304/arbitra/blob/main/docs/mcp.md" target="_blank" rel="noopener noreferrer">docs/mcp.md</a>. Source: <a className="underline" href="https://github.com/jsc2304/arbitra/tree/main/packages/mcp" target="_blank" rel="noopener noreferrer">packages/mcp</a>.</Callout>

        <H3 id="concurrency">Parallel Work Is the Default</H3>
        <P>Case identity derives from the branch — one branch, one case. There is no local pointer file and no shared mutable state per checkout: agents resolve the case bound to the current branch via <InlineCode>GET /api/cases/resolve?repository_id=...&amp;branch=...</InlineCode>. Two IDE windows (Claude Code, Cursor, Codex) opened on the <em>same</em> checkout, on different branches, never race — each resolves its own case independently. <InlineCode>.arbitra/.env</InlineCode> (project pin — non-secret; tokens live in your OS keychain) is the only per-repo state file, and it is shared safely because all sessions write the same value.</P>
        <h4 className="text-base font-semibold text-gray-900 dark:text-gray-100 mt-6 mb-2">Git worktrees for physically separate working trees</h4>
        <P>Use separate <strong>git worktrees</strong> when you want two branches checked out side by side. Each worktree is an isolated working tree with its own <InlineCode>.arbitra/</InlineCode> directory, so two agents can progress two cases in parallel without stepping on each other:</P>
        <Code>{`git worktree add ../repo-case-A feat/case-A
git worktree add ../repo-case-B feat/case-B`}</Code>
        <P>Open each worktree as its own IDE window; each resolves the case for its own branch independently. When the case is done, remove the worktree with <InlineCode>git worktree remove ../repo-case-A</InlineCode>.</P>

        <H3 id="access-tokens">Connecting your IDE</H3>
        <P>Install the MCP server in your tool — the first tool call will print a one-time link. Click it to confirm and you&apos;re done. No tokens to copy. No env vars to set.</P>
        <h4 className="text-base font-semibold text-gray-900 dark:text-gray-100 mt-4 mb-2">Install</h4>
        <P><strong>Claude Code:</strong></P>
        <Code>{`# Install MCP server
claude mcp add arbitra -e ARBITRA_URL=${appUrl || 'https://your-arbitra-instance.example.com'} -- npx -y arbitra-mcp`}</Code>
        <P><strong>Cursor</strong> — add to <InlineCode>.cursor/mcp.json</InlineCode> (project) or <InlineCode>~/.cursor/mcp.json</InlineCode> (global). Restart Cursor after editing:</P>
        <Code>{`{
  "mcpServers": {
    "arbitra": {
      "command": "npx",
      "args": ["-y", "arbitra-mcp"],
      "env": {
        "ARBITRA_URL": "${appUrl || 'https://your-arbitra-instance.example.com'}"
      }
    }
  }
}`}</Code>
        <P><strong>Codex</strong> — paste into <InlineCode>~/.codex/config.toml</InlineCode> (HOME, not project-local). Restart Codex after editing:</P>
        <Code>{`[mcp_servers.arbitra]
command = "npx"
args = ["-y", "arbitra-mcp"]

[mcp_servers.arbitra.env]
ARBITRA_URL = "${appUrl || 'https://your-arbitra-instance.example.com'}"`}</Code>
        <P>The first MCP tool call will print a one-time link. Open the link, click Confirm, and you&apos;re done — no tokens to copy.</P>

        <h4 className="text-base font-semibold text-gray-900 dark:text-gray-100 mt-6 mb-2">Managing connections</h4>
        <P>Visit <strong>Settings → Connections</strong> to see every tool × device that has authenticated with Arbitra. You can revoke individual tools, or all tokens on a given device.</P>
        <P>Each (tool × device) pair gets its own token, minted by the Connect flow on first use. Revoking one entry only affects that specific tool on that specific machine — your other devices keep working. Actor identity in audit trails comes from <InlineCode>actor_metadata</InlineCode> (<InlineCode>client_name</InlineCode>, <InlineCode>client_version</InlineCode>, <InlineCode>model</InlineCode>) that the MCP client stamps on each request — independent of the token.</P>
        <Callout type="info">Connections are personal — each teammate goes through their own Connect flow. Tokens are stored in your OS keychain (macOS Keychain / Windows Credential Manager / libsecret), never in <InlineCode>.arbitra/.env</InlineCode> or <InlineCode>mcp.json</InlineCode>.</Callout>

        <h4 className="text-base font-semibold text-gray-900 dark:text-gray-100 mt-6 mb-2">Advanced — CI service tokens</h4>
        <P><strong>Two paths, one env var name:</strong></P>
        <ul className="list-disc pl-6 my-2 text-gray-700 dark:text-gray-300 space-y-1">
          <li><strong>Humans &amp; IDEs (default):</strong> use the <strong>Connect</strong> flow above. Tokens land in your OS keychain. Nothing to paste anywhere.</li>
          <li><strong>CI / automation (no browser, no keychain):</strong> mint a long-lived service token from <strong>Settings → Connections → Advanced → Create CI service token</strong> and expose it to your CI job as the <InlineCode>ARBITRA_TOKEN</InlineCode> environment variable. The MCP server picks it up at the top of the credential resolution chain.</li>
        </ul>
        <P>The <InlineCode>ARBITRA_TOKEN</InlineCode> env var is the <em>only</em> remaining way to inject a token directly. A legacy <InlineCode>ARBITRA_TOKEN=…</InlineCode> line in <InlineCode>.arbitra/.env</InlineCode> is <strong>no longer honoured</strong> — the MCP server warns and ignores it. If you previously pasted a token there, run <InlineCode>arbitra-mcp login</InlineCode> once to migrate to the keychain.</P>
        <Callout type="warning">CI service tokens are user-scoped and shown only once at creation. If lost, revoke and create a new one. Keep them out of version control — use your CI provider&apos;s secret store.</Callout>

        <H3 id="api-reference">API Reference</H3>
        <P>All endpoints accept JSON and return JSON. Authentication via <InlineCode>Authorization: Bearer &lt;token&gt;</InlineCode> header.</P>
        <Table
          headers={['Method', 'Endpoint', 'Description']}
          rows={[
            ['GET', '/api/cases', 'List cases (supports filters: status, project_id, risk_level, …)'],
            ['POST', '/api/cases', 'Create a new case'],
            ['GET', '/api/cases/:id', 'Get case details'],
            ['PATCH', '/api/cases/:id', 'Update case fields (phase-gated)'],
            ['POST', '/api/cases/:id/transition', 'Transition case status (server validates preconditions)'],
            ['GET', '/api/cases/:id/findings', 'List findings for a case'],
            ['GET', '/api/cases/:id/evidence', 'List evidence for a case'],
            ['POST', '/api/cases/:id/decisions', 'Submit a decision (links to findings)'],
            ['GET', '/api/cases/:id/events', 'Read the timeline / audit log'],
            ['GET', '/api/cases/:id/runs', 'Run history for a case'],
            ['POST', '/api/cases/:id/sync-merge', 'Reconcile a case against a GitHub merge state'],
            ['GET', '/api/cases/:id/export', 'Export a case as JSON bundle'],
            ['POST', '/api/cases/detect', 'Auto-detect case fields from git context'],
            ['POST', '/api/runs', 'Trigger an LLM review run'],
            ['GET', '/api/projects', 'List projects'],
            ['POST', '/api/projects', 'Create a project'],
            ['GET', '/api/rule-sets', 'List rule sets'],
            ['GET', '/api/rules', 'List rules'],
            ['GET', '/api/evidence-policies', 'Get the evidence policy for a project'],
            ['GET', '/api/knowledge', 'List knowledge assets'],
            ['POST', '/api/knowledge', 'Create a knowledge asset (starts as suggested)'],
            ['POST', '/api/agent/context/:caseId', 'Structured case brief for IDE agents (preconditions, lifecycle_profile, pending_gate)'],
            ['POST', '/api/agent/explore', 'Agent signal: exploration complete'],
            ['POST', '/api/agent/build-complete', 'Agent signal: build complete (accepts inline evidence items)'],
            ['GET', '/api/search?q=...', 'Cross-case search'],
            ['POST', '/api/webhooks/git', 'GitHub webhook endpoint'],
            ['POST', '/api/webhooks/ci', 'CI webhook endpoint'],
          ]}
        />

        {/* ============================================================= */}
        {/* ROLES                                                          */}
        {/* ============================================================= */}
        <H2 id="roles-permissions">Roles & Permissions</H2>

        <H3 id="role-developer">Developer</H3>
        <P>Creates cases, pushes code, responds to findings. Can waive low-severity findings with rationale. Cannot self-approve their own case (four-eyes is enforced server-side; <InlineCode>allow_self_approval</InlineCode> is false in every default policy cell).</P>

        <H3 id="role-reviewer">Reviewer</H3>
        <P>Reviews cases, examines findings and evidence, submits decisions. Can approve, request changes, or waive findings up to high severity. Assigned from the project&apos;s reviewer pool. Eligible to clear confirm gates (default <InlineCode>gate_confirmer_roles</InlineCode> includes reviewer).</P>

        <H3 id="role-tech-lead">Tech Lead</H3>
        <P>Full governance authority within a project. Can waive any finding including critical, approve cases, manage rule sets and evidence policies, edit the project&apos;s Lifecycle Profile, and promote knowledge assets (suggested → verified → canonical). Required for four-eyes sign-off on critical-risk cases where the policy demands it.</P>

        <H3 id="role-admin">Admin</H3>
        <P>Workspace-wide administrator. Manages users and workspace-level settings (AI Models, Prompts, Setup). Has all tech-lead permissions across every project. Admin is the only role that can delete users; admin and tech_lead share the knowledge promotion / edit / delete gate.</P>

        {/* ============================================================= */}
        {/* FAQ                                                            */}
        {/* ============================================================= */}
        <H2 id="faq">FAQ</H2>

        {[
          ['Why not just use GitHub Pull Request reviews?', 'GitHub reviews are manual and have no governance framework. Arbitra adds automated LLM reviews, configurable rules, evidence requirements, four-eyes principles, and a complete audit trail. It\'s governance, not just review.'],
          ['Which LLMs does Arbitra support?', 'Anthropic (Claude), OpenAI (GPT-4o), Google (Gemini), and OpenRouter. Switch providers with a single environment variable — no code changes, no lock-in. Projects can override the provider and pick a different model per risk level.'],
          ['What does a review cost?', 'Depends on the LLM provider. Typically $0.01–0.05 per case with GPT-4o or Gemini. Token usage is tracked per run in the case detail Runs tab for full cost transparency.'],
          ['What is Direct vs Manual Track?', 'Direct = target system is CI/API-accessible, so evidence is collected automatically. Manual = requires human testing (remote desktop, VPN, hardware) with screenshots and manual_confirmation. Four-eyes is mandatory for high/critical risk cells where the policy says so (true in the defaults for both tracks at high and critical).'],
          ['Can I define custom rules?', 'Yes. The Rule Engine supports five evaluation modes: metadata_check, diff_pattern, evidence_check, llm_evaluation, human_confirmation. Rules are layered: global → project, so each team can add project-specific rules on top of organisation-wide standards. Rule sets are managed per project under Projects → your project → Rules.'],
          ['How long does onboarding take?', 'About 15 minutes per project: create the project, add a repository, configure the GitHub webhook, pick a lifecycle preset, tune the evidence policy. For developers: sign in with Google Workspace — done.'],
          ['What happens when a PR is opened?', 'If the GitHub webhook is configured, Arbitra auto-creates a case. It detects case_type from the branch prefix (feat/*, fix/*, refactor/*), estimates risk_level from changed file paths, extracts JIRA references, and suggests a title. The developer can review and adjust before the case leaves open.'],
          ['Can I use Arbitra without AI agents?', 'Yes. You can create cases manually, upload evidence by hand, and use the Courtroom to make decisions. AI review is optional — the governance framework (lifecycle, evidence policy, decisions, audit trail) stands on its own.'],
          ['How does the four-eyes principle work?', 'When the policy cell for a case\'s risk × track says four_eyes_required: true, two different reviewers must record an approve decision before the case can transition to approved. The case owner cannot be one of them. Enforced by the "four_eyes_if_required" precondition on the relevant transitions — it cannot be bypassed from the UI or API.'],
          ['What is the difference between needs_human_decision and verification_pending?', 'needs_human_decision = LLM review surfaced high/critical findings (or the case is direct-track high/critical) → a reviewer must decide approve/request-changes/reject. verification_pending = manual-track case without high/critical findings → a reviewer must confirm the manual test result before approval.'],
          ['How do Lifecycle Profiles affect my cases?', 'Profiles (autonomous / standard / strict) control which gates auto-advance and which require explicit confirmation. A strict project will pause the case at every phase boundary with a pending_gate marker. An autonomous project never pauses at a gate — human intervention only happens if the LLM surfaces high/critical findings.'],
          ['Can I get Google Chat notifications?', 'Yes. Paste a Google Chat webhook URL in Projects → Overview → Notifications. Events like case_needs_decision, manual_validation_pending, case_approved, and changes_requested trigger a message. Templates with {{placeholder}} variables are customisable per project per event.'],
          ['Where is my data stored?', 'Firestore (cases, findings, evidence metadata, decisions, comments, audit events) and Cloud Storage (comment attachments and artifacts) in your own GCP project. LLM API calls are the only external communication, and those are configurable per provider.'],
          ['Can I integrate Arbitra with my IDE?', 'Yes. Install the MCP server (claude mcp add arbitra -e ARBITRA_URL=<instance url> -- npx -y arbitra-mcp, or paste the equivalent block into .cursor/mcp.json / ~/.codex/config.toml) and run any Arbitra tool. The first tool call prints a one-time link to connect this project — no tokens to copy. Optionally run the init script (curl -sL ARBITRA_URL/api/init/init.sh | bash -s -- <project_id>) to drop .arbitra/ into the repo for the Cursor skill and slash commands.'],
        ].map(([q, a]) => (
          <div key={q} className="mb-4">
            <p className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-1">{q}</p>
            <p className="text-sm text-gray-600 dark:text-gray-400">{a}</p>
          </div>
        ))}

        {/* Footer */}
        <div className="mt-16 mb-8 border-t border-gray-200 dark:border-border-subtle pt-6 text-center">
          <p className="text-xs text-gray-400 dark:text-gray-500">
            Arbitra Documentation — Spec v1.0
          </p>
        </div>
      </section>
    </div>
  );
}
