# Security

Arbitra is published as a reference implementation without a maintenance commitment. There is no security support, no patch schedule and no advisory process.

## Reporting a vulnerability

Report it privately through GitHub's [private vulnerability reporting](https://github.com/jsc2304/arbitra/security/advisories/new) for this repository. Please do not open a public issue for it. Reports are read, but a fix is not guaranteed.

## Running your own instance

You are responsible for the security of any instance you deploy. Before exposing one to other people, work through the security checklist in [docs/deployment.md](docs/deployment.md#security-checklist). In particular:

- Restrict sign-in with `AUTH_HOSTED_DOMAIN`. When it is unset, any Google account can sign in.
- Never set `FIREBASE_AUTH_EMULATOR_HOST` on a deployed instance.
- Store `ARBITRA_ENCRYPTION_KEY`, `ARBITRA_CRON_SECRET`, the webhook secrets and LLM keys in a secret manager, not in the image or the repository.

Known limitations are listed in the [README](README.md#known-limitations).
