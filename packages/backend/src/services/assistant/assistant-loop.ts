import {
  generateText,
  stepCountIs,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from 'ai';
import {
  toolStepBudget,
  type AssistantBoundId,
  type AssistantBounds,
} from './assistant-bounds.js';
import {
  ASSISTANT_ANSWER_RETRY_INSTRUCTION,
  ASSISTANT_ANSWER_RETRY_LENGTH_INSTRUCTION,
  ASSISTANT_FINAL_STEP_INSTRUCTION,
} from './assistant-prompt.js';
import {
  buildReadToolSet,
  type AnyReadToolDescriptor,
  type ToolCallGuard,
  type ToolCallRecord,
  type ToolReadContext,
} from './tool-registry.js';
import { isAssistantRunCancelledError } from './assistant-cancel-coordinator.js';

/**
 * The bounded tool-calling loop.
 *
 * ## Which SDK surface this uses, and why
 *
 * `generateText` from `ai` 6.0.168 with `tools` + `stopWhen: stepCountIs(n)`.
 * There was no tool-calling precedent in this repository, so the call shape was
 * taken from the installed package's own type declarations rather than from
 * memory of an older release:
 *
 * - `node_modules/ai/dist/index.d.ts` `declare function generateText<TOOLS extends ToolSet, …>`
 *   takes `tools`, `stopWhen`, `abortSignal`, `maxOutputTokens`, `onStepFinish`;
 * - the multi-step bound is `stopWhen`, not the removed `maxSteps` option, and
 *   `stepCountIs` is the exported helper that builds that condition;
 * - a tool is `tool({ description, inputSchema, execute })` from
 *   `@ai-sdk/provider-utils` (re-exported by `ai`) — `inputSchema`, not the
 *   older `parameters`;
 * - usage is reported as flat `inputTokens` / `outputTokens` / `totalTokens`
 *   (`LanguageModelUsage`), and per-step results arrive as `StepResult` with
 *   `toolCalls` / `usage` / `finishReason`.
 *
 * ## Which bounds degrade, which abort
 *
 * Two of the five are counters known before the attempt starts, so the reads can
 * be taken away in an orderly fashion and the model still gets its turn to
 * answer. Those two DEGRADE — nothing already read is thrown away:
 *
 * - `max_steps`: the last permitted step is reserved. `prepareStep` runs it with
 *   `toolChoice: 'none'`, and the model answers from what it has.
 * - `max_tool_calls`: `claimCall` refuses further reads, the refusal reaches the
 *   model as an ordinary tool result, and `prepareStep` withholds the reads from
 *   the next step. This one matters more than the step ceiling under the
 *   configured provider: `@ai-sdk/google` emits PARALLEL function calls, so one
 *   step can spend eleven of twelve calls without spending eleven steps, and the
 *   call counter is then what ends the reading first. Aborting there — which is
 *   what `reportBound` does for every other bound — would discard a whole step's
 *   worth of completed reads and fail the run with nothing to show.
 *
 * The other three ABORT the shared `AbortController` and end the attempt with
 * `{ outcome: 'bound_exceeded' }` and no answer, because each fires mid-step
 * against something that is already gone:
 *
 * - `token_budget`: the allowance is spent, and answering costs more tokens.
 * - `attempt_wall_clock`: the time is up; a further model call is exactly what
 *   the deadline exists to prevent.
 * - `tool_call_limit`: `withCallLimit` (tool-registry.ts) only stops WAITING for
 *   the hung read — the request itself is cancelled by the shared signal, so not
 *   aborting would leave a runaway call alive past its allowance for the rest of
 *   the attempt.
 *
 * The reads an aborting bound interrupts are still recorded: `guard.trace`
 * survives on the failure path, and the executor writes it to
 * `assistant_task_failed` as `tool_call_records`. A failed attempt says what it
 * read on the requester's behalf.
 *
 * ## What is recorded about a degraded attempt, and what is not
 *
 * `reads_withheld` states a FACT the loop knows: the step that produced this
 * answer had no reads available, and which budget took them away. It is NOT a
 * claim that the answer is incomplete — the loop cannot know that. A model whose
 * last read returned everything it needed answers completely on the reserved
 * step, and the modal budget-boundary case is exactly that one. Whether anything
 * was left unchecked is reported by the model itself, in its own sentence, in the
 * requester's language (`ASSISTANT_FINAL_STEP_INSTRUCTION`); the machine records
 * the withholding and does not author a gap on top of it.
 *
 * ## When the reserved step produces no answer
 *
 * It gets asked once more, plainly (`retryAnswerStep`). Three shapes count as
 * "no answer" (or not enough of one), and each gets the same one second ask,
 * with a wording matched to the shape:
 *
 * - the step ran and emitted no text. Not a bound being hit — the step ran,
 *   inside its allowance — and not rare: two of the first five real runs ended
 *   there.
 * - the step ended in TOOL CALLS: the provider ignored `toolChoice: 'none'` and
 *   spent the reserved step asking for reads it could not have. The calls were
 *   not executed, and the text beside them is a preamble, not an answer — so the
 *   attempt is in exactly the same place as the blank shape: reads on the
 *   record, nothing to keep. `@ai-sdk/google` honours the restriction only
 *   intermittently, so gating the second ask on the blank shape alone left the
 *   rescue unreachable on precisely the runs that needed it.
 * - the step ended at `finish_reason: 'length'` — the provider spent most of
 *   `bounds.maxOutputTokens` on thinking tokens for a reasoning-heavy answer
 *   (utilization arithmetic, a paginated aggregation) and what survived into
 *   `result.text` is a FRAGMENT: a mid-sentence tail, or a document truncated
 *   wherever the budget ran out. Unlike the first two shapes this one is not
 *   asked with `ASSISTANT_ANSWER_RETRY_INSTRUCTION` ("your last turn produced no
 *   text" would misdescribe a non-blank fragment): it gets
 *   `ASSISTANT_ANSWER_RETRY_LENGTH_INSTRUCTION`, asking for the conclusion
 *   directly rather than the derivation that burned the budget the first time.
 *   And unlike the other two, a second failure here does not fail the run: the
 *   FIRST fragment is kept as the answer, because it is real text the model
 *   produced, and today's behaviour of storing it verbatim is the floor this
 *   rescue must not fall below.
 *
 * For the first two shapes, what it does NOT do is write an answer. Authorship
 * stays with the model for the same reason the machine-authored "INCOMPLETE
 * RESULT" prefix was removed: a fact about the run may be recorded, but content
 * that does not exist may not be characterised, and that does not change because
 * the alternative is a rejected case. If the second ask is also empty the attempt
 * fails — a failure it earned. The `length` shape differs precisely because there
 * IS content: the model's own (truncated) text, not a machine-authored stand-in.
 *
 * It costs one model call that `stopWhen: stepCountIs(maxSteps)` did not count, so
 * it is reported as one: `answer_retried`, next to a `steps` that stays inside the
 * ceiling. And if that call throws, the attempt ends where it was already headed —
 * the residual bound, unless the `length` shape's own fragment is available to
 * fall back to instead (see `retryAnswerStep` and the catch block below).
 */

export interface AssistantLoopResult {
  outcome: 'answered' | 'bound_exceeded' | 'cancelled';
  /** Present when `outcome === 'answered'`. */
  answer: string;
  /**
   * The step that produced this answer ran with its reads taken away, because a
   * read budget was spent. An observation about the attempt, not a verdict on the
   * answer: a model that had already read everything answers completely here.
   * Callers record it as audit information and must not restate it as a claim
   * that the answer is partial.
   */
  reads_withheld: boolean;
  /** Which budget took the reads away. `null` unless `reads_withheld`. */
  reads_withheld_reason: AssistantReadsWithheldReason | null;
  /**
   * The reserved answer step was asked a second time, because the first ask
   * produced no answer — no text, or tool calls with at most a preamble. A fact
   * about how the answer was obtained, recorded so an operator can see how often
   * the first ask comes back empty. True on the failure path too, when the
   * second ask was also empty or failed.
   */
  answer_retried: boolean;
  /**
   * Clipped text the provider emitted alongside tool calls it spent an answer
   * step on, present only on the failure path. Whichever ask — the first or, if
   * that one also ended in tool calls with real text, the retry — produced it
   * LAST is what is kept: a preamble is not an answer and is never stored as
   * one, but it is carried here because it was the last thing the model said,
   * and a failure event that lost it would leave the trace unable to say what
   * the attempt was about to do when it died.
   */
  discarded_preamble?: string;
  bound: AssistantBoundId | null;
  trace: ToolCallRecord[];
  /**
   * Steps of the ceiling that ran — what `stopWhen: stepCountIs(maxSteps)`
   * counted, so this number never exceeds `bounds.maxSteps` and an audit asking
   * "did the attempt respect its ceiling?" reads the answer off it directly.
   *
   * The second ask on the reserved step is a model call OUTSIDE that count (its
   * own `generate` with its own `stepCountIs(1)`), so it is reported by
   * `answer_retried` instead of added here: model calls made = `steps` plus one
   * when `answer_retried`.
   */
  steps: number;
  finish_reason: string;
  /**
   * Prompt and completion tokens over every model call of the attempt, the second
   * ask included, and their sum.
   *
   * `total_tokens` is DERIVED from the two above rather than carried from the
   * provider's own total, because the three are read as one block ("57 tokens ·
   * 46 in / 23 out") and a total from one source beside a split from another is
   * how a stored usage record ends up contradicting itself. The split is what a
   * cost figure is computed from, so the split is the authority.
   */
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  /**
   * A cancelled provider call may have billed usage that never reached
   * `onStepFinish`. `complete` means no model call began; `partial` preserves
   * every settled count while stating that an in-flight remainder is unknown.
   */
  cancellation_usage_status?: 'complete' | 'partial';
}

/**
 * Why the answering step had no reads. Its own vocabulary rather than
 * `AssistantBoundId`: a budget that degraded gracefully is not a bound hit, and
 * `classifyRunFailure` must never see one.
 *
 * - `step_budget`: the step ceiling reserved this step for the answer.
 * - `tool_call_budget`: the tool-call allowance ran out BEFORE the ceiling, so
 *   the reading ended early. The distinction is the informative part — under a
 *   provider that batches calls this is the one that fires.
 */
export type AssistantReadsWithheldReason = 'step_budget' | 'tool_call_budget';

/**
 * The one line telling the model its own live spend for THIS step:
 * `Budget: step N/M, tool calls X/Y.` — injected into `system` from
 * `prepareStep`, on every step, the same seam that already carries
 * `ASSISTANT_FINAL_STEP_INSTRUCTION` onto the reserved one.
 *
 * Four live dev canaries showed the same exploratory-padding pattern —
 * probes before reading named context, subset re-queries after a call that
 * already succeeded — and the quantified root cause was that the model never
 * saw its own budget: `assistant-bounds.ts`'s bounds are enforced entirely
 * server-side and, until now, "no configured number reaches the model" was
 * the deliberate rule (see that module's doc). This line reverses that rule
 * on purpose, on the theory the same doc states for why the tool-budget FACT
 * was told at all: a model that cannot see how much it has left cannot
 * prioritise its reads.
 *
 * What still never reaches the model is a STATIC, quotable ceiling sitting in
 * the standing prompt text — `ASSISTANT_SYSTEM_PROMPT` stays exactly as
 * digit-free as `assistant-prompt.test.ts` pins it, and this function is
 * never called from there. What this line carries is the LIVE state of one
 * attempt already in flight: `stepNumber` and `toolCallsMade` change on their
 * own as the attempt proceeds, so nothing the model says can move them, and
 * they say nothing about how the bounds were configured for the next attempt.
 *
 * 1-based step display (`stepNumber + 1`): the SDK's own `stepNumber` is
 * 0-based, an implementation detail this line does not carry over — "step
 * 1/6" is what a person (and a model reading English) takes the first step
 * to be.
 *
 * Exported for the test, which pins the exact numbers at two different steps
 * of one attempt rather than re-deriving them.
 */
export function formatBudgetLine(
  stepNumber: number,
  bounds: Pick<AssistantBounds, 'maxSteps' | 'maxToolCalls'>,
  toolCallsMade: number,
): string {
  return `Budget: step ${stepNumber + 1}/${bounds.maxSteps}, tool calls ${toolCallsMade}/${bounds.maxToolCalls}.`;
}

export interface AssistantLoopInput {
  model: LanguageModel;
  system: string;
  prompt: string;
  descriptors: readonly AnyReadToolDescriptor[];
  bounds: AssistantBounds;
  requesterUserId: string;
  caseId: string;
  /** Strongly-consistent persisted fence, called before every model/read boundary. */
  checkCancellation?: () => Promise<void>;
  /** Process-local low-latency abort for a provider/read already in flight. */
  cancellationSignal?: AbortSignal;
  /** Seam for tests. Defaults to the AI SDK's `generateText`. */
  generate?: GenerateTextFn;
}

/**
 * The subset of `generateText` this loop relies on. Declared structurally so a
 * test can substitute a double without constructing a provider, while the
 * production default stays the real function.
 */
export type GenerateTextFn = typeof generateText;

/** Enforces the per-attempt tool bounds and collects the trace. */
export class AssistantLoopGuard implements ToolCallGuard {
  readonly perCallLimitMs: number;
  readonly maxResultChars: number;

  private callsMade = 0;
  private tokensUsed = 0;
  private firstBound: AssistantBoundId | null = null;
  private toolBudgetSpent = false;
  private readonly records: ToolCallRecord[] = [];
  private readonly readSignatures = new Map<string, number>();

  constructor(
    private readonly bounds: AssistantBounds,
    private readonly controller: AbortController,
  ) {
    this.perCallLimitMs = bounds.toolCallLimitMs;
    this.maxResultChars = bounds.maxToolResultChars;
  }

  claimCall(_name: string): AssistantBoundId | null {
    if (this.callsMade >= this.bounds.maxToolCalls) {
      this.toolBudgetSpent = true;
      return 'max_tool_calls';
    }
    this.callsMade += 1;
    // Latched on the LAST permitted call, not on the first refusal: the loop can
    // then withhold the reads from the next step before the model spends a step
    // asking for one it cannot have.
    if (this.callsMade >= this.bounds.maxToolCalls) this.toolBudgetSpent = true;
    return null;
  }

  record(record: ToolCallRecord): void {
    this.records.push(record);
  }

  /**
   * How many times this attempt has now made this read (`ToolCallGuard`). Kept
   * here rather than in the wrapper because the repetition is a property of the
   * ATTEMPT — the wrapper is stateless per call, and the guard is the one object
   * that already spans every call of one attempt.
   */
  noteReadSignature(signature: string): number {
    const seen = (this.readSignatures.get(signature) ?? 0) + 1;
    this.readSignatures.set(signature, seen);
    return seen;
  }

  reportBound(bound: AssistantBoundId): void {
    // The tool-call allowance is a counter, not an accident: it is known before
    // the attempt starts, so it ends the READING rather than the attempt. The
    // refusal the registry returns alongside this call reaches the model as an
    // ordinary tool result, and `prepareStep` withholds the reads from the next
    // step. Aborting here instead would discard every read the attempt had
    // already completed — under a provider that emits parallel calls, that is a
    // whole step of them.
    if (bound === 'max_tool_calls') {
      this.toolBudgetSpent = true;
      return;
    }
    if (this.firstBound === null) this.firstBound = bound;
    // Abort is idempotent; calling it twice is harmless.
    this.controller.abort();
  }

  /**
   * Record the bound that ends the attempt after the generation has already
   * settled — the residual case where the step that had to answer produced
   * nothing to keep. No abort: there is no longer anything to interrupt.
   */
  recordResidualBound(bound: AssistantBoundId): void {
    if (this.firstBound === null) this.firstBound = bound;
  }

  /** Accumulate step usage and stop the attempt once the budget is spent. */
  addUsage(inputTokens: number, outputTokens: number): void {
    this.tokensUsed += inputTokens + outputTokens;
    if (this.tokensUsed > this.bounds.tokenBudget) {
      this.reportBound('token_budget');
    }
  }

  get bound(): AssistantBoundId | null {
    return this.firstBound;
  }

  get trace(): ToolCallRecord[] {
    return [...this.records];
  }

  get toolCalls(): number {
    return this.callsMade;
  }

  /** No tool call may be claimed any more; the allowance is used up. */
  get readsExhausted(): boolean {
    return this.toolBudgetSpent;
  }
}

export async function runAssistantLoop(input: AssistantLoopInput): Promise<AssistantLoopResult> {
  const { bounds } = input;
  const generate = input.generate ?? generateText;

  const controller = new AbortController();
  const propagateCancellation = (): void => {
    controller.abort(input.cancellationSignal?.reason);
  };
  if (input.cancellationSignal?.aborted) propagateCancellation();
  else input.cancellationSignal?.addEventListener('abort', propagateCancellation, { once: true });
  const guard = new AssistantLoopGuard(bounds, controller);
  const wallClockTimer = setTimeout(() => {
    guard.reportBound('attempt_wall_clock');
  }, bounds.attemptWallClockMs);

  const readContext: ToolReadContext = {
    requesterUserId: input.requesterUserId,
    caseId: input.caseId,
    signal: controller.signal,
  };
  const tools = buildReadToolSet(
    input.descriptors,
    readContext,
    guard,
    input.checkCancellation,
  );

  let inputTokens = 0;
  let outputTokens = 0;
  let steps = 0;
  let finishReason = 'unknown';
  let answer = '';
  /**
   * Which budget took the reads away, once one has. Set from inside
   * `prepareStep`, so it reflects a step that actually ran rather than an
   * arithmetic guess about which step the model would have reached.
   */
  let readsWithheldReason: AssistantReadsWithheldReason | null = null;
  /** Whether the reserved step had to be asked twice. */
  let answerRetried = false;
  let modelCallsStarted = 0;
  let modelCallsSettled = 0;
  /** 0-based index of the step the answer is reserved on. */
  const reservedStep = toolStepBudget(bounds);

  /**
   * Token accounting shared by the main generation and the answer retry, and the
   * ONLY place either one's tokens are added.
   *
   * Every generation is counted here exactly once, per step as it finishes, so
   * `input_tokens + output_tokens` is the whole attempt and nothing has to be
   * added again by a caller afterwards. The retry used to be counted here AND
   * again from its returned totals, which inflated the split while the total was
   * added once — a stored usage block whose parts did not sum to its own total.
   */
  const countUsage = (stepInput: number, stepOutput: number): void => {
    inputTokens += stepInput;
    outputTokens += stepOutput;
    guard.addUsage(stepInput, stepOutput);
  };

  /** The usage block for the record. `total` follows the split; see the result type. */
  const usage = (): AssistantLoopUsage => ({
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  });

  /** One step of the MAIN generation: its usage, plus what the record says it did. */
  const countStep = (stepInput: number, stepOutput: number, reason?: string): void => {
    countUsage(stepInput, stepOutput);
    // Tracked per step, not only from the settled result: on the abort path
    // there is no result to read, and reporting `steps: 0` /
    // `finish_reason: 'unknown'` for an attempt that had already made several
    // reads is how a run's own record stops matching what it did.
    steps += 1;
    if (reason) finishReason = reason;
  };

  try {
    // `prepareStep` normally fences every SDK step, but wrappers and provider
    // adapters are not required to preserve that hook. The first provider
    // boundary therefore gets its own durable check so cancellation cannot be
    // bypassed by an adapter that calls `generate` without preparing a step.
    await input.checkCancellation?.();
    const result = await generate({
      model: input.model,
      system: input.system,
      prompt: input.prompt,
      tools,
      stopWhen: stepCountIs(bounds.maxSteps),
      abortSignal: controller.signal,
      maxOutputTokens: bounds.maxOutputTokens,
      // Give the model a step it can only answer on, once its reads are over.
      // Without this the budget lands on a step the model spent on tools, the
      // SDK stops, and everything the reads paid for is thrown away with nothing
      // written — the failure mode this guards against. `toolChoice: 'none'`
      // removes the option to keep reading; the extra instruction is what tells
      // the model the reads are over, so it answers from what it has instead of
      // guessing at the rest.
      //
      // The step ceiling is checked first: on the reserved step the reads are
      // withheld whatever the call counter says, so `tool_call_budget` keeps its
      // narrower meaning — the reading ended EARLY, before the ceiling.
      prepareStep: async ({ stepNumber }) => {
        await input.checkCancellation?.();
        const reason: AssistantReadsWithheldReason | null = stepNumber >= reservedStep
          ? 'step_budget'
          : guard.readsExhausted
            ? 'tool_call_budget'
            : null;
        // Live, every step — see `formatBudgetLine`'s own doc for why this does
        // not reopen the "no configured number reaches the model" question.
        const budgetLine = formatBudgetLine(stepNumber, bounds, guard.toolCalls);
        if (reason === null) return { system: `${input.system}\n\n${budgetLine}` };
        readsWithheldReason ??= reason;
        return {
          toolChoice: 'none',
          system: `${input.system}\n\n${budgetLine}\n\n${ASSISTANT_FINAL_STEP_INSTRUCTION}`,
        };
      },
      experimental_onStepStart: () => {
        modelCallsStarted += 1;
      },
      onStepFinish: (step) => {
        modelCallsSettled += 1;
        countStep(step.usage.inputTokens ?? 0, step.usage.outputTokens ?? 0, step.finishReason);
      },
    });

    steps = result.steps.length;
    finishReason = result.finishReason;
    answer = result.text ?? '';
    // The settled result's own totals replace the per-step sums for the main
    // generation, which is why the retry's tokens must be added AFTER this point
    // (they are: `countUsage` runs from the retry's own `onStepFinish`).
    if (result.totalUsage.inputTokens !== undefined) inputTokens = result.totalUsage.inputTokens;
    if (result.totalUsage.outputTokens !== undefined) outputTokens = result.totalUsage.outputTokens;

    // A bound may have fired while the last model call was already in flight.
    if (guard.bound) return boundResult(guard, steps, finishReason, usage());

    // The generation ended on a step that emitted tool calls: the ceiling stopped
    // it there, or a provider ignored `toolChoice: 'none'` and spent the reserved
    // step on reads anyway. `result.text` is the FINAL step's text (ai 6.0.168,
    // `dist/index.js:4805`), and the text a model emits alongside tool calls is a
    // preamble to them — "Let me check the remaining two cases." Storing that as
    // the governed answer would put a sentence about what the model was ABOUT to
    // do into the case as its `task_result`, so it is discarded — but the attempt
    // is not failed yet. This is the same shape as the blank reserved step: the
    // step that had to answer did not answer, with the reads paid for and on the
    // record, so it gets the same second ask. The preamble is kept aside so a
    // failed second ask can still put the last thing the model said into the
    // failure event.
    const endedInToolCalls = finishReason === 'tool-calls';
    // The generation ended at the provider's output-token ceiling with REAL text
    // beside it — not a preamble to calls that never ran, a genuine (if cut off)
    // attempt at the answer (issue #841): `bounds.maxOutputTokens` is spent
    // mostly on thinking for a reasoning-heavy request, and what reaches
    // `result.text` is whatever fragment the visible reply had emitted before
    // the cut — a mid-sentence tail, or a document truncated wherever the
    // budget ran out. Kept aside, unconditionally and before the retry runs: if
    // the rescue below cannot do better, this fragment is what stays the answer
    // rather than failing an attempt that already has something real to show.
    const endedInLength = finishReason === 'length';
    const firstAttemptFragment = endedInLength ? answer : '';
    // `let`, not `const`: the retry below can itself land back on this shape (a
    // provider that ignores `toolChoice: 'none'` twice), and the LAST thing the
    // model said is whichever ask actually produced it — see the reassignment
    // after the retry.
    let discardedPreamble = endedInToolCalls
      ? answer.trim().slice(0, DISCARDED_PREAMBLE_MAX_CHARS)
      : '';
    if (endedInToolCalls) answer = '';

    if (
      endedInToolCalls ||
      endedInLength ||
      (readsWithheldReason !== null && answer.trim().length === 0)
    ) {
      // The step that had to answer produced nothing to keep — no text, tool
      // calls with at most a preamble, or a fragment cut off by the
      // output-token ceiling. Ask once more: two of the first five real runs
      // died on the blank shape, a later run died on the tool-call shape after
      // its provider read past `toolChoice: 'none'` on the reserved step, and
      // the `length` shape is issue #841. The wording matches which one it is —
      // "your last turn produced no text" would misdescribe a real fragment.
      const retryInstruction =
        endedInLength && firstAttemptFragment.trim().length > 0
          ? ASSISTANT_ANSWER_RETRY_LENGTH_INSTRUCTION
          : ASSISTANT_ANSWER_RETRY_INSTRUCTION;
      let retried: RetriedAnswer | null;
      try {
        retried = await retryAnswerStep({
          model: input.model,
          system: input.system,
          prompt: input.prompt,
          priorMessages: responseMessages(result),
          tools,
          bounds,
          signal: controller.signal,
          generate,
          countUsage,
          instruction: retryInstruction,
          checkCancellation: input.checkCancellation,
          onModelCallStart: () => {
            modelCallsStarted += 1;
          },
          onModelCallSettled: () => {
            modelCallsSettled += 1;
          },
        });
      } catch (err) {
        if (input.cancellationSignal?.aborted || isAssistantRunCancelledError(err)) {
          throw err;
        }
        answerRetried = true;
        // The `length` shape already has a real fragment (`firstAttemptFragment`)
        // from the first ask. A provider error on the RESCUE must not cost that
        // fragment the attempt: today's (pre-fix) behaviour already stores it
        // verbatim, and this rescue may not regress a run that already had an
        // answer into a bound failure just because it could not improve on one.
        if (firstAttemptFragment.trim().length > 0) {
          console.warn(
            `[assistant-loop] the length retry for case ${input.caseId} failed; keeping the first fragment:`,
            err,
          );
          return answeredResult(
            guard,
            steps,
            finishReason,
            usage(),
            firstAttemptFragment,
            answerRetried,
            readsWithheldReason,
          );
        }
        // A provider error on the SECOND ask must not cost the attempt its trace.
        // Rethrowing lands in the executor's `model_call_failed` path, which has no
        // loop result to take `tool_call_records` or `bounds` from, so reads that
        // really happened would leave no audit trail at all — and a 5xx in the
        // error text would additionally classify the whole attempt as retryable,
        // re-running those reads. The attempt was already headed for the residual
        // bound when the first ask came back empty; a second ask that could not be
        // completed leaves it exactly there, with what it read on the record.
        //
        // A bound that aborted mid-retry is not swallowed: `guard.bound` is
        // already set in that case and stays the reported reason.
        if (guard.bound === null) {
          guard.recordResidualBound(residualBound(readsWithheldReason));
          // Logged rather than stored: the run's own record says a bound ended it,
          // which is what happened, and the provider's error text belongs where an
          // operator debugs the provider — not in a case artifact.
          console.warn(
            `[assistant-loop] the second ask for the answer failed for case ${input.caseId}:`,
            err,
          );
        }
        return boundResult(guard, steps, finishReason, usage(), answerRetried, discardedPreamble);
      }
      if (retried) {
        answerRetried = true;
        // A clean rescue: not itself cut off at length, not a preamble to tool
        // calls it could not make, and not blank. Anything else is the rescue
        // failing the same way the first ask did — and when the first ask left
        // a real fragment behind (the `length` shape), THAT fragment is what
        // stays the answer rather than the rescue's own failure, so an attempt
        // that already had something to show is never turned into one that
        // does not just because the rescue could not improve on it.
        const retriedIsUsable =
          retried.finishReason !== 'length' &&
          retried.finishReason !== 'tool-calls' &&
          retried.text.trim().length > 0;
        if (!retriedIsUsable && firstAttemptFragment.trim().length > 0) {
          answer = firstAttemptFragment;
          // `finishReason` is left at what the FIRST ask ended with (`length`):
          // that is what actually produced the text now being stored.
        } else {
          answer = retried.text;
          if (retried.finishReason) finishReason = retried.finishReason;
        }
        // The second ask can end in tool calls too — the same provider
        // behaviour that made the FIRST ask need a retry can recur on the
        // retry itself. When it does and still said something, that text —
        // not the first ask's preamble computed above — is the last thing the
        // model said, so it replaces it for the failure payload. A blank
        // second-ask text is not a replacement: it would erase a real first
        // preamble with nothing.
        if (retried.finishReason === 'tool-calls' && retried.text.trim().length > 0) {
          discardedPreamble = retried.text.trim().slice(0, DISCARDED_PREAMBLE_MAX_CHARS);
        }
      }
      // The retry runs on the shared signal and its usage goes through the same
      // guard, so the token budget and the wall clock still end the attempt here.
      if (guard.bound) {
        return boundResult(guard, steps, finishReason, usage(), answerRetried, discardedPreamble);
      }
      if (answer.trim().length === 0 || finishReason === 'tool-calls') {
        // Asked twice, nothing to keep. Still the only case where a degrading
        // budget fails the run — and now a failure the attempt earned. Never
        // reached by the `length` shape while its fragment survived: the branch
        // above already restored it into `answer` with `finishReason` left at
        // `'length'`, which satisfies neither clause here.
        guard.recordResidualBound(residualBound(readsWithheldReason));
        return boundResult(guard, steps, finishReason, usage(), answerRetried, discardedPreamble);
      }
    }

    return answeredResult(guard, steps, finishReason, usage(), answer, answerRetried, readsWithheldReason);
  } catch (err) {
    if (input.cancellationSignal?.aborted || isAssistantRunCancelledError(err)) {
      return cancelledResult(
        guard,
        steps,
        finishReason,
        usage(),
        answerRetried,
        modelCallsStarted === modelCallsSettled ? 'complete' : 'partial',
      );
    }
    // An abort raised by one of our own bounds is not an error condition — it is
    // how the bound stops the attempt. Anything else propagates so the executor
    // records a real failure instead of mislabelling it as a bound.
    if (guard.bound) {
      return boundResult(guard, steps, finishReason, usage(), answerRetried);
    }
    throw err;
  } finally {
    clearTimeout(wallClockTimer);
    input.cancellationSignal?.removeEventListener('abort', propagateCancellation);
  }
}

/**
 * Which bound id a residual failure is recorded under. The budget that ended the
 * reading is the one that ended the attempt; `max_steps` covers the case where
 * nothing was withheld at all (no `prepareStep`, ceiling reached on a tool step).
 */
function residualBound(reason: AssistantReadsWithheldReason | null): AssistantBoundId {
  return reason === 'tool_call_budget' ? 'max_tool_calls' : 'max_steps';
}

/**
 * The messages the first generation produced, for the retry to answer from.
 *
 * `response.messages` is where the SDK returns them (ai 6.0.168,
 * `GenerateTextResult.response.messages`), and it is read defensively: a wrapped
 * or substituted model that omits it leaves the retry with no tool results to
 * answer from, and a model asked to answer from nothing produces an answer
 * grounded in nothing. That is worse than the failure this retry exists to avoid,
 * so an absent history means no retry rather than a groundless one.
 */
function responseMessages(result: unknown): ModelMessage[] {
  const messages = (result as { response?: { messages?: unknown } } | null)?.response?.messages;
  return Array.isArray(messages) ? (messages as ModelMessage[]) : [];
}

/**
 * Ask the reserved step again, once, with the tools still withheld.
 *
 * ## Why this does not widen any bound
 *
 * `maxSteps` is untouched, no tool is on offer (`toolChoice: 'none'`, the same
 * mechanism the reserved step already uses), the shared abort signal still
 * carries the wall clock, and the retry's usage goes through the same
 * `guard.addUsage`, so the token budget binds across both asks.
 *
 * What it does spend is one model call more than `stepCountIs(maxSteps)` allowed:
 * the READS are bounded exactly as before (none are on offer here at all), the
 * model calls are one higher. That is not hidden in the step count — `steps` stays
 * at what the ceiling counted and `answer_retried` reports the extra call — so a
 * record that shows four steps against a ceiling of three cannot arise from a
 * retried run.
 *
 * ## Why the conversation is replayed rather than the prompt re-sent
 *
 * The tool results are what the answer has to come from. Re-sending only the
 * request would ask the model to answer with its reads discarded, which is how a
 * retry turns a missing answer into a wrong one.
 *
 * ## Why the turn being retried is not replayed
 *
 * The history is replayed WITHOUT the assistant turn that produced no answer. That
 * turn is the shape this ask exists to escape, and handing it back as the most
 * recent history is an invitation to repeat it. Dropping it also leaves the history
 * ending on the tool results the answer must rest on, which is where it should end.
 *
 * A reserved step spent on TOOL CALLS is dropped by the same rule, one clause
 * earlier: its calls were never executed (the tools were withheld), so the turn
 * carries tool calls with no tool results anywhere in the history — a shape the
 * transport rejects outright, exactly as it rejects the blank text part
 * `withoutBlankText` strips. Unlike a blank preamble beside EXECUTED calls,
 * nothing in such a turn is load-bearing for the answer, because no result ever
 * attached to it (`isDanglingToolCallTurn`).
 *
 * Three shapes count as "produced no answer", because all three reach here and only
 * the first one is obvious (`hasContent`): a turn with no parts at all, a turn whose
 * only text part is whitespace (the loop retries on `answer.trim()`, and neither the
 * SDK nor the Anthropic provider strips a lone `' '` out of a non-final message —
 * the provider rejects the request over it), and a reasoning-only turn, where the
 * model thought and said nothing.
 *
 * A turn that IS replayed gets the same treatment one level down: a blank text part
 * next to real tool calls is stripped rather than costing the turn (`withoutBlankText`),
 * because the provider rejects the block wherever it sits.
 *
 * ## Why this is the one call that gets `bounds.maxAnswerOutputTokens`
 *
 * The first ask shares one `generateText` call with every tool step of the
 * attempt, and `ai` 6.0.168 has no per-step override of `maxOutputTokens` —
 * `PrepareStepResult` does not carry one — so that call is stuck with one cap
 * for reads and answer alike (`assistant-bounds.ts`). This call is not: it is
 * always its own standalone `generateText`, made only after the first ask
 * already failed to answer, so widening its ceiling costs nothing on the tool
 * steps that already ran.
 */
async function retryAnswerStep(args: {
  model: LanguageModel;
  system: string;
  prompt: string;
  priorMessages: readonly ModelMessage[];
  tools: ToolSet;
  bounds: AssistantBounds;
  signal: AbortSignal;
  generate: GenerateTextFn;
  countUsage: (inputTokens: number, outputTokens: number) => void;
  /**
   * The user turn this ask closes with. Chosen by the caller from the shape
   * that triggered the retry — `ASSISTANT_ANSWER_RETRY_INSTRUCTION` for a
   * blank or tool-calls first ask, `ASSISTANT_ANSWER_RETRY_LENGTH_INSTRUCTION`
   * for a `length` first ask that left a real fragment behind — because only
   * the caller knows which one applies.
   */
  instruction: string;
  checkCancellation?: () => Promise<void>;
  onModelCallStart?: () => void;
  onModelCallSettled?: () => void;
}): Promise<RetriedAnswer | null> {
  const executed = executedToolCallIds(args.priorMessages);
  const history = args.priorMessages
    .filter((message) => !isDanglingToolCallTurn(message, executed))
    .filter(hasContent)
    .map(withoutBlankText);
  if (history.length === 0) return null;

  await args.checkCancellation?.();

  const result = await args.generate({
    model: args.model,
    system: args.system,
    messages: [
      { role: 'user', content: args.prompt },
      ...history,
      { role: 'user', content: args.instruction },
    ],
    tools: args.tools,
    toolChoice: 'none',
    stopWhen: stepCountIs(1),
    abortSignal: args.signal,
    maxOutputTokens: args.bounds.maxAnswerOutputTokens,
    experimental_onStepStart: () => {
      args.onModelCallStart?.();
    },
    onStepFinish: (step) => {
      args.onModelCallSettled?.();
      args.countUsage(step.usage.inputTokens ?? 0, step.usage.outputTokens ?? 0);
    },
  });

  // No usage is returned: this ask's tokens went through `countUsage` as the step
  // finished, and returning them as well is what let a caller add them twice.
  return { text: result.text ?? '', finishReason: result.finishReason };
}

/** What the second ask produced, for the caller to keep or reject. */
interface RetriedAnswer {
  text: string;
  finishReason: string;
}

/**
 * Longest discarded preamble the failure result carries. Same restraint as the
 * trace's `errorDetail`: enough to see what the model was about to do, not a
 * channel for arbitrary length text into a case event.
 */
const DISCARDED_PREAMBLE_MAX_CHARS = 300;

/**
 * Tool-call ids that have a result somewhere in the reported conversation.
 *
 * The pairing is by id, never by position: the SDK reports each executed call's
 * result in a `tool` message whose parts carry the same `toolCallId`.
 */
export function executedToolCallIds(messages: readonly ModelMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    const { content } = message;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const { type, toolCallId } = (part ?? {}) as { type?: unknown; toolCallId?: unknown };
      if (type === 'tool-result' && typeof toolCallId === 'string') ids.add(toolCallId);
    }
  }
  return ids;
}

/**
 * Whether an assistant turn carries a tool call that was never executed.
 *
 * The reserved step spent on tool calls is exactly this shape: the tools were
 * withheld, so the provider's calls got no results. Replaying such a turn hands
 * the transport an assistant message whose tool calls have no tool results —
 * rejected whole, the same way a whitespace-only text block is — and even a
 * transport that tolerated it would present the second ask with calls that look
 * answerable and are not. A call with no id at all counts as dangling for the
 * same reason: nothing can ever have attached a result to it.
 *
 * Exported for the test, which asserts the production predicate rather than a
 * re-implementation — same rule as `carriesSubstance`, for the same reason.
 */
export function isDanglingToolCallTurn(
  message: ModelMessage,
  executed: ReadonlySet<string>,
): boolean {
  if (message.role !== 'assistant') return false;
  const { content } = message;
  if (!Array.isArray(content)) return false;
  return content.some((part) => {
    const { type, toolCallId } = (part ?? {}) as { type?: unknown; toolCallId?: unknown };
    return type === 'tool-call' && !(typeof toolCallId === 'string' && executed.has(toolCallId));
  });
}

/** The three numbers recorded together, so they are also computed together. */
interface AssistantLoopUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/**
 * Whether a replayed message carries something the second ask can build on.
 *
 * Two jobs in one predicate. A provider rejects a message with no parts, so an
 * empty turn cannot be replayed at all; and the turn that produced no answer must
 * not be replayed even when it does have parts, because it is the shape the second
 * ask exists to escape (see `retryAnswerStep`).
 *
 * A tool-call turn has no text either and is KEPT: it is what the tool results
 * attach to, and those results are what the answer has to come from.
 */
function hasContent(message: ModelMessage): boolean {
  const { content } = message;
  if (typeof content === 'string') return content.trim().length > 0;
  return Array.isArray(content) && content.some(carriesSubstance);
}

/**
 * Whether one content part is something other than an empty utterance. Unknown
 * part types count as substance: a part this code does not recognise is more
 * likely a payload the answer needs than an empty turn in disguise.
 *
 * Exported for the test, which used to re-implement it — and the copy silently
 * dropped the `redacted-reasoning` clause, so no test covered it. A predicate
 * asserted against its own double certifies the double.
 */
export function carriesSubstance(part: unknown): boolean {
  const { type, text } = (part ?? {}) as { type?: unknown; text?: unknown };
  if (type === 'text') return typeof text === 'string' && text.trim().length > 0;
  // Reasoning is what the model thought, not what it said. A turn that only
  // thought is an empty turn as far as the requester's answer is concerned.
  return type !== 'reasoning' && type !== 'redacted-reasoning';
}

/**
 * Drop the blank text parts from a turn that is otherwise worth replaying.
 *
 * `hasContent` decides whole MESSAGES, and dropping a message is the wrong remedy
 * for a turn that carries tool calls plus a whitespace-only preamble — those tool
 * calls are what the tool results attach to, and the results are what the answer
 * has to come from. But the blank part cannot travel either: Anthropic rejects the
 * whole request with 400 `text content blocks must contain non-whitespace text`
 * over ANY such block, not just a trailing one, and the provider trims only the
 * last block of the last message — which a replayed mid-conversation turn is not.
 * So the second ask would fail on the transport for a reason that has nothing to
 * do with the answer. Strip the part, keep the turn.
 *
 * Blankness is `carriesSubstance`'s own verdict on a text part, so the predicate
 * that decides which turns to keep and the one that decides which parts to keep
 * cannot drift apart.
 */
function withoutBlankText(message: ModelMessage): ModelMessage {
  const { content } = message;
  if (!Array.isArray(content)) return message;
  const kept = content.filter(
    (part) => (part as { type?: unknown }).type !== 'text' || carriesSubstance(part),
  );
  if (kept.length === content.length) return message;
  return { ...message, content: kept } as ModelMessage;
}

/**
 * The one shape `outcome: 'answered'` is built in, so the normal end of the
 * attempt and the `length` shape's fallback to its first fragment (both
 * `runAssistantLoop`, above) construct the same result the same way.
 */
function answeredResult(
  guard: AssistantLoopGuard,
  steps: number,
  finishReason: string,
  usage: AssistantLoopUsage,
  answer: string,
  answerRetried: boolean,
  readsWithheldReason: AssistantReadsWithheldReason | null,
): AssistantLoopResult {
  return {
    outcome: 'answered',
    answer,
    reads_withheld: readsWithheldReason !== null,
    reads_withheld_reason: readsWithheldReason,
    answer_retried: answerRetried,
    bound: null,
    trace: guard.trace,
    steps,
    finish_reason: finishReason,
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens,
  };
}

function boundResult(
  guard: AssistantLoopGuard,
  steps: number,
  finishReason: string,
  usage: AssistantLoopUsage,
  answerRetried = false,
  discardedPreamble = '',
): AssistantLoopResult {
  return {
    outcome: 'bound_exceeded',
    answer: '',
    // There is no answer for the withholding to qualify. What the attempt did
    // manage to read is in `trace`, and `bound` says what stopped it.
    reads_withheld: false,
    reads_withheld_reason: null,
    answer_retried: answerRetried,
    ...(discardedPreamble ? { discarded_preamble: discardedPreamble } : {}),
    bound: guard.bound,
    trace: guard.trace,
    steps,
    finish_reason: finishReason,
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens,
  };
}

function cancelledResult(
  guard: AssistantLoopGuard,
  steps: number,
  finishReason: string,
  usage: AssistantLoopUsage,
  answerRetried: boolean,
  usageStatus: 'complete' | 'partial',
): AssistantLoopResult {
  return {
    outcome: 'cancelled',
    answer: '',
    reads_withheld: false,
    reads_withheld_reason: null,
    answer_retried: answerRetried,
    bound: null,
    trace: guard.trace,
    steps,
    finish_reason: finishReason === 'unknown' ? 'cancelled' : finishReason,
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens,
    cancellation_usage_status: usageStatus,
  };
}
