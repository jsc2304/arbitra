/**
 * Arbitra MCP Server — REST API bridge for AI coding agents.
 * Exposes Arbitra case management, evidence, and knowledge tools via MCP protocol.
 * Started by `index.ts` when no subcommand is given.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadConfig } from "./config.js";
import { resolveCreds } from "./credentials.js";
import { ArbitraClient } from "./client.js";
import type { ToolArgs, ToolDefinition, ToolResult } from "./types.js";
import { SERVER_VERSION } from "./version.js";
import { setClientInfo } from "./actor-metadata.js";
import { withCredsRetry, type MutableCreds, type WithCredsContext } from "./mcp-creds.js";

import { tools as agentTools } from "./tools/agent-tools.js";
import { tools as caseTools } from "./tools/case-tools.js";
import { tools as evidenceTools } from "./tools/evidence-tools.js";
import { tools as searchTools } from "./tools/search-tools.js";
import { tools as ruleTools } from "./tools/rule-tools.js";
import { tools as projectTools } from "./tools/project-tools.js";
import { tools as knowledgeTools } from "./tools/knowledge-tools.js";
import { tools as authTools } from "./tools/auth-tools.js";
import { registerResources } from "./resources/case-resources.js";
import { registerDefaultsResource } from "./resources/defaults-resource.js";

const SERVER_INSTRUCTIONS = `Arbitra MCP server.

URL Sharing Protocol.
Every Arbitra tool response that includes a \`share_url\` field is the canonical link the user should open. Surface it as a markdown link (e.g. \`[Open case in Arbitra](<share_url>)\`) in:
- your summary message at the end of any work that mutated a case (after create_case, update_case, transition_case, progress_case, signal_build_complete, signal_exploration_complete, register_evidence, add_comment),
- any "terminal" message where you yield control back to the user (asking a question, presenting a result, awaiting input).

The URL is status-aware — Arbitra returns the most relevant deep-link for the case's current status (e.g. \`/cases/<id>/courtroom\` when awaiting a human decision, \`/cases/<id>\` otherwise). Always prefer the \`share_url\` from the most recent tool response over reconstructing one yourself.

Lifecycle.
Use \`progress_case\` as the single lifecycle verb. Read \`next_action\` from each lifecycle response to decide the next call. The deprecated \`signal_*\` and \`get_agent_instructions\` tools remain for backward compatibility only.

Defaults resource.
The \`arbitra://defaults\` resource exposes the default project id, project name, client name, and device label resolved from \`.arbitra/.env\` and the MCP handshake. It also surfaces \`base_url\` (the resolved Arbitra host this MCP is actually talking to) and a derived \`environment\` hint (local / custom) so a host mismatch is visible — a config pointed at the wrong host fails silently with 401/404. Read it once at the start of a session to learn the project default the user has pinned for this repo and to confirm you are talking to the expected host.

Project language.
Each project may define a default written language (\`default_language\`, 'en' or 'de') surfaced in \`arbitra://defaults\` and in \`get_case_context\` under \`project.default_language\`. Write all case comments, descriptions, and progress summaries in that language. If unset, default to English. This keeps a case's audit trail in one consistent language regardless of which language the user prompts in.`;

/** Starts the MCP server on stdio. Resolves once the transport is connected. */
export async function runServer(): Promise<void> {
  const cwd = process.cwd();
  // Initial creds load with a placeholder clientName — the real handshake
  // replaces this once the MCP `initialize` completes.
  const config = await loadConfig({ cwd, clientName: "arbitra-mcp-unknown" });

  const mutable: MutableCreds = {
    current: config.creds,
    baseUrl: config.creds.baseUrl,
    token: config.creds.ok ? config.creds.token : undefined,
  };

  const tokenProvider = (): string => {
    return mutable.token ?? "";
  };

  const client = new ArbitraClient(mutable.baseUrl, tokenProvider, config.requestTimeoutMs);

  const credsCtx: WithCredsContext = {
    creds: mutable,
    resolveOpts: { cwd, clientName: "arbitra-mcp-unknown" },
  };

  const server = new McpServer(
    {
      name: "arbitra",
      version: SERVER_VERSION,
    },
    {
      capabilities: {
        tools: { listChanged: true },
        resources: {},
      },
      instructions: SERVER_INSTRUCTIONS,
    }
  );

  // Register all tools. Each handler is wrapped in `withCredsRetry` so a
  // missing-token tool call triggers the device flow + auto-retry path.
  const toolFactories = [agentTools, caseTools, evidenceTools, searchTools, ruleTools, projectTools, knowledgeTools];
  const allTools: ToolDefinition[] = toolFactories.flatMap((factory) => factory(client));

  for (const tool of allTools) {
    const wrapped = withCredsRetry<ToolArgs, ToolResult>(
      credsCtx,
      tool.handler as (args: ToolArgs) => Promise<ToolResult>
    );
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      // The MCP SDK passes (args, extra); the wrapper only consumes args.
      (args) => wrapped(args as ToolArgs) as Promise<ToolResult>
    );
  }

  // Auth-lifecycle tools (e.g. `reconnect`) operate ON the creds context and
  // must run even when creds are missing/invalid, so they are registered
  // WITHOUT the withCredsRetry wrapper (which would otherwise intercept them
  // with a Connect prompt before the handler runs).
  for (const tool of authTools(credsCtx)) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      (args) => tool.handler(args as ToolArgs) as Promise<ToolResult>
    );
  }

  // Register resources.
  registerResources(server, client);
  registerDefaultsResource(server, () => mutable.current, () => mutable.baseUrl, client);

  // Capture MCP clientInfo from the `initialize` handshake. As soon as we
  // know the real client name, re-resolve creds keyed by it (the keychain
  // entry for `cursor` is distinct from `claude-code`).
  server.server.oninitialized = () => {
    const info = server.server.getClientVersion();
    setClientInfo(info);
    const realClientName = info?.name ?? "arbitra-mcp-unknown";
    credsCtx.resolveOpts = { cwd, clientName: realClientName, clientVersion: info?.version };
    resolveCreds(credsCtx.resolveOpts).then((fresh) => {
      credsCtx.creds.current = fresh;
      credsCtx.creds.baseUrl = fresh.baseUrl;
      credsCtx.creds.token = fresh.ok ? fresh.token : undefined;
      client.setBaseUrl(fresh.baseUrl);
    }).catch(() => {
      /* leave the initial-load state in place — handler-level retry covers it */
    });
  };

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

