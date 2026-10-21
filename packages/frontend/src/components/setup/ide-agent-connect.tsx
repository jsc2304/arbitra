'use client';

import { useEffect, useState } from 'react';
import { useToast } from '../../providers/toast-provider';

type IdeKey = 'claude-code' | 'cursor' | 'codex' | 'other';

type IdeTab = {
  key: IdeKey;
  label: string;
  /** Human description above the snippet. */
  hint: string;
  /** Optional path / location, shown as a small label. Empty string for Other. */
  configPath: string;
  /** Install command body to render inside a `<pre>` box. */
  snippet: string;
};

/**
 * Install snippets for each IDE, advertising the unified Connect flow.
 *
 * Tokens are minted by the browser-based Connect flow on the first MCP tool
 * call and stored in the OS keychain — these snippets only need to register
 * the MCP server. No `-e ARBITRA_TOKEN=...`, no env-var paste, no token
 * generation step. The follow-up prose under each snippet describes the
 * one-time link the agent will print.
 */
const IDE_TABS: IdeTab[] = [
  {
    key: 'claude-code',
    label: 'Claude Code',
    hint: 'Register the MCP server with the Claude Code CLI.',
    configPath: 'claude mcp add',
    snippet: `# Install MCP server
claude mcp add arbitra -e ARBITRA_URL={{ARBITRA_URL}} -- npx -y arbitra-mcp`,
  },
  {
    key: 'cursor',
    label: 'Cursor',
    hint: 'Add to .cursor/mcp.json (project) or ~/.cursor/mcp.json (global). Restart Cursor after editing.',
    configPath: '.cursor/mcp.json',
    snippet: `{
  "mcpServers": {
    "arbitra": {
      "command": "npx",
      "args": ["-y", "arbitra-mcp"],
      "env": { "ARBITRA_URL": "{{ARBITRA_URL}}" }
    }
  }
}`,
  },
  {
    key: 'codex',
    label: 'Codex',
    hint: 'Paste into ~/.codex/config.toml (HOME, not project-local). Restart Codex after editing.',
    configPath: '~/.codex/config.toml',
    snippet: `[mcp_servers.arbitra]
command = "npx"
args = ["-y", "arbitra-mcp"]
env = { ARBITRA_URL = "{{ARBITRA_URL}}" }`,
  },
  {
    key: 'other',
    label: 'Other',
    hint: 'Any MCP-conformant client works. Launch a subprocess with the command + args below.',
    configPath: '',
    snippet: `command: npx
args: ["-y", "arbitra-mcp"]
env: ARBITRA_URL={{ARBITRA_URL}}`,
  },
];

type Props = {
  /** Optional project id — surfaced for user awareness so they know which project the Connect link will pre-select. */
  projectId?: string | null;
};

export function IdeAgentConnect({ projectId }: Props) {
  const [activeIde, setActiveIde] = useState<IdeKey>('claude-code');
  const [copied, setCopied] = useState(false);
  const { addToast } = useToast();
  // The instance URL is only known in the browser; set it after mount so the
  // server render and the first client render match.
  const [instanceUrl, setInstanceUrl] = useState('http://localhost:3000');
  useEffect(() => setInstanceUrl(window.location.origin), []);

  // IDE_TABS is non-empty and covers every IdeKey, so the lookup always resolves.
  const activeTab = (IDE_TABS.find((t) => t.key === activeIde) ?? IDE_TABS[0])!;
  const snippet = activeTab.snippet.replace('{{ARBITRA_URL}}', instanceUrl);

  function handleCopySnippet() {
    navigator.clipboard.writeText(snippet);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    addToast(
      'success',
      `${activeTab.label} install snippet copied${
        activeTab.configPath ? ` — run / paste into ${activeTab.configPath}` : ''
      }`,
    );
  }

  return (
    <div>
      {/* MCP explanation */}
      <div className="mb-4 rounded-lg border border-gray-200 dark:border-border-subtle bg-surface-base dark:bg-surface-base/50 p-3">
        <p className="text-xs text-gray-700 dark:text-gray-300 leading-relaxed">
          Your IDE talks to Arbitra through an{' '}
          <a
            href="/docs#mcp-integration"
            className="text-accent-700 dark:text-accent-300 underline underline-offset-2 hover:text-accent-800 dark:hover:text-accent-200"
          >
            MCP server
          </a>{' '}
          it spawns as a subprocess. Install it once per IDE — the first tool
          call will print a one-time link to connect this project. No tokens to
          copy; the snippets already point at this instance.
        </p>
        {projectId && (
          <p className="mt-2 text-[11px] text-gray-500 dark:text-gray-400">
            This project:{' '}
            <code className="rounded bg-gray-100 dark:bg-gray-800 px-1 font-mono text-gray-700 dark:text-gray-300">
              {projectId}
            </code>{' '}
            — the Connect link will pre-select it when the agent runs its first
            tool call from this repository.
          </p>
        )}
      </div>

      {/* IDE selector */}
      <div className="mb-2 flex flex-wrap gap-1 border-b border-gray-200 dark:border-border-subtle">
        {IDE_TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setActiveIde(tab.key)}
            className={`px-3 py-1.5 text-xs font-medium border-b-2 -mb-px transition-colors ${
              activeIde === tab.key
                ? 'border-accent text-accent-700 dark:text-accent-300'
                : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Active tab hint */}
      <p className="mb-2 text-xs text-gray-500 dark:text-gray-400">
        {activeTab.hint}
        {activeTab.configPath && (
          <>
            {' '}
            <code className="rounded bg-gray-100 dark:bg-gray-800 px-1 font-mono text-[11px] text-gray-700 dark:text-gray-300">
              {activeTab.configPath}
            </code>
          </>
        )}
      </p>

      {/* Snippet block */}
      <div className="relative mb-3">
        <pre className="rounded-lg bg-gray-900 dark:bg-surface-base p-4 text-xs font-mono text-green-400 dark:text-green-300 overflow-x-auto whitespace-pre leading-relaxed">
          {snippet}
        </pre>
        <button
          type="button"
          onClick={handleCopySnippet}
          className="absolute top-2 right-2 rounded-md bg-gray-700 hover:bg-gray-600 px-2.5 py-1 text-[10px] font-medium text-gray-300 hover:text-white transition-colors"
          title={`Copy ${activeTab.label} install snippet`}
        >
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>

      {/* Unified-flow prose */}
      <p className="mb-3 text-xs text-gray-600 dark:text-gray-400 leading-relaxed">
        The first MCP tool call will print a one-time link to connect this
        project. Open the link, click Confirm, and you&apos;re done — no tokens
        to copy.
      </p>

      {/* Footer link */}
      <div className="flex items-center justify-between text-[11px] text-gray-500 dark:text-gray-400">
        <a
          href="/docs#mcp-integration"
          className="inline-flex items-center gap-1 text-accent-700 dark:text-accent-300 hover:text-accent-800 dark:hover:text-accent-200 transition-colors"
        >
          Full MCP reference
          <svg
            className="h-3 w-3"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={2}
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M13.5 4.5 21 12m0 0-7.5 7.5M21 12H3"
            />
          </svg>
        </a>
        <span>After editing config, restart the IDE — MCP servers are not hot-reloaded.</span>
      </div>
    </div>
  );
}
