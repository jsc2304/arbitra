/**
 * Manifest validation for the Claude Code plugin that ships next to the npm
 * package.
 *
 * Layout in the monorepo checkout:
 *
 *   .claude-plugin/marketplace.json                 (repo root — the marketplace)
 *   packages/mcp/plugin/.claude-plugin/plugin.json  (the plugin)
 *   packages/mcp/plugin/hooks/hooks.json
 *   packages/mcp/plugin/commands/*.md
 *
 * The plugin carries no code of its own: it launches the published npm
 * package (`npx -y arbitra-mcp@^<major>`) for the MCP server and for the
 * session-signal hooks (`arbitra-mcp hook <event>`). These tests do not launch
 * Claude Code or install anything into a user's `~/.claude` — they assert the
 * JSON is well-formed, that the version range tracks this package's major
 * version, and that the files a manifest references exist.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// dist/plugin-manifest.test.js -> package root is one level up from dist/.
const PACKAGE_ROOT = join(__dirname, "..");
const PLUGIN_ROOT = join(PACKAGE_ROOT, "plugin");
const REPO_ROOT = join(PACKAGE_ROOT, "..", "..");

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf-8"));
}

const pkg = readJson(join(PACKAGE_ROOT, "package.json")) as {
  name: string;
  version: string;
  license: string;
  files: string[];
  bin: Record<string, string>;
  engines: { node: string };
  repository: { type: string; url: string; directory: string };
};
const MAJOR = pkg.version.split(".")[0];
/** The npx spec every plugin entry must use. */
const NPX_SPEC = `${pkg.name}@^${MAJOR}`;

// ---------------------------------------------------------------------------
// package.json
// ---------------------------------------------------------------------------

test("package.json carries the publish metadata for npm", () => {
  assert.equal(pkg.name, "arbitra-mcp");
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.license, "Apache-2.0");
  assert.equal(pkg.engines.node, ">=20");
  assert.equal(pkg.repository.type, "git");
  assert.equal(pkg.repository.url, "git+https://github.com/jsc2304/arbitra.git");
  assert.equal(pkg.repository.directory, "packages/mcp");
  assert.equal(pkg.bin["arbitra-mcp"], "./dist/index.js");
});

test("package.json `files` ships dist (without tests) and the README — and not the plugin directory", () => {
  assert.ok(pkg.files.includes("dist"));
  assert.ok(pkg.files.includes("README.md"));
  assert.ok(pkg.files.some((f) => f.startsWith("!dist/") && f.includes(".test.")));
  assert.ok(!pkg.files.some((f) => f.startsWith("plugin")), "the plugin is installed from git, not from npm");
});

// ---------------------------------------------------------------------------
// plugin.json
// ---------------------------------------------------------------------------

test("plugin.json is well-formed JSON with the required manifest fields", () => {
  const manifest = readJson(join(PLUGIN_ROOT, ".claude-plugin", "plugin.json")) as Record<string, unknown>;
  assert.equal(typeof manifest.name, "string");
  assert.ok((manifest.name as string).length > 0);
  assert.equal(typeof manifest.version, "string");
  assert.match(manifest.version as string, /^\d+\.\d+\.\d+$/);
  assert.equal(typeof manifest.description, "string");
  assert.ok((manifest.description as string).length > 0);
  assert.equal(typeof manifest.author, "object");
});

test("plugin.json launches the published npm package for the MCP server and forwards ARBITRA_URL", () => {
  const manifest = readJson(join(PLUGIN_ROOT, ".claude-plugin", "plugin.json")) as {
    mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
  };
  const server = manifest.mcpServers?.arbitra;
  assert.ok(server, "expected an `arbitra` entry under mcpServers");
  assert.equal(server!.command, "npx");
  // Bumping this package to a new major version without updating the plugin
  // breaks this assertion on purpose — the plugin must follow the major.
  assert.deepEqual(server!.args, ["-y", NPX_SPEC]);
  // `${VAR:-default}` is Claude Code's env expansion; an empty default keeps a
  // missing ARBITRA_URL from expanding to the literal "${ARBITRA_URL}" text
  // (the MCP server treats an empty value as unset).
  assert.deepEqual(server!.env, { ARBITRA_URL: "${ARBITRA_URL:-}" });
});

// ---------------------------------------------------------------------------
// marketplace.json (repo root)
// ---------------------------------------------------------------------------

test("marketplace.json is well-formed and its plugin source resolves to the plugin directory", () => {
  const marketplace = readJson(join(REPO_ROOT, ".claude-plugin", "marketplace.json")) as {
    name: string;
    owner: { name: string };
    plugins: Array<{ name: string; source: string }>;
  };
  assert.equal(typeof marketplace.name, "string");
  assert.ok(marketplace.name.length > 0);
  assert.equal(marketplace.owner?.name, "jsc2304");
  assert.ok(Array.isArray(marketplace.plugins) && marketplace.plugins.length >= 1);

  for (const entry of marketplace.plugins) {
    assert.equal(typeof entry.name, "string");
    assert.ok(entry.name.length > 0);
    assert.ok(entry.source.startsWith("./"), `source "${entry.source}" must be relative to the marketplace root`);
    assert.equal(entry.source, "./packages/mcp/plugin");
    const resolved = join(REPO_ROOT, entry.source);
    assert.ok(
      existsSync(join(resolved, ".claude-plugin", "plugin.json")),
      `marketplace plugin "${entry.name}" source "${entry.source}" has no .claude-plugin/plugin.json`,
    );
  }
});

test("marketplace.json's listed plugin name matches plugin.json's own name", () => {
  const marketplace = readJson(join(REPO_ROOT, ".claude-plugin", "marketplace.json")) as {
    plugins: Array<{ name: string; source: string }>;
  };
  const manifest = readJson(join(PLUGIN_ROOT, ".claude-plugin", "plugin.json")) as { name: string };
  const names = marketplace.plugins.map((p) => p.name);
  assert.ok(
    names.includes(manifest.name),
    `plugin.json name "${manifest.name}" is not listed in marketplace.json (found: ${names.join(", ")})`,
  );
});

// ---------------------------------------------------------------------------
// hooks/hooks.json
// ---------------------------------------------------------------------------

const HOOK_EVENTS = ["SessionStart", "PostToolUse", "SessionEnd"] as const;
const HOOK_EVENT_TYPES: Record<(typeof HOOK_EVENTS)[number], string> = {
  SessionStart: "session_start",
  PostToolUse: "heartbeat",
  SessionEnd: "session_end",
};

interface HooksFile {
  hooks: Record<string, Array<{ hooks: Array<{ type: string; command: string; timeout?: number; async?: boolean }> }>>;
}

test("hooks.json wires SessionStart, PostToolUse, and SessionEnd to `arbitra-mcp hook <event>` via npx", () => {
  const hooks = readJson(join(PLUGIN_ROOT, "hooks", "hooks.json")) as HooksFile;

  for (const event of HOOK_EVENTS) {
    const entries = hooks.hooks[event];
    assert.ok(entries && entries.length >= 1, `hooks.json is missing a ${event} entry`);
    const commandHooks = entries.flatMap((e) => e.hooks);
    assert.ok(commandHooks.length >= 1, `hooks.json's ${event} entry has no command hooks`);

    for (const hook of commandHooks) {
      assert.equal(hook.type, "command");
      assert.equal(hook.command, `npx -y ${NPX_SPEC} hook ${HOOK_EVENT_TYPES[event]}`);
    }
  }
});

test("hooks.json never blocks the agent: SessionStart and PostToolUse are async, SessionEnd has a bounded timeout", () => {
  const hooks = readJson(join(PLUGIN_ROOT, "hooks", "hooks.json")) as HooksFile;
  const only = (event: string) => hooks.hooks[event]!.flatMap((e) => e.hooks);

  for (const hook of [...only("SessionStart"), ...only("PostToolUse")]) {
    assert.equal(hook.async, true);
  }
  // SessionEnd shares a short default budget in Claude Code; npx start-up needs more.
  for (const hook of only("SessionEnd")) {
    assert.ok(typeof hook.timeout === "number" && hook.timeout >= 5 && hook.timeout <= 30);
  }
});

// ---------------------------------------------------------------------------
// commands/*.md
// ---------------------------------------------------------------------------

test("every file under plugin/commands/ is a Markdown file with a description in its frontmatter", () => {
  const dir = join(PLUGIN_ROOT, "commands");
  assert.ok(existsSync(dir), "expected a plugin/commands/ directory");
  const files = readdirSync(dir).filter((f) => statSync(join(dir, f)).isFile());
  assert.ok(files.length >= 1, "plugin/commands/ has no command files");

  for (const file of files) {
    assert.match(file, /\.md$/, `commands/${file} is not a .md file`);
    const content = readFileSync(join(dir, file), "utf-8");
    assert.match(content, /^---\ndescription:\s*.+\n---/, `commands/${file} is missing a description frontmatter block`);
  }
});

// ---------------------------------------------------------------------------
// the plugin runs the published package, nothing is bundled into it
// ---------------------------------------------------------------------------

test("the plugin references no bundled runtime and no plugin-root path", () => {
  const raw =
    readFileSync(join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf-8") +
    readFileSync(join(PLUGIN_ROOT, "hooks", "hooks.json"), "utf-8");
  assert.ok(!raw.includes("plugin-dist"));
  assert.ok(!raw.includes("CLAUDE_PLUGIN_ROOT"));
});

// ---------------------------------------------------------------------------
// claude plugin validate (CLI-level check, when the CLI is available)
// ---------------------------------------------------------------------------

for (const [label, target] of [
  ["the marketplace at the repo root", REPO_ROOT],
  ["the plugin directory", PLUGIN_ROOT],
] as const) {
  test(`\`claude plugin validate\` accepts ${label}`, (t) => {
    const probe = spawnSync("claude", ["--version"], { encoding: "utf-8" });
    if (probe.status !== 0) {
      t.skip("claude CLI not available in this environment");
      return;
    }
    const result = spawnSync("claude", ["plugin", "validate", "."], {
      cwd: target,
      encoding: "utf-8",
      timeout: 60_000,
    });
    assert.equal(result.status, 0, `claude plugin validate failed:\n${result.stdout}\n${result.stderr}`);
  });
}
