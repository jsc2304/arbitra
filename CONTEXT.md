# Arbitra

Governance and live visibility for AI-assisted software work: Arbitra observes what developers and their agents are doing across repositories, records it as cases, and applies review policy in proportion to risk.

## Language

### Case model

**Case**:
The record of one line of work in one repository, tied to exactly one branch. Every case is either observed or enforced.
_Avoid_: ticket, task, job

**Observed Case**:
A case Arbitra created automatically from work it noticed (an agent session starting, a PR appearing). It records what happens without blocking anything and runs a shortened lifecycle.
_Avoid_: shadow case, passive case, tracked case

**Enforced Case**:
A case that policy has escalated into the full governed lifecycle: evidence requirements, review, and approval gates now block the merge.
_Avoid_: gated case, full case

**Escalation**:
The policy-driven switch of a case from observed to enforced, decided per case by project policy and risk heuristics.
_Avoid_: upgrade, promotion

**Gate**:
A point in the enforced lifecycle where a case cannot advance without a required condition (evidence, human approval). Gates act on merging and lifecycle progression, never on writing code.
_Avoid_: write gate, edit block

### Signals

**Session Signal**:
A heartbeat from a developer's agent session (start, activity, end) telling Arbitra who is working where: repository, branch, case. The raw material of Mission Control.
_Avoid_: telemetry event, ping

**Evidence**:
A recorded artifact that supports a case's trustworthiness: CI results, test runs, review verdicts, merge records.
_Avoid_: proof, attachment

### Surfaces

**Mission Control**:
The landing page: a live view of what is running right now — which agents, on which branches, in which cases and statuses. Answers "what is happening?", not "how did we do?".
_Avoid_: dashboard, live view, now page

**Observatory**:
The aggregate, retrospective metrics surface: approval rates, cycle times, leaderboards. Answers "how did we do?", not "what is happening?".
_Avoid_: analytics, reports

**Courtroom**:
The surface where a human decides an enforced case that awaits judgment.
