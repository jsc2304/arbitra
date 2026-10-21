import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { readFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GET } from './route';

// These tests cover the init flow: which files the catch-all route serves,
// and what the inline init script installs/writes for a fresh repo.
//
// Issue #984: the pre-write gate (Cursor preToolUse hook, arbitra-gate.sh,
// arbitra-gate.mdc/-short.mdc) and the local `.arbitra/.active-case` pointer
// are retired (ADR-0001 — Arbitra governs merges, not writes). This file
// tests that removal directly: those paths are gone from ALLOWED_FILES, the
// generated script no longer writes or gitignores a pointer file, and
// hooks.json no longer registers a preToolUse hook.
//
// The route reads files from disk via `process.cwd()` candidates; vitest runs
// from the frontend workspace, so `../../` resolves to the repo root where
// `.arbitra/templates/` lives.

function req(path: string): NextRequest {
  return new NextRequest(`http://localhost/api/init/${path}`, {
    headers: { host: 'localhost:3000' },
  });
}

function params(path: string): { params: Promise<{ path: string[] }> } {
  return { params: Promise.resolve({ path: path.split('/') }) };
}

describe('init catch-all route', () => {
  it('serves AGENTS.md template with the Arbitra marker block (no pointer/gate mentions)', async () => {
    const res = await GET(req('AGENTS.md'), params('AGENTS.md'));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('<!-- ARBITRA-GATE-START -->');
    expect(body).toContain('<!-- ARBITRA-GATE-END -->');
    expect(body).not.toContain('.active-case');
    expect(body).not.toContain('arbitra-gate.sh');
  });

  it('no longer serves the retired gate files', async () => {
    for (const path of [
      'arbitra-gate.sh',
      'arbitra-gate.mdc',
      'arbitra-gate-short.mdc',
      'cursor-hooks/arbitra-gate-pre.sh',
    ]) {
      const res = await GET(req(path), params(path));
      expect(res.status).toBe(404);
    }
  });

  it('serves PULL_REQUEST_TEMPLATE.md without gate-script checklist items', async () => {
    const res = await GET(
      req('PULL_REQUEST_TEMPLATE.md'),
      params('PULL_REQUEST_TEMPLATE.md'),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('## Arbitra');
    expect(body).not.toContain('arbitra-gate.sh');
    expect(body).not.toContain('in_build` while changes were made');
  });

  it('404s on unknown paths', async () => {
    const res = await GET(req('not-a-real-file.txt'), params('not-a-real-file.txt'));
    expect(res.status).toBe(404);
  });

  it('serves cursor hooks.json with sessionStart + afterFileEdit only (no preToolUse)', async () => {
    const res = await GET(req('cursor-hooks/hooks.json'), params('cursor-hooks/hooks.json'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.text();
    const parsed = JSON.parse(body);
    expect(parsed.version).toBe(1);
    expect(parsed.hooks.preToolUse).toBeUndefined();
    expect(parsed.hooks.sessionStart).toBeDefined();
    expect(parsed.hooks.afterFileEdit).toBeDefined();
  });

  it('serves arbitra-context-inject.sh (sessionStart hook) resolving by branch, not a pointer file', async () => {
    const res = await GET(
      req('cursor-hooks/arbitra-context-inject.sh'),
      params('cursor-hooks/arbitra-context-inject.sh'),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    // Verified against https://cursor.com/docs/hooks — sessionStart uses
    // `additional_context`, not `context` or `prompt_addendum`.
    expect(body).toContain('additional_context');
    expect(body).toContain('pending_gate');
    expect(body).toContain('.arbitra/AGENTS.md');
    expect(body).toContain('/api/cases/resolve');
    expect(body).not.toContain('.arbitra/.active-case');
    expect(body).not.toContain('.arbitra/.gate-status');
  });

  it('serves arbitra-evidence.sh (afterFileEdit hook) resolving by branch, not a pointer file', async () => {
    const res = await GET(
      req('cursor-hooks/arbitra-evidence.sh'),
      params('cursor-hooks/arbitra-evidence.sh'),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    // Conforms to createEvidenceSchema: type + source_type are required.
    expect(body).toContain('"type":"file_edit"');
    expect(body).toContain('"source_type":"agent"');
    expect(body).toContain('/api/cases/resolve');
    expect(body).not.toContain('.arbitra/.active-case');
    // Path filter — skip infra churn.
    expect(body).toContain('node_modules');
    expect(body).toContain('.arbitra/');
    expect(body).toContain('.cursor/');
    // Fire-and-forget: must always exit 0.
    expect(body).toContain('trap');
  });

  it('init.sh wires cursor hooks (conditional hooks.json, chmod +x scripts) without the gate hook', async () => {
    const res = await GET(req('init.sh'), params('init.sh'));
    const script = await res.text();

    // Don't stomp a user-customised hooks.json.
    expect(script).toContain('if [ ! -f "$CURSOR_ROOT/.cursor/hooks.json" ]; then');
    // Only the two remaining hook scripts get downloaded and chmod +x'd.
    expect(script).not.toContain('cursor-hooks/arbitra-gate-pre.sh');
    expect(script).toContain('cursor-hooks/arbitra-context-inject.sh');
    expect(script).toContain('cursor-hooks/arbitra-evidence.sh');
    expect(script).toContain('chmod +x "$CURSOR_ROOT/.cursor/hooks/arbitra-context-inject.sh"');
  });

  it('serves the /request-changes slash command resolving by branch, not a pointer file', async () => {
    const res = await GET(
      req('cursor-commands/request-changes.md'),
      params('cursor-commands/request-changes.md'),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/markdown');
    const body = await res.text();
    expect(body).toContain('create_decision');
    expect(body).toContain('request_changes');
    expect(body).not.toContain('.arbitra/.active-case');
    expect(body).toContain('/api/cases/resolve');
  });

  it('init.sh wires the /request-changes slash command into the install loop', async () => {
    const res = await GET(req('init.sh'), params('init.sh'));
    const script = await res.text();
    // request-changes must be present in the slash-command loop…
    expect(script).toMatch(/for cmd in status create-case explore build review request-changes; do/);
    // …and advertised in the user-facing confirmation line.
    expect(script).toContain('/request-changes');
  });

  it('init.sh keeps the positional project_id argument working (backwards compat)', async () => {
    const res = await GET(req('init.sh'), params('init.sh'));
    const script = await res.text();
    // The arg parser captures the positional <project_id> into PROJECT_ID.
    // Bare `bash -s -- proj_xxx` (today's curl-pipe-bash one-liner) must keep
    // working — that's the backward-compat contract.
    expect(script).toContain('PROJECT_ID=""');
    expect(script).toMatch(/if \[ -z "\$PROJECT_ID" \]; then/);
    expect(script).toMatch(/PROJECT_ID="\$1"/);
    // Default IDE remains cursor when no --ide flag is given.
    expect(script).toMatch(/IDE="cursor"/);
    // Usage message and non-interactive hard-fail still present.
    expect(script).toContain('Usage: curl -sL $ARBITRA_BASE/api/init/init.sh | bash -s -- <project_id>');
  });

  it('init.sh prompts via /dev/tty when run interactively', async () => {
    const res = await GET(req('init.sh'), params('init.sh'));
    const script = await res.text();
    // TTY detection: all three checks (stdin, stdout, /dev/tty readable) +
    // routing prompts explicitly through /dev/tty so `curl | bash` works.
    expect(script).toContain('if [ -r /dev/tty ] && [ -w /dev/tty ]; then');
    expect(script).toContain('[ -t 0 ] || [ -t 1 ]');
    expect(script).toContain('read answer < /dev/tty');
    // Reuse-existing-project prompt is still wired.
    expect(script).toContain('Existing project_id');
    expect(script).toContain('Reuse? [Y/n]');
  });

  it('init.sh writes .arbitra/.env with the project pin and no token', async () => {
    const res = await GET(req('init.sh'), params('init.sh'));
    const script = await res.text();
    // Atomic rewrite: write tmpfile, then mv. Never sed -i (flag varies GNU/BSD).
    expect(script).toContain('.arbitra/.env.tmp');
    expect(script).toContain('mv .arbitra/.env.tmp .arbitra/.env');
    // The new .env carries ARBITRA_URL + ARBITRA_PROJECT_ID, with the spec's
    // comment block about tokens-live-in-the-keychain.
    expect(script).toContain('# Arbitra project pin — personal per developer per repo, do NOT commit');
    expect(script).toContain('ARBITRA_URL=$ARBITRA_BASE');
    expect(script).toContain('ARBITRA_PROJECT_ID=$PROJECT_ID');
    expect(script).toContain('Tokens are stored in your OS keychain');
    // No token-writing code path remains: no PLACEHOLDER_TOKEN_, no
    // is_real_token validator, no prompt_secret() helper call, no
    // ARBITRA_TOKEN= emission into .env, no token reprompt loop.
    expect(script).not.toContain('PLACEHOLDER_TOKEN="arb_');
    expect(script).not.toMatch(/is_real_token\(\)/);
    expect(script).not.toMatch(/prompt_secret\(\)/);
    // The .env body never emits ARBITRA_TOKEN= — only ARBITRA_URL= and
    // ARBITRA_PROJECT_ID=. Comments mentioning "legacy ARBITRA_TOKEN= lines"
    // (which the script preserves verbatim) are fine; the assertion guards
    // against the script writing a fresh token line.
    expect(script).not.toContain('print "ARBITRA_TOKEN=" tok');
    expect(script).not.toContain('ARBITRA_TOKEN=$RESOLVED_TOKEN');
    expect(script).not.toMatch(/please try again/);
  });

  it('init.sh idempotent re-run preserves user-added keys in .arbitra/.env', async () => {
    const res = await GET(req('init.sh'), params('init.sh'));
    const script = await res.text();
    // awk script rewrites only the two lines this script owns; everything
    // else (custom env vars, legacy ARBITRA_TOKEN= lines, comments) is
    // preserved by the catch-all `{ print }` branch.
    expect(script).toContain('/^ARBITRA_URL=/');
    expect(script).toContain('/^ARBITRA_PROJECT_ID=/');
    // Per the device-flow migration: legacy ARBITRA_TOKEN= lines in existing
    // files are NOT auto-edited (the MCP server warns-and-ignores).
    expect(script).not.toMatch(/\/\^ARBITRA_TOKEN=\/.*ARBITRA_TOKEN=/);
  });

  it('init.sh --token flag is accepted but deprecated (back-compat)', async () => {
    const res = await GET(req('init.sh'), params('init.sh'));
    const script = await res.text();
    // The flag still parses (so historical curl-pipe-bash one-liners don't
    // crash with "unknown option"), but the value is ignored with a warning.
    expect(script).toContain('--token)');
    expect(script).toContain('--token is deprecated and ignored');
  });

  it('init.sh gitignores only .arbitra/.env and .mcp.json — no local case pointer', async () => {
    const res = await GET(req('init.sh'), params('init.sh'));
    const script = await res.text();
    expect(script).toContain('.arbitra/.env');
    expect(script).not.toContain('.arbitra/.active-case');
    expect(script).not.toContain('.arbitra/.gate-status');
    // grep-then-append idempotency guard.
    expect(script).toMatch(/grep -q '\.arbitra\/\.env' \.gitignore/);
    // else-branch printf seeds both entries at once when no .gitignore exists.
    expect(script).toContain(
      "printf '.arbitra/.env\n.mcp.json\n' > .gitignore",
    );
    // .mcp.json is gitignored — per-developer (npx absolute path embedded
    // differs by machine). Regenerated by re-running init.
    expect(script).toContain('.mcp.json');
    expect(script).toMatch(/grep -q '\.mcp\.json' \.gitignore/);
  });

  it('init.sh no longer installs a gate script or a gate-enforcement hint', async () => {
    const res = await GET(req('init.sh'), params('init.sh'));
    expect(res.status).toBe(200);
    const script = await res.text();

    // AGENTS.md marker-block logic is unchanged.
    expect(script).toContain('ARBITRA-GATE-START');
    expect(script).toContain('ARBITRA-GATE-END');
    expect(script).toContain('if [ ! -f AGENTS.md ]; then');
    expect(script).toMatch(/grep -qF "\$ARBITRA_MARKER_START" AGENTS\.md/);

    // .github/ is never auto-created
    expect(script).toContain('if [ -d .github ]; then');

    // No gate script, no SKIP_ARBITRA_GATE bypass hint, no client-side
    // enforcement wiring — Arbitra governs at merge time (ADR-0001).
    expect(script).not.toContain('scripts/arbitra-gate.sh');
    expect(script).not.toContain('SKIP_ARBITRA_GATE');
    expect(script).toContain('governs merges, not writes');
  });

  // --- --ide flag: Claude Code + Codex setup ----------------------------
  // Background: the curl-pipe-bash one-liner historically only installed the
  // Cursor surface. The --ide flag adds Claude Code and Codex setup paths
  // while preserving the cursor default for backward compat.

  it('init.sh advertises the --ide flag in --help output', async () => {
    const res = await GET(req('init.sh'), params('init.sh'));
    const script = await res.text();
    // Help text mentions all four IDE values.
    expect(script).toContain('--ide IDE');
    expect(script).toMatch(/cursor\s+Cursor/);
    expect(script).toMatch(/claude-code\s+Claude Code/);
    expect(script).toMatch(/codex\s+Codex CLI/);
    expect(script).toMatch(/all\s+All three/);
    // The cc alias is documented.
    expect(script).toContain('alias: cc');
  });

  it('init.sh parses --ide, --token, and --url flags', async () => {
    const res = await GET(req('init.sh'), params('init.sh'));
    const script = await res.text();
    // Both `--flag value` and `--flag=value` forms are supported.
    expect(script).toContain('--ide)');
    expect(script).toContain('--ide=*)');
    expect(script).toContain('--token)');
    expect(script).toContain('--token=*)');
    expect(script).toContain('--url)');
    expect(script).toContain('--url=*)');
    // cc → claude-code normalisation.
    expect(script).toMatch(/cc\) IDE="claude-code"/);
    // Invalid IDE values fail loudly rather than silently.
    expect(script).toContain("Invalid --ide value");
  });

  it('init.sh prompts interactively for IDE choice when no --ide flag given', async () => {
    const res = await GET(req('init.sh'), params('init.sh'));
    const script = await res.text();
    // 4-option prompt matches the local script's UX.
    expect(script).toContain('Which IDE are you setting up?');
    expect(script).toMatch(/1\) cursor/);
    expect(script).toMatch(/2\) claude-code/);
    expect(script).toMatch(/3\) codex/);
    expect(script).toMatch(/4\) all/);
    // Non-interactive default is cursor (preserves curl-pipe-bash behaviour).
    expect(script).toMatch(/else\s+IDE="cursor"/);
  });

  it('init.sh defines setup_cursor, setup_claude_code, setup_codex helpers', async () => {
    const res = await GET(req('init.sh'), params('init.sh'));
    const script = await res.text();
    expect(script).toContain('setup_cursor() {');
    expect(script).toContain('setup_claude_code() {');
    expect(script).toContain('setup_codex() {');
    // Dispatch case statement covers all four IDE values.
    expect(script).toMatch(/cursor\)\s+setup_cursor/);
    expect(script).toMatch(/claude-code\)\s+setup_claude_code/);
    expect(script).toMatch(/codex\)\s+setup_codex/);
    expect(script).toMatch(/all\)/);
  });

  it('setup_claude_code installs .mcp.json (with PATH) and the six lifecycle commands', async () => {
    const res = await GET(req('init.sh'), params('init.sh'));
    const script = await res.text();
    // .mcp.json at project root — Claude Code's canonical MCP config
    // location. Used by the standalone CLI, the macOS app, AND the Cursor
    // extension. (.claude/settings.json does NOT register MCP servers.)
    expect(script).toContain('.mcp.json');
    // .claude/settings.json must NOT be created or written for MCP — only
    // referenced in the next-steps text as a thing to delete if stale.
    expect(script).not.toMatch(/cat > \.claude\/settings\.json/);
    expect(script).not.toMatch(/Created \.claude\/settings\.json/);
    expect(script).toContain('"mcpServers"');
    expect(script).toContain('"arbitra"');
    // Installed from the npm registry, not from a GitHub spec.
    expect(script).toContain('"args": ["-y", "arbitra-mcp"]');
    expect(script).toContain('npm install -g arbitra-mcp');
    expect(script).not.toContain('github:');
    // PATH is injected into the MCP env block so npx can find node when
    // Claude Code is launched from a GUI (macOS app, Cursor extension)
    // with a stripped environment.
    expect(script).toContain('"PATH": "$MCP_PATH"');
    expect(script).toContain('NPX_BIN_DIR="$(dirname "$NPX_PATH")"');
    expect(script).toContain('MCP_PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"');
    // Safe-create-only: existing file is left alone (no jq dependency).
    expect(script).toMatch(/if \[ -f \.mcp\.json \]; then/);
    expect(script).toContain('already present — not modifying');
    // npx resolution falls back gracefully when not on PATH.
    expect(script).toContain('resolve_npx');
    expect(script).toContain('command -v npx');
    // All six lifecycle commands installed by reusing cursor-commands/* URLs.
    expect(script).toMatch(/for cmd in status create-case explore build review request-changes; do[\s\S]+?\.claude\/commands\/\$cmd\.md/);
    // /arbitra umbrella command (Claude-Code-only) shipped inline.
    expect(script).toContain('.claude/commands/arbitra.md');
    expect(script).toMatch(/description: Drive the Arbitra case lifecycle/);
    // Idempotency: existing per-command files preserved.
    expect(script).toMatch(/if \[ -f "\.claude\/commands\/\$cmd\.md" \]/);
    expect(script).toMatch(/if \[ -f \.claude\/commands\/arbitra\.md \]/);
    // .mcp.json is gitignored — per-developer (npx absolute path differs).
    expect(script).toContain("Added .mcp.json to .gitignore");
    // ARBITRA_TOKEN is NOT embedded in the .mcp.json env block — tokens
    // come from the OS keychain via the unified Connect flow.
    expect(script).not.toMatch(/"ARBITRA_TOKEN":\s*"\$TOKEN_FOR_MCP"/);
    expect(script).not.toContain('"ARBITRA_TOKEN":');
    // ARBITRA_URL is NOT embedded either — .arbitra/.env is the single
    // source of truth for the host (an env-level value would override it
    // and re-pin the repo to whichever instance ran the init). Pin BOTH
    // emission forms: the heredoc JSON key (`"ARBITRA_URL":`) and the
    // escaped echo merge-snippet form (`\"ARBITRA_URL\":`). The grep
    // stale-detection quotes the bare key without a colon, so it stays
    // unaffected by these assertions.
    expect(script).not.toContain('"ARBITRA_URL":');
    expect(script).not.toContain('\\"ARBITRA_URL\\":');
    expect(script).toMatch(/grep -q '"ARBITRA_URL"' \.mcp\.json/);
    expect(script).toContain('OVERRIDES .arbitra/.env');
  });

  it('setup_codex injects PATH into the printed TOML env block (no token, no URL)', async () => {
    // Same rationale as setup_claude_code: GUI-launched IDEs spawn MCP
    // subprocesses with a stripped environment. The printed TOML must
    // include PATH derived from the user's local npx so the spawned node
    // resolves regardless of Homebrew/nvm/volta/system-pkg install path.
    // ARBITRA_TOKEN is NOT in the env block — the MCP server resolves it
    // from the OS keychain on startup. ARBITRA_URL is NOT in the env block
    // either — ~/.codex/config.toml is global (one block for ALL repos), so
    // an embedded URL would pin every repo to one instance; the MCP server
    // reads the host from each repo's .arbitra/.env instead.
    const res = await GET(req('init.sh'), params('init.sh'));
    const script = await res.text();
    expect(script).toContain('env = { PATH = "$MCP_PATH" }');
    expect(script).not.toContain('ARBITRA_URL = "$ARBITRA_BASE"');
    expect(script).not.toContain('ARBITRA_TOKEN = "$TOKEN_FOR_MCP"');
    // Migration hint: stale env-level ARBITRA_URL in an existing global
    // TOML block must be called out for removal.
    expect(script).toContain('config.toml block still sets ARBITRA_URL in env, remove it');
    expect(script).toContain('it would override every repo');
  });

  it('setup_codex prints the TOML block and writes a .codex breadcrumb', async () => {
    const res = await GET(req('init.sh'), params('init.sh'));
    const script = await res.text();
    expect(script).toContain('[mcp_servers.arbitra]');
    expect(script).toContain('args = ["-y", "arbitra-mcp"]');
    // The host comes from .arbitra/.env, not the TOML — the printed notes
    // explain where the MCP server reads it from.
    expect(script).toContain('from each repo\'s .arbitra/.env');
    // No ARBITRA_TOKEN in the env block — handled by the keychain.
    // (Comments mentioning legacy ARBITRA_TOKEN= lines in .arbitra/.env are
    // fine; the assertion guards against the TOML emit line writing one.)
    expect(script).not.toMatch(/ARBITRA_TOKEN\s*=\s*"\$/);
    expect(script).not.toMatch(/ARBITRA_TOKEN\s*=\s*"arb_/);
    // Tells the user where to paste it.
    expect(script).toContain('~/.codex/config.toml');
    expect(script).toContain('-------- 8< --------');
    // The "one-time link" line points users at the Connect flow.
    expect(script).toContain('first MCP tool call will print a one-time link');
    // Project-local breadcrumb so future contributors find it.
    expect(script).toContain('.codex/README-arbitra.md');
  });

  it('default cursor path is preserved when --ide is omitted (backward compat)', async () => {
    const res = await GET(req('init.sh'), params('init.sh'));
    const script = await res.text();
    // The cursor block still produces the same per-file install steps the
    // pre-flag script did. setup_cursor wraps them but the bodies are intact.
    expect(script).toContain('setup_cursor() {');
    expect(script).toContain('.cursor/skills/arbitra/SKILL.md');
    expect(script).toContain('.cursor/hooks.json');
    expect(script).not.toContain('.cursor/rules/arbitra-gate.mdc');
    // Non-interactive (no TTY, no --ide): falls through to cursor.
    expect(script).toMatch(/else\s+IDE="cursor"/);
  });

  it('init.sh runs setup_cursor only when IDE includes cursor', async () => {
    const res = await GET(req('init.sh'), params('init.sh'));
    const script = await res.text();
    // The summary blocks gate cursor/claude/codex sections by $IDE.
    expect(script).toMatch(/if \[ "\$IDE" = "cursor" \] \|\| \[ "\$IDE" = "all" \]; then/);
    expect(script).toMatch(/if \[ "\$IDE" = "claude-code" \] \|\| \[ "\$IDE" = "all" \]; then/);
    expect(script).toMatch(/if \[ "\$IDE" = "codex" \] \|\| \[ "\$IDE" = "all" \]; then/);
  });

  it('init.sh validates ARBITRA_BASE against an http(s) ASCII allowlist', async () => {
    // ARBITRA_BASE flows unescaped into JSON (.mcp.json) and TOML (codex).
    // A URL containing ", \, `, or $ would corrupt those files. Reject up
    // front with a clear error rather than producing broken config.
    const res = await GET(req('init.sh'), params('init.sh'));
    const script = await res.text();
    expect(script).toContain(
      "grep -qE '^https?://[A-Za-z0-9._:/-]+$'",
    );
    expect(script).toContain('ARBITRA_URL must look like http(s)://host');
  });

  // --- Re-init contract-file preservation ---------------------------------
  // Background: re-running init.sh in an already-onboarded repo used to
  // clobber .arbitra/AGENTS.md, .arbitra/AGENTS-LEGACY-TOOLS.md,
  // .arbitra/CREATE-CASE.md (unconditional download) and
  // .arbitra/case-spec.json (rewritten from a minimal heredoc, dropping any
  // user-added fields like $schema / default_rule_sets / auto_detect).

  it('init.sh skips re-downloading .arbitra/AGENTS.md, AGENTS-LEGACY-TOOLS.md, CREATE-CASE.md when already present', async () => {
    const res = await GET(req('init.sh'), params('init.sh'));
    const script = await res.text();
    // Same skip-and-hint pattern used for .cursor/hooks.json.
    expect(script).toContain('if [ ! -f .arbitra/AGENTS.md ]; then');
    expect(script).toContain(
      '.arbitra/AGENTS.md already exists, skipping — fetch $ARBITRA_BASE/api/init/ARBITRA-AGENTS.md to refresh manually',
    );
    expect(script).toContain('if [ ! -f .arbitra/AGENTS-LEGACY-TOOLS.md ]; then');
    expect(script).toContain(
      '.arbitra/AGENTS-LEGACY-TOOLS.md already exists, skipping — fetch $ARBITRA_BASE/api/init/AGENTS-LEGACY-TOOLS.md to refresh manually',
    );
    expect(script).toContain('if [ ! -f .arbitra/CREATE-CASE.md ]; then');
    expect(script).toContain(
      '.arbitra/CREATE-CASE.md already exists, skipping — fetch $ARBITRA_BASE/api/init/CREATE-CASE.md to refresh manually',
    );
  });

  it('init.sh updates only project_id in an existing .arbitra/case-spec.json, preserving other fields', async () => {
    const res = await GET(req('init.sh'), params('init.sh'));
    const script = await res.text();
    expect(script).toContain('if [ ! -f .arbitra/case-spec.json ]; then');
    // In-place awk update, atomic tmpfile + mv (same pattern as .arbitra/.env).
    expect(script).toContain('awk -v pid="$PROJECT_ID"');
    expect(script).toMatch(/"project_id"\[\[:space:\]\]\*:/);
    expect(script).toContain(
      '.arbitra/case-spec.json > .arbitra/case-spec.json.tmp && mv .arbitra/case-spec.json.tmp .arbitra/case-spec.json',
    );
    expect(script).toContain('Updated .arbitra/case-spec.json');
  });

  it('init.sh case-spec.json first-run template is unchanged', async () => {
    const res = await GET(req('init.sh'), params('init.sh'));
    const script = await res.text();
    expect(script).toContain('"version": "1.0"');
    expect(script).toContain('"project_id": "$PROJECT_ID"');
    expect(script).toContain('"required_fields": ["title", "case_type", "validation_track", "risk_level", "priority"]');
    expect(script).toContain('"ticket_implementation": { "branch_patterns": ["^feat/", "^feature/"] }');
    expect(script).toContain('Created .arbitra/case-spec.json (project_id: $PROJECT_ID)');
  });

  it('setup_codex no longer prints a placeholder warning (Connect flow handles tokens)', async () => {
    // Pre-device-flow this script embedded a placeholder ARBITRA_TOKEN in
    // the TOML and warned users to replace it. With the Connect flow,
    // tokens live in the OS keychain and the TOML emits no token at all —
    // the warning has nothing left to guard against.
    const res = await GET(req('init.sh'), params('init.sh'));
    const script = await res.text();
    expect(script).not.toContain('TOKEN_FOR_MCP');
    expect(script).not.toContain('PLACEHOLDER_TOKEN');
    expect(script).not.toContain('replace ARBITRA_TOKEN in the TOML above');
  });
});

// Integration test for the sessionStart hook — shells out to the real script
// with a temp cwd, no git repo, no reachable server. Covers the fail-safe
// empty-context path now that there is no gate-status cache to invalidate.
describe('arbitra-context-inject.sh — resolves by branch, no local pointer file', () => {
  const repoRoot = new URL('../../../../../../..', import.meta.url).pathname;
  const hookPath = join(repoRoot, 'templates/cursor/hooks/arbitra-context-inject.sh');

  function runHook(cwd: string) {
    return spawnSync('bash', [hookPath], {
      cwd,
      input: '{}',
      encoding: 'utf8',
      timeout: 15000,
    });
  }

  function mkTempCwd(): string {
    const dir = mkdtempSync(join(tmpdir(), 'arbitra-hook-test-'));
    mkdirSync(join(dir, '.arbitra'), { recursive: true });
    return dir;
  }

  it('emits empty context (never poisons the session) when no credentials are configured', () => {
    const cwd = mkTempCwd();
    try {
      const result = runHook(cwd);
      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed).toHaveProperty('additional_context');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('does not read or write .arbitra/.active-case', () => {
    const hookSrc = readFileSync(hookPath, 'utf8');
    expect(hookSrc).not.toContain('.arbitra/.active-case');
    expect(hookSrc).not.toContain('.arbitra/.gate-status');
    expect(hookSrc).toContain('/api/cases/resolve');
  });
});
