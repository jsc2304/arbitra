# Changelog

## 2026.10.0 — 2026-10-21

First public release. To try it, follow the [Quick start](README.md#quick-start); to run it for a team, follow [Running your own instance](README.md#running-your-own-instance).

### Included

- Cases with an observed and an enforced lifecycle, evidence policies per risk level, rules, AI review with verified findings, decisions with four-eyes approval, and an append-only audit trail.
- Mission Control, Activity, Courtroom, Dossier, Review session, Projects with a setup wizard, Knowledge, Observatory and Intelligence detectors.
- Clerk (Ask, Context, Scheduled tasks, optional Google Chat) and the Helper bot.
- `arbitra-mcp` 4.0.0, the MCP server for IDE agents, and a Claude Code plugin with a session hook.
- Local development with Firebase emulators in Docker and a demo data set (`npm run seed`).

### Changes made for the public release

- Next.js 16 and React 19.
- Per-repository GitHub tokens are stored encrypted (`ARBITRA_ENCRYPTION_KEY`).
- The job endpoints accept a shared secret (`ARBITRA_CRON_SECRET`) in addition to Google Cloud Scheduler OIDC.
- First admins come from `ARBITRA_ADMIN_EMAILS`; the emulator sign-in shortcut never applies to production builds.
- Long-lived access tokens are no longer accepted in query strings; the Helper is limited to 30 questions per user and hour.
- The MCP server has no built-in instance URL and is installed from npm.
- OpenAI is enabled as a second LLM provider (tested with `gpt-6.1-sol` and `gpt-5-mini`); structured outputs run in non-strict JSON schema mode.
- The AI review and the finding verifier resolve `owner/repo` from the repository URL, so branch-only cases (no pull request) get a diff and file contents.
- A pipeline evaluation that loses the per-case lock retries briefly instead of dropping the change, so cases no longer stall without the run sweeper.
- Removed: a time-tracking connector and its credential vault, and an automated documentation agent.
