# Self-hosting

Arbitra runs as one container image (a Next.js standalone server on port 8080) in front of a Firebase project (Firestore and Authentication). This guide describes what you need to provide, how to build and configure the image, and the scheduled jobs and webhooks that make the lifecycle work. For local development use the commands in the [README](../README.md) instead.

The reference setup is Cloud Run with Firebase Hosting in front (see [Example: Cloud Run and Firebase Hosting](#example-cloud-run-and-firebase-hosting)). Any host that runs a container and keeps the Node process alive works.

## Prerequisites

- A Firebase project (a Google Cloud project with Firebase enabled).
  - **Firestore** in Native mode. Pick the region once; it cannot be changed.
  - **Authentication** with the Google sign-in provider enabled. Add the domain you serve Arbitra from to the authorized domains of Authentication.
  - A web app registered in the project, for the three client values `apiKey`, `authDomain` and `projectId`.
- A container host with these properties:
  - Background work continues after an HTTP response is sent, so CPU must stay allocated between requests and the process must not be frozen.
  - Responses may stream for up to four minutes (the activity stream), so the request timeout must be at least that.
  - Outbound HTTPS to Anthropic, GitHub and Google APIs.
- Server credentials for Firestore. On Google Cloud, attach a service account to the service that has `roles/datastore.user` (and `roles/storage.objectAdmin` on the bucket if you use `GCS_BUCKET`). Elsewhere, set `GOOGLE_APPLICATION_CREDENTIALS` to the path of a service account key file and keep that file out of the image.
- An Anthropic API key for AI review, the Clerk assistant and the Helper bot.
- Optional: a GCS bucket for artifacts, a GitHub token and webhook secret, a Google Chat app.
- Locally: Docker and the Firebase CLI (`npm install -g firebase-tools`).

## Build the image

The `NEXT_PUBLIC_*` values are compiled into the browser bundle, so they are build arguments, not runtime variables.

```bash
docker build -t arbitra:latest \
  --build-arg NEXT_PUBLIC_FIREBASE_API_KEY=<web app apiKey> \
  --build-arg NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=<project-id>.firebaseapp.com \
  --build-arg NEXT_PUBLIC_FIREBASE_PROJECT_ID=<project-id> \
  --build-arg NEXT_PUBLIC_AUTH_HOSTED_DOMAIN=example.com \
  .
```

When you build on an ARM machine for an x86-64 host, add `--platform linux/amd64`.

| Build argument | Required | Purpose |
|----------------|----------|---------|
| `NEXT_PUBLIC_FIREBASE_API_KEY` | yes | Firebase web API key. It identifies the project to the browser SDK and is not a secret. |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | yes | Auth domain of the web app, usually `<project-id>.firebaseapp.com`. |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | yes | Firebase project id. |
| `NEXT_PUBLIC_AUTH_HOSTED_DOMAIN` | no | Pre-selects one Google Workspace domain in the sign-in popup. Pair it with the runtime `AUTH_HOSTED_DOMAIN`. |
| `NEXT_PUBLIC_ARBITRA_ENV` | no | Label (`prod` or `dev`) shown next to the logo. |

The image also contains `docs/` (read by the Helper bot) and `templates/` (served by `/api/init/*`). Push the image to a registry your host can pull from.

## Runtime configuration

Set these as environment variables on the service. Keep secrets in your platform's secret manager and inject them into the environment from there. Do not bake them into the image or commit them.

| Variable | Required | Purpose |
|----------|----------|---------|
| `GOOGLE_CLOUD_PROJECT` | yes | Firebase project id used by the Admin SDK. If unset, the server falls back to the emulator project `demo-arbitra` and rejects real ID tokens. |
| `ANTHROPIC_API_KEY` | yes (or OpenAI) | Key for AI review, Clerk and the Helper bot. Without a provider key the app runs but those features fail. |
| `ARBITRA_LLM_PROVIDER`, `OPENAI_API_KEY` | for OpenAI | Set `ARBITRA_LLM_PROVIDER=openai` and `OPENAI_API_KEY` to use OpenAI instead of Anthropic. |
| `ARBITRA_PUBLIC_BASE_URL` | yes | Public URL of the instance, for example `https://arbitra.example.com`. Used for device login links and MCP setup snippets. |
| `ARBITRA_URL` | yes | Same public URL. Used for links in notifications and commit statuses and as the default audience of Chat events. Set it to the same value as `ARBITRA_PUBLIC_BASE_URL`. |
| `ARBITRA_ADMIN_EMAILS` | recommended | Comma-separated emails that receive the admin role on sign-in (verified accounts only). Promote-only: removing an address does not demote, and while an address is listed a demotion in the UI is undone at that user's next sign-in. |
| `AUTH_HOSTED_DOMAIN` | recommended | Reject sign-ins from any other email domain. Unset means any Google account can sign in. |
| `ARBITRA_CRON_SECRET` | for scheduled jobs | Shared secret for the job endpoints (see [Scheduled jobs](#scheduled-jobs)). |
| `ARBITRA_ENCRYPTION_KEY` | for repository tokens | 32 random bytes, base64 (`openssl rand -base64 32`). Required to store per-repository GitHub tokens, which are encrypted at rest. Losing or rotating the key makes stored tokens unreadable. |
| `GITHUB_TOKEN` | no | Fallback GitHub token for diff fetching and the `arbitra/case` commit status. A per-repository token takes precedence. |
| `GITHUB_WEBHOOK_SECRET` | for GitHub webhooks | HMAC secret for `POST /api/webhooks/git`. |
| `CI_WEBHOOK_SECRET` | for CI webhooks | HMAC secret for `POST /api/webhooks/ci`. |
| `GCS_BUCKET` | no | Store artifacts in this bucket. Without it, files go to `.arbitra-storage/` on local disk (`ARBITRA_STORAGE_PATH` changes the directory). |
| `FIRESTORE_DATABASE_ID` | no | Use a named Firestore database instead of `(default)`. |
| `GOOGLE_APPLICATION_CREDENTIALS` | outside Google Cloud | Path to a service account key file. |
| `ARBITRA_LLM_MODEL`, `ARBITRA_LLM_MODEL_LOW` / `_MEDIUM` / `_HIGH` / `_CRITICAL` | no | Model overrides. Admins can also choose models under Settings; the stored setting wins over these variables. |
| `SCHEDULER_SA_EMAILS`, `SCHEDULER_OIDC_AUDIENCES` | no | Allow-lists for Google Cloud Scheduler OIDC authentication of the job endpoints. |
| `CHAT_PROJECT_NUMBER` | for the Chat app | Number of the Google Cloud project that hosts the Chat app. The expected sender identity is derived from it. Without it every Chat event is rejected. |
| `CHAT_EVENTS_AUDIENCE` | no | Expected audience of Chat event tokens. Default: `ARBITRA_URL` plus `/api/chat/events`. |
| `ARBITRA_CHAT_REPLIES_ENABLED` | no | Set to `false` to stop Clerk from posting replies into Chat threads. |
| `ARBITRA_PAUSED_SCHEDULERS` | no | Comma-separated job names (`run_sweeper`, `blueprint_tick`, `intelligence`) to show a "paused" banner for. Informational; it does not stop the jobs. |
| `FIREBASE_AUTH_EMULATOR_HOST`, `FIRESTORE_EMULATOR_HOST` | never in production | Point the server at local emulators. |

`.env.example` in the repository root lists the same variables with local-development values. Further optional tuning variables (`ARBITRA_RUN_*`, `ARBITRA_ASSISTANT_*`, `ARBITRA_MAX_RUN_RETRIES`, `ARBITRA_REVIEW_VERIFICATION`) have defaults and are defined next to the code that reads them.

## Firestore rules and indexes

The server accesses Firestore with the Admin SDK, which bypasses rules; `firestore.rules` denies all direct client access as a safety net. Deploy the rules and the composite indexes from the repository root:

```bash
firebase login
firebase deploy --only firestore:rules,firestore:indexes --project <project-id>
```

Index builds take a few minutes. A query that needs a missing index fails with an error that contains a link to create it, so deploy the indexes before the first real traffic. To use a named database, change `firestore.database` in `firebase.json` and set `FIRESTORE_DATABASE_ID` to the same value.

### Data retention

These collections store an `expires_at` ISO-8601 string and the code ignores expired documents: `device_codes` (10 minutes), `auth_rate_limits` (1 hour) and `assistant_intake_receipts` (30 days). Lock documents in `case_pipeline_locks`, `run_sweep_locks` and `intelligence_locks` also carry `expires_at`. The application does not delete expired documents. A Firestore TTL policy only deletes documents whose TTL field holds a Firestore timestamp, so a TTL policy on these string fields has no effect. The collections grow slowly: roughly one small document per device connection, per rate-limited client or user, per Clerk request, and per case that was ever evaluated. To prune them, delete expired documents with a periodic script.

## First run

1. Open the instance URL and sign in with an account listed in `ARBITRA_ADMIN_EMAILS`.
2. Create a project (Setup), register its repository, and invite members.
3. Under Settings, check the AI model selection and create tokens only for CI. IDE agents connect through the device flow described in [`../packages/mcp/README.md`](../packages/mcp/README.md).

## Scheduled jobs

Three endpoints do periodic work. Call each with `POST`. Without these calls the app works, but stale review runs are not recovered, scheduled Clerk tasks never fire, and no intelligence flags are produced.

| Endpoint | Frequency | Purpose |
|----------|-----------|---------|
| `/api/runs/sweep` | every 3 to 5 minutes | Fails runs whose lease expired, dispatches overdue retries, claims unclaimed Clerk runs. |
| `/api/blueprints/tick` | every 5 minutes | Creates a task for each scheduled Clerk blueprint that is due. |
| `/api/intelligence/run` | once a day | Runs the intelligence detectors. |

Authenticate with the shared secret:

```bash
curl -fsS -X POST https://arbitra.example.com/api/runs/sweep \
  -H "Authorization: Bearer $ARBITRA_CRON_SECRET"
```

Any scheduler can send this request (cron, a CI schedule, a hosted cron service, Cloud Scheduler). Alternatively, Google Cloud Scheduler can authenticate with an OIDC token: create the job with `--oidc-service-account-email` and `--oidc-token-audience` set to the full endpoint URL, then set `SCHEDULER_SA_EMAILS` (the job's service account) and `SCHEDULER_OIDC_AUDIENCES` (the endpoint URLs, comma-separated) on the service. With neither the secret nor the OIDC variables configured the endpoints answer 500; otherwise a wrong or missing credential returns 401. The sweep and the intelligence run take a Firestore lock, so overlapping calls do not run twice: the sweep answers 200 with `skipped_locked`, the intelligence run answers 409.

The blueprint tick looks back 15 minutes (a five-minute window plus a ten-minute margin) and skips older fire times. Overlapping ticks are safe because every occurrence has an idempotency key. Call it every 5 minutes; a cadence of 15 minutes or more can miss scheduled runs.

## Webhooks

### GitHub

For each repository registered in Arbitra, add a webhook in GitHub (Settings, Webhooks):

- Payload URL: `https://arbitra.example.com/api/webhooks/git`
- Content type: `application/json`
- Secret: the value of `GITHUB_WEBHOOK_SECRET` (one secret for all repositories)
- Events: Pull requests, Pushes and Repositories

Arbitra answers 401 if the signature is missing or wrong. GitHub cancels a delivery after 10 seconds and Arbitra processes the event before it responds, so a host that scales to zero can produce a failed first delivery; GitHub's delivery log allows a redelivery. A per-repository GitHub token (Project, Repository settings) or `GITHUB_TOKEN` is needed to fetch diffs and publish the `arbitra/case` commit status. To block merges, mark `arbitra/case` as a required status check in the branch protection rule.

### CI

Post build results to `POST /api/webhooks/ci` with an HMAC-SHA256 signature of the raw body in `X-Hub-Signature-256`, using `CI_WEBHOOK_SECRET`:

```bash
BODY='{"build_id":"123","status":"success","branch":"feature/x","report_url":"https://ci.example.com/123"}'
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$CI_WEBHOOK_SECRET" | sed 's/^.* //')"
curl -fsS -X POST https://arbitra.example.com/api/webhooks/ci \
  -H "Content-Type: application/json" -H "X-Hub-Signature-256: $SIG" -d "$BODY"
```

`status` must be `success` or `failure`. Send `case_id` or `pr_ref` so the result attaches to the right case; the result is registered as `ci_result` evidence.

### Google Chat (optional)

Project and per-user incoming webhooks need no server configuration. An interactive Chat app needs `CHAT_PROJECT_NUMBER` and an HTTP endpoint URL of `<ARBITRA_URL>/api/chat/events` (or a custom `CHAT_EVENTS_AUDIENCE` that equals the configured endpoint URL). Replies use Application Default Credentials of the runtime service account with the `chat.bot` scope.

## Example: Cloud Run and Firebase Hosting

```bash
PROJECT=<project-id>; REGION=europe-west1

gcloud artifacts repositories create arbitra --repository-format=docker --location=$REGION --project $PROJECT
gcloud auth configure-docker $REGION-docker.pkg.dev

docker tag arbitra:latest $REGION-docker.pkg.dev/$PROJECT/arbitra/arbitra:latest
docker push $REGION-docker.pkg.dev/$PROJECT/arbitra/arbitra:latest

gcloud run deploy arbitra \
  --project $PROJECT --region $REGION \
  --image $REGION-docker.pkg.dev/$PROJECT/arbitra/arbitra:latest \
  --service-account <runtime-sa>@$PROJECT.iam.gserviceaccount.com \
  --allow-unauthenticated \
  --no-cpu-throttling \
  --set-env-vars GOOGLE_CLOUD_PROJECT=$PROJECT,ARBITRA_PUBLIC_BASE_URL=https://arbitra.example.com,ARBITRA_URL=https://arbitra.example.com,AUTH_HOSTED_DOMAIN=example.com,ARBITRA_ADMIN_EMAILS=alex@example.com \
  --set-secrets ANTHROPIC_API_KEY=anthropic-api-key:latest,ARBITRA_CRON_SECRET=arbitra-cron-secret:latest,ARBITRA_ENCRYPTION_KEY=arbitra-encryption-key:latest,GITHUB_WEBHOOK_SECRET=github-webhook-secret:latest
```

- `--no-cpu-throttling` keeps CPU allocated after a response is sent. Review and assistant runs continue after the response, so without it Cloud Run throttles them.
- `--allow-unauthenticated` is required because the app authenticates callers itself and GitHub and schedulers must reach it.
- Create the secrets in Secret Manager first and grant the runtime service account `roles/secretmanager.secretAccessor`.
- With the default `--min-instances 0` the first request after an idle period pays a cold start.

Firebase Hosting can put your own domain and a CDN in front. `firebase.json` rewrites every path to the Cloud Run service `arbitra` in `europe-west1` and sets `no-cache` headers. Adjust `serviceId` and `region` if yours differ, then:

```bash
firebase deploy --only hosting --project $PROJECT
```

Use your public domain as `ARBITRA_PUBLIC_BASE_URL` and `ARBITRA_URL`, and add it to the authorized domains of Firebase Authentication.

To verify a deployment, call `GET /api/version` (no authentication). It returns the build version; `commit` and `deployed_at` echo the optional variables `BUILD_COMMIT_SHA` and `BUILD_DEPLOYED_AT` if you set them at deploy time.

## Security checklist

- Set `AUTH_HOSTED_DOMAIN` (and the build argument `NEXT_PUBLIC_AUTH_HOSTED_DOMAIN`). The runtime variable is the enforcement; the build argument only narrows the account picker. Access tokens are not re-checked against the domain, so revoke tokens issued before you enable it.
- Set `ARBITRA_ADMIN_EMAILS` deliberately and keep the list short. Admin grants user management, global rules and LLM settings.
- Keep `FIREBASE_AUTH_EMULATOR_HOST` and `FIRESTORE_EMULATOR_HOST` unset in production. With the Auth emulator variable set, the Firebase Admin SDK verifies ID tokens without checking their signature, so anyone could forge a login.
- Store `ARBITRA_ENCRYPTION_KEY`, `ARBITRA_CRON_SECRET`, `ANTHROPIC_API_KEY` and both webhook secrets in a secret manager, not in the image, the repository or plain environment files.
- Rotate webhook secrets and the cron secret by updating the secret and the sender together. Rotating `ARBITRA_ENCRYPTION_KEY` makes stored repository tokens unreadable; they must be entered again.
- Do not expose the Firestore emulator ports or the Emulator UI on a public host.
- Use a dedicated runtime service account with only the roles listed above.

## Costs

Firestore bills per document read. Two paths read continuously while users are active:

- Every open browser tab on the activity view holds a stream that polls Firestore every two seconds. An idle poll issues six queries that match nothing, roughly 10,000 billed reads per hour per tab (estimate from the code, not measured). Active polls read the new documents plus the cases and projects they reference.
- The sweeper and the blueprint tick run on a schedule and read a small number of documents each time.

Create a budget alert on the Google Cloud billing account and a Cloud Monitoring alert on `firestore.googleapis.com/document/read_count` for the project before opening the instance to a larger group. Anthropic usage grows with the number of reviews, Clerk tasks and Helper bot questions; monitor it in the Anthropic console.
