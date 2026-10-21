# AGENTS.md

Guidance for coding agents (and humans) working on this repository.

## What this is

Arbitra is a governance system for AI-assisted software work. It records work in repositories as cases, collects evidence, runs AI review, and gates merges by policy and risk. The domain language is defined in [`CONTEXT.md`](./CONTEXT.md); the governing decision is [ADR 0001](./docs/adr/0001-observe-by-default-enforce-by-policy.md) (observe by default, enforce by policy).

## Repository layout

| Path | Contents |
|---|---|
| `packages/shared` | Domain types, Zod validators, the case state machine, constants (`@arbitra/shared`) |
| `packages/backend` | Domain services, repositories, auth middleware, LLM provider, Firestore access (`@arbitra/backend`, consumed as built `dist/`) |
| `packages/frontend` | Next.js app: UI, every REST route under `src/app/api`, background work started from routes |
| `packages/mcp` | MCP server for IDE agents, published to npm as `arbitra-mcp`; Claude Code plugin in `packages/mcp/plugin` |
| `templates/` | Files the `/api/init` endpoint serves to repositories that connect to Arbitra |
| `scripts/` | Demo seed and admin scripts |
| `docs/` | Architecture, self-hosting, MCP setup, specs |

## Commands

Run from the repo root.

```bash
npm install
cp .env.example packages/frontend/.env.local
npm run emulators   # Firebase Auth/Firestore/Storage emulators in Docker (UI on :4000)
npm run seed        # demo data, sign in as "Alex Example"
npm run dev         # app on http://localhost:3000
npm run typecheck
npm run test        # builds first, then Vitest (shared, backend, frontend) and node --test (mcp)
npm run build
```

Single workspace: `npm --workspace packages/<name> run test`, or `cd packages/<name> && npx vitest run <path>`.

## Conventions

- TypeScript strict everywhere; 2-space indentation, semicolons, single quotes.
- Reuse types from `@arbitra/shared`; do not redefine shapes locally.
- Validator at the boundary: every API route that accepts external input parses the body with a Zod schema before calling a service.
- Tests are colocated (`*.test.ts`) and named after the subject. A test for a fix should fail when the fix is reverted.
- UI: use the primitives in `packages/frontend/src/components/ui` and `components/shared` (Button, Input, Card, Badge, Modal, EmptyState, …). The brand accent (orange) is the only interactive colour; indigo/`corp-*` are for status only. Use the surface and border tokens instead of hard-coded greys.
- Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`), small focused changes.

## Domain rules that code must keep

- Case lifecycle: `open → exploration → ready_for_build → in_build → in_validation → in_review → (approved | needs_human_decision | verification_pending) → pending_merge → done`, with `request_changes` loops back to `in_build`. Transitions have server-side preconditions.
- `case_events` is append-only (audit trail).
- Self-approval is prohibited by default; `allow_self_approval` per evidence-policy cell is the only opt-out. Four-eyes is mandatory for high/critical risk on the manual track.
- Knowledge assets become `canonical` only through human verification.
- Webhook events never reopen cases in `done` or `rejected`.
- Secrets stored by the app (per-repository GitHub tokens) are encrypted with `ARBITRA_ENCRYPTION_KEY` (`packages/backend/src/lib/secret-box.ts`).

## Docs

- [Architecture](./docs/architecture.md), [database schema](./docs/database-schema.md), [self-hosting](./docs/deployment.md)
- [User guide](./docs/onboarding-guide.md), [MCP server](./docs/mcp.md), [Claude Code](./docs/setup-claude-code.md), [Codex](./docs/setup-codex.md)
- Agent contract shipped to connected repositories: [`templates/arbitra/AGENTS.md`](./templates/arbitra/AGENTS.md)
