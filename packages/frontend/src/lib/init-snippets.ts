/**
 * Snippet builders for the two onboarding init commands (macOS/Linux/WSL/Git
 * Bash vs. Windows PowerShell-to-Git-Bash). Extracted out of the wizard and
 * the settings setup panel so:
 *
 *  1. Both UIs stay byte-identical.
 *  2. Snippet shape is unit-testable (pure string in, pure string out).
 *
 * Keep these in sync with `init.sh` served from
 * `packages/frontend/src/app/api/init/[...path]/route.ts` — the project_id
 * defaulting / prompting logic there is what makes these snippets forgiving
 * of placeholder values.
 *
 * NOTE: ARBITRA_TOKEN was dropped in the device-flow migration. Tokens are
 * minted by the unified Connect flow on the first MCP tool call and stored
 * in the OS keychain — the install snippet only needs to set ARBITRA_URL
 * for the curl-pipe-bash step that bootstraps the .arbitra/ directory.
 */

export const INIT_IDES = ['cursor', 'claude-code', 'codex', 'all'] as const;
export type InitIde = (typeof INIT_IDES)[number];

export const INIT_IDE_LABELS: Record<InitIde, string> = {
  cursor: 'Cursor',
  'claude-code': 'Claude Code',
  codex: 'Codex',
  all: 'All',
};

export type InitSnippetInput = {
  /** Arbitra server origin, e.g. `https://arbitra.example.com` or `http://localhost:3000`. */
  url: string;
  /** Project id, or a placeholder when no project is selected. */
  projectId: string;
  /**
   * Which IDE to wire up. Defaults to `cursor` for backward compatibility —
   * `init.sh` falls back to cursor when no `--ide` is passed and stdin is not
   * a tty (the `curl | bash` case), so omitting the flag in the cursor case
   * keeps the snippet identical to what users have copied historically.
   */
  ide?: InitIde;
};

export type InitSnippetTab = {
  key: 'unix' | 'windows-powershell' | 'windows-gitbash';
  label: string;
  /** Short descriptor shown under the tab selector. */
  hint: string;
  /** Optional callout to render under the snippet box (e.g. the Git-Bash note). */
  callout?: string;
  /** The snippet body to render inside a `<pre>` box. */
  snippet: string;
};

/**
 * Build both tabs' snippets for the current (url, projectId, ide) tuple.
 * The first tab is the default (Unix-y shells). The Windows tab uses
 * `curl.exe` to dodge PowerShell's `Invoke-WebRequest` alias and `bash -c`
 * to shell into Git Bash (Git for Windows installs it on PATH by default).
 */
export function buildInitSnippetTabs(input: InitSnippetInput): InitSnippetTab[] {
  const { url, projectId, ide = 'cursor' } = input;

  // Cursor is the script's no-flag default — keep the snippet flag-free in
  // that case so the long-standing copy-paste shape is preserved. For every
  // other IDE, emit `--ide <value>` ahead of the project id.
  const ideArgs = ide === 'cursor' ? '' : `--ide ${ide} `;

  const unix = [
    `export ARBITRA_URL="${url}"`,
    `# Run in your repository root:`,
    `curl -sL "$ARBITRA_URL/api/init/init.sh" | bash -s -- ${ideArgs}${projectId}`,
  ].join('\n');

  const windowsPowershell = [
    `# Requires Git for Windows (https://git-scm.com/download/win) — ships Git Bash.`,
    `# Run in your repo root via PowerShell:`,
    `$env:ARBITRA_URL="${url}"`,
    // The `_ ${projectId}` bit is load-bearing: `bash -c "<script>" arg0 arg1`
    // makes arg0 become $0 and arg1 become $1. Without the `_` placeholder for
    // $0, projectId would shift into $0 and the script's positional lookup
    // (`PROJECT_ID="${1:-}"`) would see nothing. When --ide is set, it sits
    // between `_` and the project id (still positional args 1..N).
    `bash -c "$(curl.exe -fsSL $env:ARBITRA_URL/api/init/init.sh)" _ ${ideArgs}${projectId}`,
  ].join('\n');

  const windowsGitBash = [
    `# Requires Git for Windows (https://git-scm.com/download/win).`,
    `# Run in your repo root via Git Bash:`,
    `export ARBITRA_URL="${url}"`,
    `curl -sL "$ARBITRA_URL/api/init/init.sh" | bash -s -- ${ideArgs}${projectId}`,
  ].join('\n');

  return [
    {
      key: 'unix',
      label: 'macOS / Linux / WSL',
      hint: 'Paste into your terminal and run in your repository root.',
      snippet: unix,
    },
    {
      key: 'windows-powershell',
      label: 'Windows (PowerShell)',
      hint: 'Paste into PowerShell in your repository root. Git Bash must be installed (Git for Windows).',
      snippet: windowsPowershell,
    },
    {
      key: 'windows-gitbash',
      label: 'Windows (Git Bash)',
      hint: 'Paste into Git Bash in your repository root.',
      snippet: windowsGitBash,
    },
  ];
}
