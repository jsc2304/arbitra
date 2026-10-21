# Arbitra Helper

The **Arbitra Helper** is an in-app assistant that answers questions about the Arbitra platform itself: setup, concepts, configuration, lifecycle, MCP and IDE integration, rules, evidence policies, and how-to questions. It lives in a floating launcher in the bottom-right corner of every authenticated page.

It is **not** case-aware and does **not** read your codebase. For questions about a specific case, finding, diff, or anything that needs the working tree, the Helper redirects you to your IDE agent (Claude Code, Cursor, Codex), where the MCP server and your local files are available.

---

## What it knows

The Helper grounds every answer in two sources, which together form its system prompt:

1. **A fixed list of `docs/` files.** `DOCS_ALLOWLIST` in `packages/backend/src/services/helper-bot/corpus-loader.ts` names the exact Markdown files the Helper may cite. Only those files are read, concatenated in sorted order, and prefixed with their path so the model can cite it. Other files under `docs/` (specs, architecture decision records, the database schema, the deployment guide, drafts) are not loaded, even though they are in the image.
2. **All `knowledge_assets` in Firestore.** The title and body of every knowledge asset, regardless of project or scope. The bot is intentionally global, so platform-level questions surface precedents and patterns from anywhere in the workspace.

If an answer is in neither source, the Helper is instructed to say so and not to guess.

---

## When to use it and when to use the IDE agent

| Use the Helper for | Use your IDE agent for |
|---|---|
| "How do I configure an evidence policy?" | "What findings does case X have?" |
| "What does `needs_human_decision` mean?" | "Why is my case stuck in `in_validation`?" |
| "How do I add a per-repository GitHub token?" | "Read the diff on this branch and explain it." |
| "Which MCP tool creates a knowledge asset?" | "Run the build and register the result as evidence." |
| "What is the four-eyes principle?" | "Look at this file and write a fix for finding F." |

Rule of thumb: platform knowledge goes to the Helper; the working tree, code, or a specific case goes to the IDE agent.

---

## How it works

- **Entry point:** a floating circular launcher at the bottom right. Click it to open the drawer.
- **UI:** a side drawer with a multi-turn chat. Pulsing dots indicate that the answer is being generated.
- **History:** kept in `sessionStorage`, so the conversation survives navigation within the session and is dropped when the tab closes. The server uses at most the most recent 10 turns.
- **Model:** the shared LLM provider resolves the model for risk level `low`, the cheapest tier. The result depends on the workspace LLM settings, the model environment variables, and the built-in default (Claude Haiku with the Anthropic provider). Answers are not streamed.
- **Endpoint:** `POST /api/helper/ask`
  - Body: `{ question: string, history?: Array<{ role: 'user' | 'assistant', content: string }> }`
  - Response: `{ answer, latency_ms, prompt_tokens, completion_tokens }`
  - Auth: any signed-in user.
- **Logging:** each turn is recorded in the `helper_bot_logs` collection (one document per user turn) for observability and abuse review. Only the question and a 500-character preview of the answer are stored. A failed log write never fails the response.

---

## Adding knowledge

There are two ways to expand what the Helper knows.

### 1. Add or update a file on the allowlist

Editing an allowlisted file is enough; it becomes part of the system prompt the next time the process starts. A new file also needs its path in `DOCS_ALLOWLIST`; a Markdown file under `docs/` that is not on the list is invisible to the Helper. The corpus is loaded once per process start and cached for the life of the process, so a running instance does not pick up changes until it is restarted or redeployed. There is no refresh button.

Practical consequences:

- Concise, well-structured documents help. Every allowlisted file ships in every prompt.
- Do not put secrets, personal data or scratch notes in an allowlisted file.
- Use clear headings; the model cites `docs/<file>.md` paths in answers.
- A file that describes planned work does not belong on the allowlist. The Helper cannot tell a plan from a shipped feature and will state the plan as fact.

### 2. Create a knowledge asset

Knowledge assets are editable in the UI (Knowledge and Rules, Knowledge Assets) and through the MCP tool `create_knowledge_asset`. The bot caches them for 60 seconds per process, so additions show up within about a minute.

Use knowledge assets for content that is project- or team-specific, such as decisions, patterns, anti-patterns and exception policies that came out of real cases. Use `docs/` files for stable, platform-level documentation that should be version-controlled and reviewed.

---

## Corpus refresh

| Source | Refreshed | Cache lifetime |
|---|---|---|
| Allowlisted files under `docs/` | When the process starts | Life of the process |
| `knowledge_assets` (Firestore) | On the first read after the cache expires | 60 seconds |

To make documentation changes visible immediately, restart or redeploy the service. `ARBITRA_DOCS_ROOT` overrides the directory the docs are read from.

---

## Limits

- **Question length:** 2,000 characters.
- **Rate:** 30 questions per user per hour.
- **History:** the most recent 10 turns; older turns are dropped. Each turn is capped at 4,000 characters.
- **Streaming:** not supported.
- **Case context:** none. The Helper cannot read cases, findings, evidence, comments or repository contents.
- **Scope:** knowledge assets are loaded globally with no project filter. Do not store confidential content in knowledge assets if one instance serves several organizations.

---

## Troubleshooting

**The Helper answers about features that do not exist, or does not know a feature that was just added.**
The docs corpus is captured at process start. Restart or redeploy the service. Knowledge assets refresh within 60 seconds.

**The Helper says it cannot answer my question.**
It declines to answer when the answer is not in its context. Update a document that is on the allowlist, add a new file and list it, or add a knowledge asset, then restart.

**The Helper sent me to my IDE agent for a question I think it should answer.**
That redirect fires for case-specific or code-specific questions. Ask about the platform ("how does Arbitra handle X") instead of about your case ("why is case-123 stuck").

**I want to turn the Helper off.**
The launcher is shown to all signed-in users. There is no per-user or per-workspace switch.
