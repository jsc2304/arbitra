/**
 * Composes the constant `system` message for the Arbitra Helper bot.
 *
 * The same string is sent on every request so Gemini's implicit prompt
 * cache can re-use it. Order matters: instructions first (small), then
 * docs corpus (large, deterministic), then knowledge assets (medium,
 * 60s-cached). Anything that changes per-request goes into the user
 * `prompt`, not here.
 */
import { loadDocsCorpus } from './corpus-loader.js';
import { loadKnowledgeAssets } from './knowledge-loader.js';

const INSTRUCTIONS = `You are Arbitra Helper, an assistant for users of the Arbitra platform. You help with Arbitra setup, concepts, configuration, MCP/IDE integration, lifecycle, rules, and how-to questions.

For questions about a specific case, finding, code, or anything that requires looking at the user's working tree, point the user to their IDE agent (Claude Code / Cursor / Codex). Those agents have the working tree and the MCP server connected.

Answer based ONLY on the documentation and knowledge assets provided below. If the answer is not in the provided context, say so honestly — do not fabricate.`;

export async function assembleSystemPrompt(): Promise<string> {
  const [docs, knowledge] = await Promise.all([
    loadDocsCorpus(),
    loadKnowledgeAssets(),
  ]);

  return `${INSTRUCTIONS}\n\n--- DOCUMENTATION ---\n${docs}\n\n--- KNOWLEDGE ASSETS ---\n${knowledge}`;
}
