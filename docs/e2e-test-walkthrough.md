# Arbitra End-to-End Walkthrough

A hands-on run on your own machine: from empty Firebase emulators to cases that an IDE agent creates and drives through the lifecycle, with a human decision at the end. It takes 30 to 45 minutes and needs no Google account and no cloud project.

You will:

1. Start Arbitra against the emulators and sign in with seeded demo data.
2. Create a project, register a test repository and lower the lifecycle gates for a solo run.
3. Connect an IDE agent and see its session on Mission Control.
4. Watch an observed case appear without any manual step.
5. Drive an enforced case from `open` to `pending_merge`, with the agent doing the work.
6. Decide on a manual-track case in the Courtroom.
7. Read the audit trail, and try Clerk.

Concepts are explained in the [user guide](onboarding-guide.md); this page is the exercise.

---

## Phase 1: Prerequisites

| Tool | Check | Needed for |
|------|-------|------------|
| Node.js 20.19 or newer | `node -v` | Running Arbitra, `arbitra-mcp` |
| Docker | `docker compose version` | Firebase emulators |
| git | `git --version` | Test repository |
| An MCP-capable IDE agent | `claude --version` | The examples use Claude Code; Cursor and Codex work the same way |
| curl, jq | `jq --version` | API checks (optional) |

Optional, for a real AI review: an `ANTHROPIC_API_KEY`, plus a GitHub repository and a `GITHUB_TOKEN` so Arbitra can fetch the diff. Without them every step below still works; the AI review is skipped and the timeline says why.

**Checkpoint:** all check commands pass.

---

## Phase 2: Start Arbitra

```bash
git clone https://github.com/jsc2304/arbitra && cd arbitra
npm install
cp .env.example packages/frontend/.env.local
npm run emulators   # Auth, Firestore and Storage emulators in Docker; UI on http://localhost:4000
npm run seed        # demo data, including the sign-in account alex@example.com
npm run dev         # http://localhost:3000
```

To enable the AI review and Clerk, put `ANTHROPIC_API_KEY=<your key>` into `packages/frontend/.env.local` and restart `npm run dev`. The [user guide](onboarding-guide.md#quickstart) and the repository README describe these steps in more detail.

Open http://localhost:3000 and sign in with the seeded account "Alex Example" in the Auth emulator popup.

**Checkpoint:** you see Mission Control, and **Cases** lists demo cases.

| Problem | Fix |
|---------|-----|
| Port 3000 in use | `PORT=3001 npm run dev`; use that URL everywhere below |
| Blank page or broken styles | `rm -rf packages/frontend/.next` and restart `npm run dev` |
| Emulators do not start | `docker compose logs firebase`; ports 4000, 4400, 8080, 9099, 9199 must be free |
| `npm install` fails | `node -v` must be 20.19 or newer |

---

## Phase 3: Tour the demo data

- **Cases.** Switch between List, Board and Lifecycle layouts. Use the triage views (Needs Me, Blocked, All) and the filters. Press Cmd+K (Ctrl+K) for global search.
- **A case.** Open any case. The header shows status, risk, track and owner. The tabs are Proof (findings, evidence, decisions), Runs, Comments, Timeline and Related.
- **Courtroom.** Open a seeded case that is in `needs_human_decision` and choose Enter Courtroom: the finding list, the finding detail with confidence, the evidence and the decision form.
- **Observatory.** Stat cards, charts and the leaderboard.
- **Emulator UI.** http://localhost:4000 shows the Firestore documents behind everything you do.

**Checkpoint:** you have seen the board, a case, the Courtroom and the Observatory.

---

## Phase 4: Create a project and register a repository

Create the test repository first. The `origin` URL is what Arbitra matches against, so use the URL of a real GitHub repository if you want an AI review later; otherwise any well-formed URL works.

```bash
mkdir arbitra-e2e-test && cd arbitra-e2e-test
git init -b main
git remote add origin https://github.com/<your-username>/arbitra-e2e-test.git
echo "# E2E test repository" > README.md
git add README.md && git commit -m "Initial commit"
```

In Arbitra:

1. **Projects**, create a project: name `e2e-demo`, default track `direct`.
2. Open the project, **Repositories** tab, **Add Repository**: name `arbitra-e2e-test`, the URL of the `origin` remote, provider GitHub.
3. **Overview** tab, **Lifecycle**: set the preset to `autonomous`. The default `standard` preset asks a second person to confirm the start of the build, and a case owner cannot confirm their own gate, so a solo run would wait there.

**Checkpoint:** project `e2e-demo` exists with one repository and the `autonomous` preset.

---

## Phase 5: Connect the IDE agent

From the test repository:

```bash
npx -y arbitra-mcp login     # open the printed link, confirm tool, device and project (e2e-demo)
npx -y arbitra-mcp doctor    # credentials, reachability, projects, client configuration
```

Install the MCP server in your client, using one of:

```text
/plugin marketplace add jsc2304/arbitra          # Claude Code plugin: MCP server, session hooks, /status
/plugin install arbitra@arbitra
```

```bash
claude mcp add arbitra -- npx -y arbitra-mcp     # MCP server only, no session hooks
```

(Cursor and Codex configuration: [mcp.md](mcp.md#setup).) No `ARBITRA_URL` is needed for a local instance; `login` wrote `.arbitra/.env`. Restart the client, start a session in `arbitra-e2e-test`, and ask:

> list arbitra projects

**Checkpoint:** the agent lists `e2e-demo`. With the plugin installed, **Mission Control** shows your session with agent, repository and branch. The hook reports only from a workspace that has an `.arbitra/` directory, which `login` created.

---

## Phase 6: An observed case appears

This phase needs the plugin's session hooks.

```bash
git checkout -b feat/observed-demo
echo "console.log('observed');" > observed.js
git add observed.js && git commit -m "feat: observed demo"
```

Start (or continue) a Claude Code session on this branch and let the agent run any tool, for example "show git status". Open **Cases**: a case for `feat/observed-demo` exists in status `in_build`, created by the system, with no one asking for it. This is an observed case: Arbitra records the work and blocks nothing. Sessions on `main` never create one.

**Checkpoint:** an observed case is bound to `feat/observed-demo`.

---

## Phase 7: Drive an enforced case

Create the case in the web app first, so that it owns its branch before any session signal arrives:

1. **Cases**, New Case: title `Add greeting function`, project `e2e-demo`, repository `arbitra-e2e-test`, track `direct`, risk `low`, priority `normal`, working branch `feat/add-greeting`.
2. Back in the repository: `git checkout main && git checkout -b feat/add-greeting`.
3. Ask the agent, with the case id from the case page:

> Drive Arbitra case `<case id>` through its lifecycle. Add a `greet(name)` function to `index.js` with a test, run the test, commit, and report the result as evidence.

The agent works the loop `get_case_context`, then `progress_case`:

| Case status | What the agent does | What happens next |
|-------------|--------------------|-------------------|
| `open` | `progress_case` with an exploration summary | Advances to `ready_for_build`, and on the `autonomous` preset straight on to `in_build` |
| `in_build` | Implements the change on `feat/add-greeting`, runs the test, then `progress_case` with summary, branch and evidence | Validation runs |
| `in_validation` | Nothing | Rules and evidence are checked, then the case moves to `in_review` |
| `in_review` | Nothing | See the note below |
| `approved`, `pending_merge` | Nothing | The case waits for the pull request to merge |

Low risk on the direct track needs `ci_result` as evidence, so the agent registers its local test run as a `ci_result` item (and as `unit_test_result`), for example `{ "type": "ci_result", "summary": "node --test passes locally" }`.

**AI review.** The server fetches the diff from GitHub for the case's pull request or branch.

- Without GitHub access (your default here), Arbitra tries three times, posts a system comment naming the reason, marks the review not applicable and continues. This takes several seconds.
- With a real GitHub repository, a `GITHUB_TOKEN` and an `ANTHROPIC_API_KEY`: push the branch, open a pull request, and pass its URL to `progress_case` as `pr_url`. The review runs on the real diff; findings appear on the Proof tab.

**Completing the case.** From `pending_merge`, merge the pull request (the webhook completes the case), or open the case and choose **Mark as Merged** in the header. Local runs have no webhook, so use the button.

Verify through the API (the token is the one `login` stored; it authenticates as Alex):

```bash
export ARBITRA_URL=http://localhost:3000
export TOKEN=$(npx -y arbitra-mcp token)
CASE_ID=<case id>
curl -s "$ARBITRA_URL/api/cases/$CASE_ID" -H "Authorization: Bearer $TOKEN" \
  | jq '{status, risk_level, validation_track, current_branch}'
```

What to check at each stage:

| Status | Check |
|--------|-------|
| `open` | Metadata is correct; Mission Control shows the agent working on the case |
| `exploration`, `ready_for_build` | The exploration summary is a comment or run on the Timeline |
| `in_build` | Branch set on the case; the lifecycle tracker marks the step |
| `in_validation`, `in_review` | Runs tab shows rule and review runs; Proof tab shows evidence as provided |
| `approved` | Decisions list an `auto_approve` entry from the system |
| `pending_merge`, `done` | After Mark as Merged the case is `done` |

**Checkpoint:** the case reached `done`, and the Timeline shows the system's automatic transitions next to the agent's actions.

---

## Phase 8: Decide in the Courtroom

A manual-track case waits for a person after review, which makes the Courtroom reachable with one account.

1. **Cases**, New Case: title `Verify greeting in the shell`, track `manual`, risk `medium`, working branch `feat/manual-demo`. Check out that branch in the repository.
2. Ask the agent to drive the case as in Phase 7. Manual-track medium risk requires `ci_result`, `unit_test_result` and `manual_confirmation` as evidence. Run the function by hand, tell the agent what you saw, and it registers all three, the last one with your observation as its summary.
3. The case reaches `verification_pending` and shows up under **Needs Me**.
4. Open the case, choose **Enter Courtroom**, review the evidence and choose **Approve** with a rationale. On the manual track, approving also records the manual validation confirmation.
5. The case moves to `approved`, then `pending_merge`.

For a high or critical risk case on the direct track the flow is the same, but the case always stops in `needs_human_decision`, the default policy requires two approvers, and the case owner cannot approve it. That needs two more accounts: sign in with extra accounts through the Auth emulator popup, give them the `reviewer` role under Settings, Users, and add them to the project's reviewer pool (Overview tab).

An agent can also act as the reviewer with `create_decision`. Ask: "Request changes on case `<case id>` because the greeting has no test", and the case returns to `in_build` with the rationale in the audit trail.

**Checkpoint:** you made a human decision in the Courtroom and saw it on the Decisions list.

---

## Phase 9: Audit trail and Clerk

- Open a finished case, the **Timeline** tab and **View Dossier**: every status change, run, evidence item, decision and comment, with actor and time. Agent entries carry the client name and the model signature the agent added.
- **Settings**, **Connections** lists the device you connected, with last-used time.
- **Clerk** (needs `ANTHROPIC_API_KEY`): ask "Which cases exist in project e2e-demo, and what status is each in?". Clerk reads through read-only tools and answers in a case of its own, with the request, the reads it made and the answer.
- **Helper** (bottom right, same key): ask "What does verification_pending mean?"

---

## Phase 10: Clean up

```bash
# in arbitra-e2e-test
npx -y arbitra-mcp logout        # remove local credentials
claude mcp remove arbitra        # only if you registered the server manually

# in the arbitra checkout
# Ctrl+C in the npm run dev terminal
docker compose down              # stop the emulators, keep the data
docker compose down -v           # or stop and delete all emulator data
```

Delete the `arbitra-e2e-test` directory and, if you created one, the GitHub repository. Tokens are revoked under Settings, Connections.

---

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| Agent gets 404 or 401 | Wrong host or token | `npx -y arbitra-mcp doctor`; read `arbitra://defaults`; fix `ARBITRA_URL`, restart the MCP server |
| No Connect link appears | A token already exists | `npx -y arbitra-mcp logout`, then call a tool again |
| Session not on Mission Control | No plugin, or no `.arbitra/` directory in the repository | Install the plugin; run `arbitra-mcp login` in the repository |
| No observed case appears | Repository not registered, URL mismatch, or the branch is the default branch | Compare the project's repository URL with `git remote get-url origin`; use a feature branch |
| `BRANCH_CONFLICT` on build | Another open case owns the branch (for example an observed case) | One case per branch: use a fresh branch for the case, or finish the other case |
| Case waits at `ready_for_build` | `standard` preset: a gate needs a second person | Set the project to `autonomous`, or have a reviewer confirm the gate |
| `400 Preconditions not met` | Missing evidence or findings | `get_case_context` shows each transition's blocker |
| No AI findings | No API key, or the diff could not be fetched | Set `ANTHROPIC_API_KEY`; set `GITHUB_TOKEN` and use a real repository and pull request |
| Case stuck, no auto-transition | A precondition is unmet | Read the Timeline and the banner on the case |

---

## Reference

### API endpoints used

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `POST` | `/api/cases` | Create a case |
| `POST` | `/api/cases/detect` | Detect case fields from a git context |
| `GET` | `/api/cases/resolve?repository_id=...&branch=...` | Case bound to a branch |
| `POST` | `/api/cases/<id>/transition` | Move a case to a target status |
| `POST` | `/api/cases/<id>/decisions` | File a decision |
| `GET` | `/api/cases/<id>/runs` | Runs of a case |
| `POST` | `/api/runs` | Create and execute a run (review runs resolve the diff on the server) |
| `GET` | `/api/cases`, `/api/projects` | List cases and projects |

All routes need `Authorization: Bearer <token>`; `npx -y arbitra-mcp token` prints one.

### Enum values

| Field | Values |
|-------|--------|
| `case_type` (creatable) | `ticket_implementation`, `bugfix`, `refactoring`, `security_review`, `pr_review`, `manual_verification`, `other` |
| `risk_level` | `low`, `medium`, `high`, `critical` |
| `priority` | `low`, `normal`, `high`, `urgent` |
| `validation_track` | `direct`, `manual` |
| `source_type` | `jira`, `manual`, `git`, `google_chat`, `other` |
