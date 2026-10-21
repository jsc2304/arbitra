import { describe, it, expect } from 'vitest';
import { buildInitSnippetTabs } from '../init-snippets';

describe('buildInitSnippetTabs', () => {
  const input = {
    url: 'https://arbitra.example.com',
    projectId: 'proj_999',
  };

  it('returns unix, windows-powershell, windows-gitbash tabs in that order', () => {
    const tabs = buildInitSnippetTabs(input);
    expect(tabs).toHaveLength(3);
    expect(tabs[0]!.key).toBe('unix');
    expect(tabs[1]!.key).toBe('windows-powershell');
    expect(tabs[2]!.key).toBe('windows-gitbash');
  });

  it('unix tab label drops the Git Bash mention', () => {
    const [unix] = buildInitSnippetTabs(input);
    expect(unix!.label).toBe('macOS / Linux / WSL');
  });

  it('unix snippet matches the device-flow shape (URL + project id, no token)', () => {
    const [unix] = buildInitSnippetTabs(input);
    expect(unix!.snippet).toContain('export ARBITRA_URL="https://arbitra.example.com"');
    expect(unix!.snippet).toContain(
      'curl -sL "$ARBITRA_URL/api/init/init.sh" | bash -s -- proj_999',
    );
    // Tokens come from the Connect flow / OS keychain — never written here.
    expect(unix!.snippet).not.toContain('ARBITRA_TOKEN');
  });

  it('windows-powershell snippet uses curl.exe + bash -c to shell into Git Bash', () => {
    const [, ps] = buildInitSnippetTabs(input);
    // Load-bearing: `curl.exe` dodges PowerShell's Invoke-WebRequest alias,
    // and the outer `bash -c "$(curl.exe …)"` pipes the script body through
    // Git Bash. The init script's /dev/tty prompts only work in real bash.
    expect(ps!.key).toBe('windows-powershell');
    expect(ps!.label).toBe('Windows (PowerShell)');
    expect(ps!.snippet).toContain('bash -c "$(curl.exe -fsSL');
    expect(ps!.snippet).toContain('$env:ARBITRA_URL="https://arbitra.example.com"');
    expect(ps!.snippet).toContain('proj_999');
    expect(ps!.snippet).not.toContain('ARBITRA_TOKEN');
  });

  it('windows-gitbash snippet uses bash export + curl pipe', () => {
    const [, , gb] = buildInitSnippetTabs(input);
    expect(gb!.key).toBe('windows-gitbash');
    expect(gb!.label).toBe('Windows (Git Bash)');
    expect(gb!.snippet).toContain('export ARBITRA_URL="https://arbitra.example.com"');
    expect(gb!.snippet).toContain(
      'curl -sL "$ARBITRA_URL/api/init/init.sh" | bash -s -- proj_999',
    );
    expect(gb!.snippet).not.toContain('ARBITRA_TOKEN');
    expect(gb!.callout).toBeUndefined();
  });

  it('renders project-id placeholder verbatim when unknown', () => {
    const [unix, ps, gb] = buildInitSnippetTabs({
      url: 'http://localhost:3000',
      projectId: 'PROJECT_ID',
    });
    expect(unix!.snippet).toContain('bash -s -- PROJECT_ID');
    // `_ PROJECT_ID` form — `_` is $0 placeholder, PROJECT_ID is $1.
    expect(ps!.snippet).toContain(')" _ PROJECT_ID');
    expect(gb!.snippet).toContain('bash -s -- PROJECT_ID');
  });

  it('omits --ide for the cursor default to keep the historical snippet shape', () => {
    const [unix, ps, gb] = buildInitSnippetTabs({ ...input, ide: 'cursor' });
    expect(unix!.snippet).not.toContain('--ide');
    expect(unix!.snippet).toContain('bash -s -- proj_999');
    expect(ps!.snippet).not.toContain('--ide');
    expect(ps!.snippet).toContain(')" _ proj_999');
    expect(gb!.snippet).not.toContain('--ide');
    expect(gb!.snippet).toContain('bash -s -- proj_999');
  });

  it('injects --ide claude-code before the project id in all snippets', () => {
    const [unix, ps, gb] = buildInitSnippetTabs({ ...input, ide: 'claude-code' });
    expect(unix!.snippet).toContain('bash -s -- --ide claude-code proj_999');
    // Windows PS: `_` placeholder for $0, then --ide flag, then the project id.
    expect(ps!.snippet).toContain(')" _ --ide claude-code proj_999');
    expect(gb!.snippet).toContain('bash -s -- --ide claude-code proj_999');
  });

  it('supports codex and all', () => {
    const [unixCodex] = buildInitSnippetTabs({ ...input, ide: 'codex' });
    expect(unixCodex!.snippet).toContain('bash -s -- --ide codex proj_999');

    const [unixAll] = buildInitSnippetTabs({ ...input, ide: 'all' });
    expect(unixAll!.snippet).toContain('bash -s -- --ide all proj_999');
  });
});
