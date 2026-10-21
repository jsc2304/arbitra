/**
 * `arbitra://defaults` resource — surfaces the default project + device info
 * resolved from `.arbitra/.env` and the MCP handshake.
 *
 * Returned shape:
 *   {
 *     "default_project_id": "proj_xxx",         // omit when unset
 *     "default_project_name": "my-project",     // omit when project fetch fails
 *     "default_language": "en",                 // omit when project doesn't set one
 *     "client_name": "cursor",
 *     "device_label": "alex-macbook",
 *     "base_url": "https://arbitra.example.com",
 *     "environment": "custom"
 *   }
 *
 * `base_url` (the resolved host the MCP is actually talking to) and a derived
 * `environment` hint are surfaced so a wrong-host config — which fails silently
 * with 401/404 — is visible at a glance to an agent and to the user.
 * `environment` is a hint, not a security signal.
 *
 * The project name is fetched lazily via `GET /api/projects/{id}` and cached
 * for the process lifetime so repeated reads don't spam the backend.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ArbitraClient } from "../client.js";
import type { ResolvedCreds } from "../credentials.js";

type Environment = "local" | "custom";

interface DefaultsPayload {
  client_name: string;
  device_label: string;
  base_url: string;
  environment: Environment;
  default_project_id?: string;
  default_project_name?: string;
  default_language?: "en" | "de";
}

/**
 * Classify a resolved base URL into a coarse environment label: `local` for a
 * loopback host, `custom` for everything else. Heuristic only — a hint to
 * catch host mismatches, never a security boundary.
 */
export function classifyEnvironment(baseUrl: string): Environment {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return "custom";
  }
  // `URL.hostname` keeps the brackets of an IPv6 literal.
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") {
    return "local";
  }
  return "custom";
}

interface ProjectMeta {
  name?: string;
  default_language?: "en" | "de";
}

const projectMetaCache = new Map<string, ProjectMeta>();

async function fetchProjectMeta(
  client: ArbitraClient,
  projectId: string
): Promise<ProjectMeta> {
  const cached = projectMetaCache.get(projectId);
  if (cached) return cached;
  try {
    const data = await client.get<unknown>(`/api/projects/${projectId}`);
    if (data && typeof data === "object") {
      const obj = data as Record<string, unknown>;
      const name =
        typeof obj.name === "string" ? obj.name : typeof obj.project_name === "string" ? obj.project_name : undefined;
      const default_language =
        obj.default_language === "en" || obj.default_language === "de" ? obj.default_language : undefined;
      const meta: ProjectMeta = { name, default_language };
      if (name || default_language) {
        projectMetaCache.set(projectId, meta);
      }
      return meta;
    }
  } catch {
    /* swallow — the resource omits the field(s) when unknown */
  }
  return {};
}

export function registerDefaultsResource(
  server: McpServer,
  getCreds: () => ResolvedCreds,
  getBaseUrl: () => string,
  client?: ArbitraClient
): void {
  server.registerResource(
    "defaults",
    "arbitra://defaults",
    {
      description:
        "Default project pin + device/client identity for this MCP session. " +
        "Resolved from .arbitra/.env (project) and the MCP initialize handshake (client/device). " +
        "Also surfaces base_url (the resolved Arbitra host this MCP is talking to) and a derived " +
        "environment hint (local/custom) so a wrong-host config is visible. " +
        "When the project sets one, it also surfaces default_language ('en'/'de') — the language case " +
        "comments, descriptions, and summaries should be written in.",
      mimeType: "application/json",
    },
    async (uri) => {
      const creds = getCreds();
      const baseUrl = getBaseUrl();
      const payload: DefaultsPayload = {
        client_name: creds.clientName,
        device_label: creds.deviceLabel,
        base_url: baseUrl,
        environment: classifyEnvironment(baseUrl),
      };
      if (creds.ok && creds.projectId) {
        payload.default_project_id = creds.projectId;
        if (client) {
          const meta = await fetchProjectMeta(client, creds.projectId);
          if (meta.name) payload.default_project_name = meta.name;
          if (meta.default_language) payload.default_language = meta.default_language;
        }
      }
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(payload, null, 2),
          },
        ],
      };
    }
  );
}
