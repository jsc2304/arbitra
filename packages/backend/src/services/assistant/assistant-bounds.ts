/**
 * Server-side execution bounds for one assistant task attempt.
 *
 * Every bound is read from the environment on each attempt (so a limit change
 * takes effect without a restart, and tests can set them per case) and every
 * bound has a sane default, because an unset or malformed variable must never
 * silently mean "unlimited". `readPositiveInt` therefore falls back to the
 * documented default rather than trusting a non-positive override — the same
 * rule `AssistantIntakeService` applies to its intake limits.
 *
 * Bounds are enforced here and nowhere else, and no tool can widen them.
 *
 * `assistant-loop.ts` (`formatBudgetLine`) tells the model its LIVE spend
 * against these numbers every step — a model with no visibility into its own
 * progress was observed padding attempts with exploratory probes instead of
 * planning them. What still never reaches the model is a STATIC, quotable
 * ceiling sitting in the standing prompt text (`assistant-prompt.ts`'s
 * `ASSISTANT_SYSTEM_PROMPT` stays exactly as digit-free as
 * `assistant-prompt.test.ts` pins it): the injected line describes an attempt
 * already in flight and changes on its own as that attempt proceeds, so
 * nothing the model says can move it, and it says nothing about how a FUTURE
 * attempt's bounds are configured. The numbers stay unnegotiable even though
 * they are no longer unstated.
 */

export const ASSISTANT_BOUND_IDS = [
  'max_steps',
  'max_tool_calls',
  'tool_call_limit',
  'token_budget',
  'attempt_wall_clock',
] as const;

export type AssistantBoundId = (typeof ASSISTANT_BOUND_IDS)[number];

export interface AssistantBounds {
  /**
   * Maximum model steps (one step = one model call plus its tool results). The
   * final answer costs a step of its own, so the tool budget is one less —
   * `toolStepBudget`.
   */
  maxSteps: number;
  /** Maximum tool calls across the whole attempt, all tools combined. */
  maxToolCalls: number;
  /** Wall-clock limit for a single tool call. */
  toolCallLimitMs: number;
  /** Total (input + output) token budget across all steps. */
  tokenBudget: number;
  /** Wall-clock limit for the whole attempt, model calls and tools included. */
  attemptWallClockMs: number;
  /** Longest answer that may be persisted, in characters. */
  maxAnswerChars: number;
  /**
   * Cap handed to the provider as `maxOutputTokens`. Distinct from
   * `maxAnswerChars`: this one bounds generation cost per model call, the other
   * bounds what may be written to the case. Neither implies the other.
   */
  maxOutputTokens: number;
  /**
   * Cap handed to the provider as `maxOutputTokens` for the answer step's OWN
   * retry (`retryAnswerStep` in `assistant-loop.ts`), and only there.
   *
   * A reasoning-heavy answer — the shape gemini-3.5-flash produces for
   * arithmetic or aggregation questions — spends most of `maxOutputTokens` on
   * thinking tokens that never reach `result.text`, so the visible reply can be
   * cut off (`finish_reason: 'length'`) well short of a complete answer even
   * though the tool reads that fed it were fine. Widening the ceiling only for
   * the rescue call gives that reasoning room without also raising the cost of
   * every ordinary tool step, which is what `maxOutputTokens` still governs.
   *
   * It is NOT applied to the answer step's first ask: that ask shares one
   * `generateText` call with every tool step of the attempt (`ai` 6.0.168 has
   * no per-step override of `maxOutputTokens` — `prepareStep`'s
   * `PrepareStepResult` carries `model` / `toolChoice` / `activeTools` /
   * `system` / `messages` / `providerOptions`, and stops there), so a single
   * cap governs the whole call and raising it would raise it for the reads too.
   * The retry is the one place a distinct cap is possible at all: it is its own
   * standalone call, made only after the first ask already failed to answer.
   */
  maxAnswerOutputTokens: number;
  /**
   * Longest tool result handed back to the model, per call. Raised from the
   * original 4,000 to 12,000: 4,000 chars (~1k tokens)
   * was tight enough to clip legitimate dense results — a full page of
   * `arbitra_search_cases` rows can run to several thousand chars on its
   * own. At `maxToolCalls` (12) calls of 12,000 chars each, the worst
   * case is ~36,000 tokens, still comfortably inside `tokenBudget` (60,000)
   * and the per-attempt 200k-token ceiling, so the env var remains the actual
   * tuning knob and this default stops being the thing that clips first.
   */
  maxToolResultChars: number;
  /**
   * Most always-inject Clerk context entries (#832 slice A) one attempt may
   * carry into the prompt. An entry beyond this cap stays search-only —
   * still reachable through `arbitra_search_knowledge`, just not injected —
   * so a requester who marks many entries always-inject degrades to search
   * rather than an unbounded prompt.
   */
  maxInjectedContextEntries: number;
  /**
   * Most total characters (summed across every entry kept under
   * `maxInjectedContextEntries`) the injected-context section may add to the
   * prompt. Distinct from the entry cap: a handful of very long entries
   * could satisfy the count cap while still dominating the prompt, which is
   * what this bound is for — see `applyInjectedContextBounds`.
   */
  maxInjectedContextChars: number;
}

export function resolveAssistantBounds(): AssistantBounds {
  return reconcileAssistantBounds({
    maxSteps: readPositiveInt('ARBITRA_ASSISTANT_MAX_STEPS', 6),
    maxToolCalls: readPositiveInt('ARBITRA_ASSISTANT_MAX_TOOL_CALLS', 12),
    toolCallLimitMs: readPositiveInt('ARBITRA_ASSISTANT_TOOL_CALL_LIMIT_MS', 10_000),
    tokenBudget: readPositiveInt('ARBITRA_ASSISTANT_TOKEN_BUDGET', 60_000),
    attemptWallClockMs: readPositiveInt('ARBITRA_ASSISTANT_ATTEMPT_WALL_CLOCK_MS', 120_000),
    maxAnswerChars: readPositiveInt('ARBITRA_ASSISTANT_MAX_ANSWER_CHARS', 8_000),
    maxOutputTokens: readPositiveInt('ARBITRA_ASSISTANT_MAX_OUTPUT_TOKENS', 2_000),
    maxAnswerOutputTokens: readPositiveInt('ARBITRA_ASSISTANT_MAX_ANSWER_OUTPUT_TOKENS', 4_000),
    maxToolResultChars: readPositiveInt('ARBITRA_ASSISTANT_MAX_TOOL_RESULT_CHARS', 12_000),
    maxInjectedContextEntries: readPositiveInt('ARBITRA_ASSISTANT_MAX_INJECTED_CONTEXT_ENTRIES', 5),
    maxInjectedContextChars: readPositiveInt('ARBITRA_ASSISTANT_MAX_INJECTED_CONTEXT_CHARS', 8_000),
  });
}

/**
 * Steps of one attempt that may carry tool calls.
 *
 * The final answer is what ENDS the SDK's generation loop — it continues only
 * while the last step emitted tool calls (`generateText` in ai 6.0.168,
 * `dist/index.js:4641`), and `stepCountIs` counts model calls, not tool calls
 * (`dist/index.js:3930`). So one step of `maxSteps` always pays for the answer,
 * and `assistant-loop.ts` reserves it deliberately instead of letting the
 * ceiling cut the attempt off with nothing to show.
 *
 * Derived on demand rather than stored on `AssistantBounds`, so a caller that
 * overrides `maxSteps` cannot leave a stale copy of the derivation behind.
 */
export function toolStepBudget(bounds: Pick<AssistantBounds, 'maxSteps'>): number {
  return bounds.maxSteps - 1;
}

/**
 * Reconcile the step budget with the tool-call budget so neither can ship
 * unreachable.
 *
 * `maxToolCalls` binds on its own only under parallel function calling, where
 * one step may emit several calls. Sequential tool use spends one call per step,
 * so a `maxToolCalls` below `toolStepBudget` would end the reading first every
 * time and make `max_steps` dead configuration that is still advertised as an
 * independent budget in the event payload and the trace. (Both budgets now
 * degrade rather than fail — see `assistant-loop.ts` — so this is about what the
 * recorded bounds mean, not about which failure an operator gets.)
 *
 * The two are reconciled by LOWERING `maxSteps`, never by raising
 * `maxToolCalls`: of two contradictory limits the tighter one is what an
 * operator can be assumed to have meant, and widening a configured bound to
 * satisfy an invariant is precisely the move a bounds module must not make.
 *
 * The floor of two steps is the other half: at `maxSteps: 1` the reserved answer
 * step is the only step, so every tool the policy enabled becomes unreachable.
 * That is not a tighter budget, it is a silent feature switch, which this
 * variable does not mean.
 */
export function reconcileAssistantBounds(configured: AssistantBounds): AssistantBounds {
  return {
    ...configured,
    maxSteps: Math.min(Math.max(2, configured.maxSteps), configured.maxToolCalls + 1),
  };
}

/**
 * Applies both injected-context bounds (#832 slice A) to a candidate list
 * that is already ordered most-recently-updated first — the ordering itself
 * is the query's job (`assistant-task-executor.ts`'s `loadInjectedContext`),
 * not this function's; a caller that hands in a differently-ordered list
 * gets a differently-ordered result, deterministically.
 *
 * Entries beyond either cap are DROPPED, never truncated: the count cap
 * stops taking further entries once it is reached, and the char cap stops
 * at the first entry that would push the running total over it — a later,
 * smaller entry never jumps ahead of an earlier, larger one that was
 * excluded, so which entries land in the prompt does not depend on their
 * size, only on their update order. Both caps are evaluated together in one
 * pass so an entry can be excluded by whichever bound it reaches first.
 */
export function applyInjectedContextBounds<T extends { title: string; body: string }>(
  entries: readonly T[],
  bounds: Pick<AssistantBounds, 'maxInjectedContextEntries' | 'maxInjectedContextChars'>,
): T[] {
  const kept: T[] = [];
  let chars = 0;
  for (const entry of entries) {
    if (kept.length >= bounds.maxInjectedContextEntries) break;
    const entryChars = entry.title.length + entry.body.length;
    if (chars + entryChars > bounds.maxInjectedContextChars) break;
    kept.push(entry);
    chars += entryChars;
  }
  return kept;
}

function readPositiveInt(variable: string, fallback: number): number {
  const raw = process.env[variable];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * The `error_message` recorded on the run when a bound ends the attempt.
 *
 * Two deliberate properties:
 *
 * 1. It classifies as PERMANENT under `classifyRunFailure`. A bound is a
 *    decision, not a blip: retrying an attempt that exhausted its budget burns
 *    the same budget again and delays the `run_retries_exhausted` notification
 *    the requester actually needs.
 * 2. It contains no configured number. `classifyRunFailure` treats a bare
 *    5xx-shaped token as an HTTP status (hence transient), so embedding a
 *    limit like `500` would flip the classification depending on
 *    configuration. The numbers belong in the event payload and the trace
 *    artifact, which is where they are recorded.
 *
 * `assistant-loop.test.ts` pins the classification for every bound id.
 *
 * `max_steps` and `max_tool_calls` reach this function only in the residual case:
 * the reads were withheld, the model was left with nothing to do but answer, and
 * it produced no text to keep (or spent that step on tool calls anyway, leaving
 * only a preamble). A spent read budget normally ends in an answer, not in a
 * failed run — see `assistant-loop.ts`.
 *
 * Whether a SECOND ask was made is a fact about the run, and the message states it
 * only when it is true. One path into the residual case never reaches the retry —
 * an attempt whose conversation was not reported back declines it, because a
 * second ask grounded in nothing would be worse than the failure — so a fixed
 * "on the first ask or the plainer second one" would be a machine-authored claim
 * about a call that did not happen, on the run record an operator reads. That is
 * the class of sentence this feature already removed once (`assistant-prompt.ts`,
 * "WHY NOTHING IS PREPENDED").
 */
export function boundFailureMessage(
  bound: AssistantBoundId,
  run: { answerRetried?: boolean } = {},
): string {
  const asks = run.answerRetried
    ? 'on the first ask or the plainer second one'
    : 'on the one ask it was given';
  switch (bound) {
    case 'max_steps':
      return `Assistant attempt stopped by the max_steps bound: the step budget ran out and the step reserved for the answer produced no text to keep, ${asks}.`;
    case 'max_tool_calls':
      return `Assistant attempt stopped by the max_tool_calls bound: the tool-call allowance ran out and the step that had to answer produced no text to keep, ${asks}.`;
    case 'tool_call_limit':
      return 'Assistant attempt stopped by the tool_call_limit bound: a single tool call outlasted its per-call allowance.';
    case 'token_budget':
      return 'Assistant attempt stopped by the token_budget bound: the attempt exhausted its token allowance.';
    case 'attempt_wall_clock':
      return 'Assistant attempt stopped by the attempt_wall_clock bound: the attempt outlasted its wall-clock allowance.';
  }
}
