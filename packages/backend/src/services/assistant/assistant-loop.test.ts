import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import type { LanguageModel } from 'ai';

/**
 * The loop's contract is "bounded, and honest about it".
 *
 * Each bound is exercised separately. Four of them end the attempt with a
 * recorded reason and an EMPTY answer — letting a half-finished answer out
 * through a bound would have the executor persist it as a governed result. The
 * step budget is the exception, and the reason it is one is under test here: it
 * is a ceiling known in advance, so the last step is reserved for the answer and
 * the attempt degrades into a PARTIAL answer that says it is partial.
 *
 * The AI SDK call is replaced by a double so the bounds, not a provider, decide
 * what happens. The double is shaped after the installed `ai` 6.0.168 surface
 * the loop actually uses: it receives `tools` / `stopWhen` / `abortSignal` /
 * `prepareStep` / `onStepFinish` and answers with `steps` / `text` /
 * `finishReason` / `totalUsage`.
 */
vi.mock('../../lib/firestore.js', () => ({
  getDb: () => {
    throw new Error('assistant-loop.test.ts must not reach Firestore');
  },
  collections: {},
}));

// `carriesSubstance` is imported, never re-implemented: an earlier version of this
// file kept its own copy, the copy left out the `redacted-reasoning` clause, and so
// no test here could fail on it. A test that asserts against a double of the
// predicate certifies the double.
const { runAssistantLoop, carriesSubstance, executedToolCallIds, isDanglingToolCallTurn, formatBudgetLine } =
  await import('./assistant-loop.js');
const { AssistantRunCancelledError } = await import('./assistant-cancel-coordinator.js');
const { boundFailureMessage, ASSISTANT_BOUND_IDS, resolveAssistantBounds, toolStepBudget } =
  await import('./assistant-bounds.js');
const {
  ASSISTANT_ANSWER_RETRY_INSTRUCTION,
  ASSISTANT_ANSWER_RETRY_LENGTH_INSTRUCTION,
  ASSISTANT_FINAL_STEP_INSTRUCTION,
} = await import('./assistant-prompt.js');
const { classifyRunFailure } = await import('../orchestration/run-retry-policy.js');
type AnyReadToolDescriptor = import('./tool-registry.js').AnyReadToolDescriptor;
type GenerateTextFn = import('./assistant-loop.js').GenerateTextFn;

interface FakeStep {
  usage: { inputTokens?: number; outputTokens?: number };
  finishReason?: string;
}

interface StepDecision {
  toolChoice?: string;
  system?: string;
}

interface FakeCallArgs {
  tools: Record<string, { execute: (input: unknown) => Promise<unknown> }>;
  abortSignal?: AbortSignal;
  experimental_onStepStart?: () => void;
  onStepFinish?: (step: FakeStep) => void;
  prepareStep?: (options: { steps: unknown[]; stepNumber: number }) => StepDecision;
  stopWhen?: (options: { steps: unknown[] }) => boolean | PromiseLike<boolean>;
  maxOutputTokens?: number;
  system?: string;
  prompt?: string;
  /**
   * Set only by the answer retry, which replays the conversation instead of
   * re-sending the request. Every double below uses its presence to tell the
   * retry call from the first one, exactly as production does: the main
   * generation passes `prompt`, the retry passes `messages`.
   */
  messages?: FakeMessage[];
  /** Passed at call level by the retry, per step by `prepareStep` otherwise. */
  toolChoice?: string;
}

interface FakeMessage {
  role: string;
  content: unknown;
}

/**
 * The messages the SDK reports back for a settled generation
 * (`GenerateTextResult.response.messages`), which is where the retry gets the
 * tool results it must answer from.
 *
 * The doubles have to produce these, because a double that omits them makes the
 * retry impossible — `retryAnswerStep` declines to answer from an empty history —
 * and a test written against such a double would certify the pre-fix behaviour
 * while looking like it covered the fix.
 */
function toolStepMessages(
  toolName: string,
  count: number,
  /**
   * A whitespace-only text part alongside the tool calls, which is what a provider
   * that emits a preamble before calling a tool actually sends back. The turn is
   * KEPT for its tool calls, so the blank part rides along into the replay unless
   * something strips it — and Anthropic rejects the request over it.
   */
  blankPreamble = false,
): FakeMessage[] {
  return Array.from({ length: count }, (_unused, index) => [
    {
      role: 'assistant',
      content: [
        ...(blankPreamble ? [{ type: 'text', text: '  ' }] : []),
        { type: 'tool-call', toolCallId: `call_${index}`, toolName, input: {} },
      ],
    },
    {
      role: 'tool',
      content: [
        { type: 'tool-result', toolCallId: `call_${index}`, toolName, output: { rows: [index] } },
      ],
    },
  ]).flat();
}

/**
 * How a turn that produced no answer comes back from the provider. All three
 * shapes are real and all three reach the retry:
 *
 * - `no_parts`: the content array is empty;
 * - `blank_text`: a text part holding only whitespace. The SDK keeps it (it drops a
 *   text part only at `text.length === 0`, `ai/dist/index.js:3964`) and the
 *   Anthropic provider trims only the LAST block of the LAST message, which this is
 *   not once the retry's own user turn follows it — so it reaches the API, which
 *   rejects a whitespace-only text block outright;
 * - `reasoning_only`: the model thought and said nothing;
 * - `redacted_reasoning`: the same, with the thinking withheld by the provider. Its
 *   own shape because it is its own part type, and the predicate has to name both.
 */
type EmptyTurnShape = 'no_parts' | 'blank_text' | 'reasoning_only' | 'redacted_reasoning';

/** The trailing assistant turn. Shaped by `empty` when the step produced no text. */
function finalAssistantMessage(text: string, empty: EmptyTurnShape = 'no_parts'): FakeMessage {
  if (text.trim().length > 0) return { role: 'assistant', content: [{ type: 'text', text }] };
  const content = empty === 'no_parts'
    ? []
    : empty === 'blank_text'
      ? [{ type: 'text', text: text.length > 0 ? text : ' ' }]
      : empty === 'redacted_reasoning'
        ? [{ type: 'redacted-reasoning', data: 'AAAA' }]
        : [{ type: 'reasoning', text: 'The requester wants a count. I should count.' }];
  return { role: 'assistant', content };
}

/**
 * The turn a provider reports for a reserved step it spent on tool calls: the
 * preamble text plus a tool-call part that no tool result anywhere in the
 * history answers, because the tools were withheld and the call never ran.
 */
function danglingToolCallMessage(toolName: string, preamble: string): FakeMessage {
  return {
    role: 'assistant',
    content: [
      ...(preamble.trim().length > 0 ? [{ type: 'text', text: preamble }] : []),
      { type: 'tool-call', toolCallId: 'call_withheld', toolName, input: {} },
    ],
  };
}

interface FakeAnswer {
  text?: string;
  steps?: number;
  finishReason?: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}

/**
 * Builds a `generateText` double from a body that may drive the tools.
 *
 * It consults `prepareStep` for every step index it claims to have run, because
 * the real SDK does (`node_modules/ai/dist/index.js:4313`, `stepNumber:
 * steps.length`) and because `prepareStep` IS the seam that withholds the reads.
 * A double that skipped it ran the loop with the reservation permanently off and
 * could certify the opposite of production — an earlier version of this file did
 * exactly that and asserted `truncated === false` for a shape production reports
 * as withheld.
 *
 * One honest limitation of a single-shot double: the body runs to completion in
 * one go, so step 0 is prepared before it and the remaining step indices after
 * it, rather than interleaved. Tests that need the real interleaving (the reads
 * running out mid-attempt) drive `greedyModel` or `parallelModel` below, which
 * run the SDK's own loop.
 */
function fakeGenerate(
  body: (args: FakeCallArgs) => Promise<FakeAnswer>,
): { fn: GenerateTextFn; calls: FakeCallArgs[]; decisions: () => StepDecision[] } {
  const calls: FakeCallArgs[] = [];
  const decisions: StepDecision[] = [];
  const fn = (async (args: FakeCallArgs) => {
    calls.push(args);
    decisions.push((await args.prepareStep?.({ steps: [], stepNumber: 0 })) ?? {});
    const answer = await body(args);
    for (let stepNumber = 1; stepNumber < (answer.steps ?? 1); stepNumber += 1) {
      const steps = new Array(stepNumber).fill({});
      decisions.push((await args.prepareStep?.({ steps, stepNumber })) ?? {});
    }
    const usage = {
      inputTokens: answer.usage?.inputTokens ?? 10,
      outputTokens: answer.usage?.outputTokens ?? 5,
      totalTokens: answer.usage?.totalTokens ?? 15,
    };
    const text = answer.text ?? 'done';
    return {
      text,
      finishReason: answer.finishReason ?? 'stop',
      steps: new Array(answer.steps ?? 1).fill({ usage }),
      totalUsage: usage,
      response: { messages: [finalAssistantMessage(text)] },
    };
  }) as unknown as GenerateTextFn;
  return { fn, calls, decisions: () => decisions };
}

/**
 * A double that never consults `prepareStep` at all — the SDK option is still an
 * alias of `experimental_prepareStep` (`dist/index.js:4130`), and a wrapped model
 * could drop it. It reaches the ceiling on a step that emitted tool calls, with
 * the text the provider sent alongside them, which is what the loop must refuse
 * to store as an answer.
 */
function unpreparedModel(options: {
  toolName: string;
  textWithToolCalls: string;
  steps: number;
  /** What the model says when the reserved step is asked a second time. */
  answerOnRetry?: string;
  /** Models a wrapper that reports no conversation back. */
  omitResponseMessages?: boolean;
}): { fn: GenerateTextFn; retries: () => FakeCallArgs[] } {
  const retries: FakeCallArgs[] = [];
  const fn = (async (args: FakeCallArgs) => {
    if (args.messages !== undefined) {
      retries.push(args);
      return retryAnswer(args, options.answerOnRetry ?? '');
    }
    const steps: FakeStep[] = [];
    for (let i = 0; i < options.steps; i += 1) {
      await args.tools[options.toolName]!.execute({});
      steps.push({ usage: { inputTokens: 10, outputTokens: 5 }, finishReason: 'tool-calls' });
      args.onStepFinish?.(steps[steps.length - 1]!);
    }
    return {
      text: options.textWithToolCalls,
      finishReason: 'tool-calls',
      steps,
      totalUsage: { inputTokens: 10 * steps.length, outputTokens: 5 * steps.length },
      ...(options.omitResponseMessages
        ? {}
        : {
            response: {
              messages: [
                ...toolStepMessages(options.toolName, options.steps),
                finalAssistantMessage(options.textWithToolCalls),
              ],
            },
          }),
    };
  }) as unknown as GenerateTextFn;
  return { fn, retries: () => retries };
}

/**
 * A double that runs the SDK's own multi-step loop, so a test can drive the
 * attempt to its step ceiling the way a real run reaches it. Three behaviours
 * are modelled, all three read from the installed `ai` 6.0.168 bundle:
 *
 * - `prepareStep` is consulted before every step, and a returned
 *   `toolChoice: 'none'` leaves the model without tools for that step;
 * - the loop continues only while the last step emitted tool calls
 *   (`dist/index.js:4641`);
 * - `stopWhen` decides the ceiling, so the real `stepCountIs` is what stops this
 *   double rather than a number copied into the test.
 *
 * The model it drives is greedy on purpose: it spends every step it is allowed
 * to on one tool call, which is what a request that outgrows its budget looks
 * like. `ignoreToolChoice` models the provider that does not honour
 * `toolChoice`, because the loop must not depend on it doing so.
 */
function greedyModel(options: {
  toolName: string;
  answer: string;
  textWithToolCalls?: string;
  ignoreToolChoice?: boolean;
  /**
   * The calls the provider emitted past `toolChoice: 'none'` were NOT executed —
   * the tools were withheld — so the reported conversation ends on a dangling
   * tool-call turn with the preamble beside it. This is the production shape of
   * a reserved step spent on tool calls; without it, `ignoreToolChoice` alone
   * models an SDK that executed them anyway.
   */
  withholdIgnoredCalls?: boolean;
  /** What the model says when the reserved step is asked a second time. */
  answerOnRetry?: string;
  /** Models a wrapper that reports no conversation back for the retry to use. */
  omitResponseMessages?: boolean;
  /** The second ask emits tool calls anyway, so its text is a preamble. */
  retryIgnoresToolChoice?: boolean;
  /** Which shape the answerless reserved step reports back. */
  emptyTurn?: EmptyTurnShape;
  /** The tool-call turns come back with a whitespace-only preamble next to the calls. */
  blankPreamble?: boolean;
  /** The provider fails the second ask, after the reads have already happened. */
  retryThrows?: Error;
  /**
   * What the reserved step's OWN finish reason is, once it stops calling tools.
   * Defaults to `'stop'`; a test drives this to `'length'` to model issue #841
   * — the provider spending its output budget on thinking and cutting the
   * visible reply off before it finishes, with `options.answer` standing in
   * for whatever fragment survived the cut.
   */
  answerFinishReason?: string;
  /** As `answerFinishReason`, but for the second ask's own finish reason. */
  retryFinishReason?: string;
}): {
  fn: GenerateTextFn;
  decisions: () => StepDecision[];
  retries: () => FakeCallArgs[];
} {
  const decisions: StepDecision[] = [];
  const retries: FakeCallArgs[] = [];
  const fn = (async (args: FakeCallArgs) => {
    if (args.messages !== undefined) {
      retries.push(args);
      if (options.retryThrows) throw options.retryThrows;
      if (options.retryIgnoresToolChoice) {
        // A provider that reads past `toolChoice: 'none'` and calls a tool
        // anyway. Its text is a preamble to calls that will never run.
        const usage = { inputTokens: 8, outputTokens: 4 };
        args.onStepFinish?.({ usage, finishReason: 'tool-calls' });
        return {
          text: options.answerOnRetry ?? '',
          finishReason: 'tool-calls',
          steps: [{ usage }],
          totalUsage: { ...usage, totalTokens: 12 },
          response: { messages: [] },
        };
      }
      return retryAnswer(args, options.answerOnRetry ?? '', options.retryFinishReason);
    }
    const steps: FakeStep[] = [];
    let text = '';
    let toolSteps = 0;
    let endedOnWithheldCalls = false;
    for (;;) {
      const decision = (await args.prepareStep?.({ steps, stepNumber: steps.length })) ?? {};
      decisions.push(decision);
      const mayCallTools = options.ignoreToolChoice === true
        || (decision.toolChoice !== 'none' && args.toolChoice !== 'none');
      const usage = { inputTokens: 10, outputTokens: 5 };
      if (mayCallTools) {
        // A call emitted past a withheld toolset never executes; every other
        // call runs as normal and gets its result into the conversation.
        endedOnWithheldCalls = options.withholdIgnoredCalls === true
          && decision.toolChoice === 'none';
        if (!endedOnWithheldCalls) {
          await args.tools[options.toolName]!.execute({});
          toolSteps += 1;
        }
        text = options.textWithToolCalls ?? '';
        steps.push({ usage, finishReason: 'tool-calls' });
      } else {
        text = options.answer;
        steps.push({ usage, finishReason: options.answerFinishReason ?? 'stop' });
      }
      args.onStepFinish?.(steps[steps.length - 1]!);
      if (steps[steps.length - 1]!.finishReason !== 'tool-calls') break;
      if (await args.stopWhen?.({ steps })) break;
    }
    return {
      text,
      finishReason: steps[steps.length - 1]!.finishReason,
      steps,
      totalUsage: {
        inputTokens: 10 * steps.length,
        outputTokens: 5 * steps.length,
        totalTokens: 15 * steps.length,
      },
      ...(options.omitResponseMessages
        ? {}
        : {
            response: {
              messages: [
                ...toolStepMessages(options.toolName, toolSteps, options.blankPreamble),
                endedOnWithheldCalls
                  ? danglingToolCallMessage(options.toolName, text)
                  : finalAssistantMessage(text, options.emptyTurn),
              ],
            },
          }),
    };
  }) as unknown as GenerateTextFn;
  return { fn, decisions: () => decisions, retries: () => retries };
}

/**
 * One step, no tools, whatever the model has to say the second time. Shared by
 * the doubles so the retry call is modelled the same way everywhere.
 *
 * `finishReason` defaults to `'stop'`; a test overrides it to `'length'` to
 * model the rescue itself landing back on the output-token ceiling.
 */
function retryAnswer(args: FakeCallArgs, text: string, finishReason = 'stop') {
  const usage = { inputTokens: 8, outputTokens: 4 };
  args.onStepFinish?.({ usage, finishReason });
  return {
    text,
    finishReason,
    steps: [{ usage }],
    totalUsage: { ...usage, totalTokens: 12 },
    response: { messages: [finalAssistantMessage(text)] },
  };
}

/**
 * A double shaped after the CONFIGURED provider. `ARBITRA_LLM_PROVIDER=google`
 * (`scripts/deploy.sh`), and Gemini emits PARALLEL function calls: one step can
 * spend several of the tool-call allowance without spending several steps, so the
 * call budget — not the step ceiling — is what ends the reading first in
 * production. `callsPerStep` says how many calls each step emits; the tool
 * results are collected so a test can see what came back for a refused call.
 */
function parallelModel(options: {
  toolName: string;
  callsPerStep: readonly number[];
  answer: string;
  /** What the model says when the reserved step is asked a second time. */
  answerOnRetry?: string;
}): { fn: GenerateTextFn; results: () => unknown[]; retries: () => FakeCallArgs[] } {
  const results: unknown[] = [];
  const retries: FakeCallArgs[] = [];
  const fn = (async (args: FakeCallArgs) => {
    if (args.messages !== undefined) {
      retries.push(args);
      return retryAnswer(args, options.answerOnRetry ?? '');
    }
    const steps: FakeStep[] = [];
    let text = '';
    let toolCalls = 0;
    for (;;) {
      const decision = (await args.prepareStep?.({ steps, stepNumber: steps.length })) ?? {};
      const usage = { inputTokens: 10, outputTokens: 5 };
      if (decision.toolChoice === 'none' || args.toolChoice === 'none') {
        text = options.answer;
        steps.push({ usage, finishReason: 'stop' });
      } else {
        const calls = options.callsPerStep[steps.length] ?? 1;
        toolCalls += calls;
        results.push(
          ...(await Promise.all(
            Array.from({ length: calls }, () => args.tools[options.toolName]!.execute({})),
          )),
        );
        steps.push({ usage, finishReason: 'tool-calls' });
      }
      args.onStepFinish?.(steps[steps.length - 1]!);
      if (steps[steps.length - 1]!.finishReason !== 'tool-calls') break;
      if (await args.stopWhen?.({ steps })) break;
    }
    return {
      text,
      finishReason: steps[steps.length - 1]!.finishReason,
      steps,
      totalUsage: {
        inputTokens: 10 * steps.length,
        outputTokens: 5 * steps.length,
        totalTokens: 15 * steps.length,
      },
      response: {
        messages: [
          ...toolStepMessages(options.toolName, toolCalls),
          finalAssistantMessage(text),
        ],
      },
    };
  }) as unknown as GenerateTextFn;
  return { fn, results: () => results, retries: () => retries };
}

function descriptor(
  read: () => Promise<Record<string, unknown>>,
  name = 'arbitra_probe_read',
): AnyReadToolDescriptor {
  return {
    name,
    description: 'Probe read tool.',
    effect: 'read',
    inputSchema: z.object({}),
    riskClass: 'read_scoped',
    connector: 'arbitra',
    requiredScopes: ['case:read'],
    summariseInput: () => ({}),
    read,
  };
}

function bounds(overrides: Partial<ReturnType<typeof resolveAssistantBounds>> = {}) {
  return { ...resolveAssistantBounds(), ...overrides };
}

function input(
  generate: GenerateTextFn,
  descriptors: AnyReadToolDescriptor[],
  overrides: Partial<ReturnType<typeof resolveAssistantBounds>> = {},
) {
  return {
    model: {} as LanguageModel,
    system: 'system',
    prompt: 'prompt',
    descriptors,
    bounds: bounds(overrides),
    requesterUserId: 'usr_requester',
    caseId: 'case-loop',
    generate,
  };
}

describe('runAssistantLoop — the happy path', () => {
  it('returns the answer, the trace and the usage when the model finishes on its own', async () => {
    const read = vi.fn(async () => ({ rows: [1] }));
    const tool = descriptor(read);
    const { fn, calls } = fakeGenerate(async (args) => {
      await args.tools[tool.name]!.execute({});
      return { text: 'Here is the answer.', steps: 2, finishReason: 'stop' };
    });

    const result = await runAssistantLoop(input(fn, [tool]));

    expect(result.outcome).toBe('answered');
    expect(result.answer).toBe('Here is the answer.');
    expect(result.bound).toBeNull();
    expect(result.reads_withheld).toBe(false);
    expect(result.trace).toHaveLength(1);
    expect(result.trace[0]!.name).toBe(tool.name);
    expect(result.total_tokens).toBe(15);
    // The prompt reaches the model; nothing about it is returned for persistence.
    expect(calls[0]!.system).toBe('system');
    expect(calls[0]!.maxOutputTokens).toBe(bounds().maxOutputTokens);
  });

  it('passes only the descriptors it was given as tools', async () => {
    const tool = descriptor(async () => ({}));
    const { fn, calls } = fakeGenerate(async () => ({ text: 'ok' }));

    await runAssistantLoop(input(fn, [tool]));
    expect(Object.keys(calls[0]!.tools)).toEqual([tool.name]);

    const { fn: fn2, calls: calls2 } = fakeGenerate(async () => ({ text: 'ok' }));
    await runAssistantLoop(input(fn2, []));
    expect(Object.keys(calls2[0]!.tools)).toEqual([]);
  });
});

describe('runAssistantLoop — persisted cancellation fences', () => {
  it('pre-generate cancellation fence: wrapper without prepareStep gets zero calls and complete usage', async () => {
    // This wrapper deliberately never consults `prepareStep`. Removing the
    // standalone `await input.checkCancellation?.()` immediately before the
    // initial `generate(...)` invokes it, recreating the wrapper gap exactly.
    const generate = vi.fn(async () => ({
      text: 'must not run',
      finishReason: 'stop',
      steps: [],
      totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    })) as unknown as GenerateTextFn;

    const result = await runAssistantLoop({
      ...input(generate, []),
      checkCancellation: async () => {
        throw new AssistantRunCancelledError('run_cancelled', 1);
      },
    });

    expect(generate).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      outcome: 'cancelled',
      trace: [],
      steps: 0,
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      cancellation_usage_status: 'complete',
    });
  });

  it('next-step cancellation fence: retains the settled read and starts no later model or read', async () => {
    const read = vi.fn(async () => ({ rows: ['settled'] }));
    const tool = descriptor(read);
    let cancellationCommitted = false;
    const providerCall = vi.fn();
    const generate = (async (args: FakeCallArgs) => {
      await args.prepareStep?.({ steps: [], stepNumber: 0 });
      args.experimental_onStepStart?.();
      providerCall();
      await args.tools[tool.name]!.execute({});
      args.onStepFinish?.({
        usage: { inputTokens: 10, outputTokens: 5 },
        finishReason: 'tool-calls',
      });

      cancellationCommitted = true;
      // Removing the durable check from the NEXT `prepareStep` starts this
      // second model call; removing the tool fence as well executes a second
      // read. Both regressions are observable below, while the first trace stays.
      await args.prepareStep?.({ steps: [{}], stepNumber: 1 });
      args.experimental_onStepStart?.();
      providerCall();
      await args.tools[tool.name]!.execute({});
      args.onStepFinish?.({
        usage: { inputTokens: 10, outputTokens: 5 },
        finishReason: 'stop',
      });
      return {
        text: 'must not run',
        finishReason: 'stop',
        steps: [],
        totalUsage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
      };
    }) as unknown as GenerateTextFn;

    const result = await runAssistantLoop({
      ...input(generate, [tool]),
      checkCancellation: async () => {
        if (cancellationCommitted) throw new AssistantRunCancelledError('run_cancelled', 2);
      },
    });

    expect(providerCall).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      outcome: 'cancelled',
      steps: 1,
      finish_reason: 'tool-calls',
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
      cancellation_usage_status: 'complete',
    });
    expect(result.trace).toHaveLength(1);
    expect(result.trace[0]).toMatchObject({ name: tool.name, outcome: 'ok' });
  });

  it('tool beforeExecute cancellation fence: a model response emitted after cancel cannot start another read', async () => {
    const read = vi.fn(async () => ({ rows: ['settled'] }));
    const tool = descriptor(read);
    let cancellationCommitted = false;
    const generate = (async (args: FakeCallArgs) => {
      await args.prepareStep?.({ steps: [], stepNumber: 0 });
      args.experimental_onStepStart?.();
      await args.tools[tool.name]!.execute({});
      args.onStepFinish?.({
        usage: { inputTokens: 10, outputTokens: 5 },
        finishReason: 'tool-calls',
      });

      await args.prepareStep?.({ steps: [{}], stepNumber: 1 });
      args.experimental_onStepStart?.();
      // The second provider response and the cancellation commit race. Removing
      // `await beforeExecute?.()` from the real tool wrapper performs this read.
      cancellationCommitted = true;
      await args.tools[tool.name]!.execute({});
      throw new Error('unreachable after the persisted tool fence');
    }) as unknown as GenerateTextFn;

    const result = await runAssistantLoop({
      ...input(generate, [tool]),
      checkCancellation: async () => {
        if (cancellationCommitted) throw new AssistantRunCancelledError('run_cancelled', 3);
      },
    });

    expect(read).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe('cancelled');
    expect(result.trace).toHaveLength(1);
    expect(result.cancellation_usage_status).toBe('partial');
  });

  it('in-process abort accounting: reports partial only while a started model call is unsettled', async () => {
    const cancellation = new AbortController();
    let reportStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      reportStarted = resolve;
    });
    const generate = (async (args: FakeCallArgs) => {
      await args.prepareStep?.({ steps: [], stepNumber: 0 });
      args.experimental_onStepStart?.();
      reportStarted();
      await new Promise<never>((_resolve, reject) => {
        const fail = () => reject(Object.assign(new Error('provider aborted'), { name: 'AbortError' }));
        if (args.abortSignal?.aborted) fail();
        else args.abortSignal?.addEventListener('abort', fail, { once: true });
      });
    }) as unknown as GenerateTextFn;

    const pending = runAssistantLoop({
      ...input(generate, []),
      checkCancellation: async () => {},
      cancellationSignal: cancellation.signal,
    });
    await started;
    // Removing the signal propagation leaves the provider hanging; counting a
    // started call as settled without `onStepFinish` incorrectly says complete.
    cancellation.abort(new AssistantRunCancelledError('run_cancelled', 4));

    const result = await pending;

    expect(result).toMatchObject({
      outcome: 'cancelled',
      steps: 0,
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      cancellation_usage_status: 'partial',
    });
  });
});

describe('runAssistantLoop — an aborting bound ends the attempt, never a partial answer', () => {
  it('stops at the per-call bound', async () => {
    const tool = descriptor(
      () => new Promise((resolve) => setTimeout(() => resolve({ late: true }), 200)),
    );
    const { fn } = fakeGenerate(async (args) => {
      await args.tools[tool.name]!.execute({});
      return { text: 'partial answer' };
    });

    const result = await runAssistantLoop(input(fn, [tool], { toolCallLimitMs: 5 }));

    expect(result.outcome).toBe('bound_exceeded');
    expect(result.bound).toBe('tool_call_limit');
    expect(result.answer).toBe('');
  });

  it('stops at the token budget', async () => {
    const { fn } = fakeGenerate(async (args) => {
      args.onStepFinish?.({ usage: { inputTokens: 900, outputTokens: 200 } });
      return { text: 'partial answer' };
    });

    const result = await runAssistantLoop(input(fn, [], { tokenBudget: 1000 }));

    expect(result.outcome).toBe('bound_exceeded');
    expect(result.bound).toBe('token_budget');
    expect(result.answer).toBe('');
  });

  it('stops at the attempt wall clock', async () => {
    const { fn } = fakeGenerate(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return { text: 'answer produced after the deadline' };
    });

    const result = await runAssistantLoop(input(fn, [], { attemptWallClockMs: 5 }));

    expect(result.outcome).toBe('bound_exceeded');
    expect(result.bound).toBe('attempt_wall_clock');
    expect(result.answer).toBe('');
  });

  it('reports how far the attempt actually got when a bound aborts it', async () => {
    const tool = descriptor(async () => ({ ok: true }));
    const { fn } = fakeGenerate(async (args) => {
      await args.tools[tool.name]!.execute({});
      await args.tools[tool.name]!.execute({});
      args.onStepFinish?.({ usage: { inputTokens: 10, outputTokens: 5 }, finishReason: 'stop' });
      args.onStepFinish?.({
        usage: { inputTokens: 600, outputTokens: 600 },
        finishReason: 'tool-calls',
      });
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });

    const result = await runAssistantLoop(input(fn, [tool], { tokenBudget: 1000 }));

    expect(result.bound).toBe('token_budget');
    // The reads are on the record, so the step count and the reason must be too;
    // `0` / `unknown` would describe an attempt that never ran.
    expect(result.steps).toBe(2);
    expect(result.finish_reason).toBe('tool-calls');
    expect(result.trace).toHaveLength(2);
  });

  it('hands the abort signal to the model call so a bound can interrupt it', async () => {
    const tool = descriptor(
      () => new Promise((resolve) => setTimeout(() => resolve({ late: true }), 200)),
    );
    let signalWasAborted = false;
    const { fn } = fakeGenerate(async (args) => {
      await args.tools[tool.name]!.execute({});
      signalWasAborted = args.abortSignal?.aborted ?? false;
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });

    const result = await runAssistantLoop(input(fn, [tool], { toolCallLimitMs: 5 }));

    expect(signalWasAborted).toBe(true);
    expect(result.outcome).toBe('bound_exceeded');
    expect(result.bound).toBe('tool_call_limit');
  });

  it('propagates a genuine model error instead of mislabelling it as a bound', async () => {
    const { fn } = fakeGenerate(async () => {
      throw new Error('provider returned 401 unauthorized');
    });

    await expect(runAssistantLoop(input(fn, []))).rejects.toThrow(/401 unauthorized/);
  });
});

describe('runAssistantLoop — a spent read budget answers with what it has', () => {
  it('reserves the last step for the answer and records that its reads were withheld', async () => {
    const read = vi.fn(async () => ({ rows: [1] }));
    const tool = descriptor(read);
    const { fn } = greedyModel({
      toolName: tool.name,
      answer: 'I could not check the third case. Of the two I read, both are open.',
    });

    const result = await runAssistantLoop(input(fn, [tool], { maxSteps: 4 }));

    // The whole point: an answer, not a dead run.
    expect(result.outcome).toBe('answered');
    expect(result.answer).toContain('could not check');
    // The fact, not a verdict: this step had no reads, and the step ceiling is why.
    expect(result.reads_withheld).toBe(true);
    expect(result.reads_withheld_reason).toBe('step_budget');
    // Not a bound: the executor must complete this case, not fail it.
    expect(result.bound).toBeNull();
    // Four steps, three of them usable for tools, the fourth spent on answering.
    expect(read).toHaveBeenCalledTimes(3);
    expect(result.trace).toHaveLength(3);
    expect(result.steps).toBe(4);
    expect(result.finish_reason).toBe('stop');
  });

  it('records the withholding for a model that spent every step and then answered', async () => {
    // The modal budget-boundary case: the last permitted read returned everything
    // the request needed, so this answer is COMPLETE — and the loop cannot know
    // that. It reports what it did (the reads were gone) and says nothing about
    // what the answer is worth.
    const { fn } = fakeGenerate(async () => ({
      text: 'Complete answer on the last step.',
      steps: 3,
      finishReason: 'stop',
    }));

    const result = await runAssistantLoop(input(fn, [], { maxSteps: 3 }));

    expect(result.outcome).toBe('answered');
    expect(result.answer).toBe('Complete answer on the last step.');
    expect(result.reads_withheld).toBe(true);
    expect(result.reads_withheld_reason).toBe('step_budget');
    // No bound, no marker on the text, nothing that asserts the answer fell short.
    expect(result.bound).toBeNull();
  });

  it('withholds nothing from a model that answers before the reserved step', async () => {
    // The only shape that yields `reads_withheld: false` with tools on offer.
    const { fn, decisions } = fakeGenerate(async () => ({
      text: 'Answered with a step to spare.',
      steps: 2,
      finishReason: 'stop',
    }));
    const usedBounds = bounds({ maxSteps: 3 });

    const result = await runAssistantLoop(input(fn, [], { maxSteps: 3 }));

    expect(result.outcome).toBe('answered');
    expect(result.reads_withheld).toBe(false);
    expect(result.reads_withheld_reason).toBeNull();
    // Every step now carries the live budget line (no tool ever ran here, so
    // the call count stays 0/Y across both — only the step number moves).
    expect(decisions()).toEqual([
      { system: `system\n\n${formatBudgetLine(0, usedBounds, 0)}` },
      { system: `system\n\n${formatBudgetLine(1, usedBounds, 0)}` },
    ]);
  });

  it('tells the model on the reserved step to answer now, without naming a bound', async () => {
    const tool = descriptor(async () => ({ ok: true }));
    const { fn, decisions } = greedyModel({ toolName: tool.name, answer: 'Partial answer.' });

    await runAssistantLoop(input(fn, [tool], { maxSteps: 3 }));

    const perStep = decisions();
    expect(perStep).toHaveLength(3);
    // Tool steps carry the live budget line but stay otherwise unconstrained;
    // only the reserved one additionally withholds the tools.
    expect(perStep[0]!.toolChoice).toBeUndefined();
    expect(perStep[1]!.toolChoice).toBeUndefined();
    expect(perStep[2]!.toolChoice).toBe('none');
    expect(perStep[2]!.system).toContain(ASSISTANT_FINAL_STEP_INSTRUCTION);
  });

  it("shows the model its own live step and tool-call spend every turn, with numbers that move as it reads", async () => {
    // The quantified root cause behind four live dev canaries' exploratory
    // padding: the model never saw its own budget. Step 1 and step 3 (the
    // reserved one, maxSteps: 3) are asserted with DIFFERENT tool-call counts,
    // because two reads happen in between — a fixture that pinned the same
    // count at both steps could pass by accident.
    const tool = descriptor(async () => ({ ok: true }));
    const { fn, decisions } = greedyModel({ toolName: tool.name, answer: 'Partial answer.' });
    const usedBounds = bounds({ maxSteps: 3 });

    await runAssistantLoop(input(fn, [tool], { maxSteps: 3 }));

    const perStep = decisions();
    expect(perStep).toHaveLength(3);
    const y = usedBounds.maxToolCalls;
    // Step 1 (display): nothing read yet.
    expect(perStep[0]!.system).toBe(`system\n\n${formatBudgetLine(0, usedBounds, 0)}`);
    expect(perStep[0]!.system).toContain(`Budget: step 1/3, tool calls 0/${y}.`);
    // Step 2: one read happened on step 1.
    expect(perStep[1]!.system).toBe(`system\n\n${formatBudgetLine(1, usedBounds, 1)}`);
    expect(perStep[1]!.system).toContain(`Budget: step 2/3, tool calls 1/${y}.`);
    // Step 3, the reserved one: two reads now on the record, and the count
    // differs from step 1's — the same live counter, read at a later point.
    expect(perStep[2]!.system).toContain(`${formatBudgetLine(2, usedBounds, 2)}`);
    expect(perStep[2]!.system).toContain(`Budget: step 3/3, tool calls 2/${y}.`);
    expect(perStep[2]!.system).toContain(ASSISTANT_FINAL_STEP_INSTRUCTION);
  });

  /**
   * The reserved step ending in TOOL CALLS is the same defect as it ending blank —
   * the step that had to answer did not answer — so it gets the same second ask.
   * It used to fail the attempt outright, which left the #769 rescue unreachable
   * on exactly the runs where the provider read past `toolChoice: 'none'`: six
   * completed reads, `bound:max_steps`, `answer_retried: false`.
   */
  it('gives a reserved step spent on tool calls the same second ask, and keeps its answer', async () => {
    const tool = descriptor(async () => ({ ok: true }));
    const { fn, retries } = greedyModel({
      toolName: tool.name,
      answer: 'never reached',
      textWithToolCalls: 'Let me check the remaining two cases.',
      ignoreToolChoice: true,
      withholdIgnoredCalls: true,
      answerOnRetry: 'Both remaining cases are open.',
    });

    const result = await runAssistantLoop(input(fn, [tool], { maxSteps: 3 }));

    expect(retries()).toHaveLength(1);
    expect(result.outcome).toBe('answered');
    expect(result.answer).toBe('Both remaining cases are open.');
    expect(result.answer_retried).toBe(true);
    expect(result.reads_withheld).toBe(true);
    expect(result.bound).toBeNull();
    // A rescued attempt records no discarded preamble: the answer is the record.
    expect(result.discarded_preamble).toBeUndefined();
    // Two executed reads; the withheld calls of the reserved step never ran.
    expect(result.trace).toHaveLength(2);

    // The un-executed tool-call turn is NOT replayed to the second ask: a turn
    // with tool calls and no tool results is transport poison, the same class as
    // the blank text part. Production's own predicate decides, not a copy of it.
    const messages = retries()[0]!.messages! as import('ai').ModelMessage[];
    const executed = executedToolCallIds(messages);
    expect(messages.filter((message) => isDanglingToolCallTurn(message, executed))).toHaveLength(0);
    // The preamble travelled nowhere: not into the replay, not into the answer.
    expect(JSON.stringify(messages)).not.toContain('Let me check');
    // The executed reads' results are still what the ask rests on.
    expect(messages[messages.length - 2]!.role).toBe('tool');
  });

  it('records the discarded preamble when the second ask also produces nothing', async () => {
    const tool = descriptor(async () => ({ ok: true }));
    const { fn, retries } = greedyModel({
      toolName: tool.name,
      answer: 'never reached',
      textWithToolCalls: 'Let me check the remaining two cases.',
      ignoreToolChoice: true,
      withholdIgnoredCalls: true,
      answerOnRetry: '',
    });

    const result = await runAssistantLoop(input(fn, [tool], { maxSteps: 3 }));

    // Text a model emits WITH tool calls is a preamble to those calls, and the
    // calls never ran. Storing it as the governed answer would make the case's
    // task_result a sentence about what the model was about to do — but it was
    // the last thing the model said, so the failure carries it as what it is.
    expect(retries()).toHaveLength(1);
    expect(result.outcome).toBe('bound_exceeded');
    expect(result.bound).toBe('max_steps');
    expect(result.answer).toBe('');
    expect(result.answer_retried).toBe(true);
    expect(result.discarded_preamble).toBe('Let me check the remaining two cases.');
    expect(result.trace).toHaveLength(2);
  });

  it('clips the discarded preamble rather than carrying arbitrary length into the event', async () => {
    const tool = descriptor(async () => ({ ok: true }));
    const { fn } = greedyModel({
      toolName: tool.name,
      answer: 'never reached',
      textWithToolCalls: 'x'.repeat(400),
      ignoreToolChoice: true,
      withholdIgnoredCalls: true,
      answerOnRetry: '',
    });

    const result = await runAssistantLoop(input(fn, [tool], { maxSteps: 3 }));

    expect(result.discarded_preamble).toHaveLength(300);
  });

  it('retries the same way when the provider executed the ignored calls anyway', async () => {
    // The other real shape behind `finishReason: 'tool-calls'`: the SDK ran the
    // calls the provider emitted past `toolChoice: 'none'`, so their results ARE
    // in the conversation, nothing dangles, and the replay keeps all of them.
    const tool = descriptor(async () => ({ ok: true }));
    const { fn, retries } = greedyModel({
      toolName: tool.name,
      answer: 'never reached',
      textWithToolCalls: 'Let me check the remaining two cases.',
      ignoreToolChoice: true,
      answerOnRetry: 'All three cases are open.',
    });

    const result = await runAssistantLoop(input(fn, [tool], { maxSteps: 3 }));

    expect(retries()).toHaveLength(1);
    expect(result.outcome).toBe('answered');
    expect(result.answer).toBe('All three cases are open.');
    // All three reads ran and stay on the record and in the replay.
    expect(result.trace).toHaveLength(3);
    const parts = retries()[0]!
      .messages!.filter((message) => Array.isArray(message.content))
      .flatMap((message) => message.content as { type?: string }[]);
    expect(parts.filter((part) => part.type === 'tool-result')).toHaveLength(3);
  });

  it('asks a second time even when nothing ever consulted prepareStep', async () => {
    // Models an SDK or wrapper that drops the option: the reservation never
    // happens, the ceiling lands on a tool step, and `result.text` is whatever
    // came with those calls. The second ask fires here too — the trigger is the
    // tool-calls finish, not the withholding — and when it also produces nothing
    // the attempt fails with the preamble on the record instead of stored.
    const tool = descriptor(async () => ({ ok: true }));
    const { fn, retries } = unpreparedModel({
      toolName: tool.name,
      textWithToolCalls: 'Let me check the remaining two cases.',
      steps: 3,
    });

    const result = await runAssistantLoop(input(fn, [tool], { maxSteps: 3 }));

    expect(retries()).toHaveLength(1);
    expect(result.outcome).toBe('bound_exceeded');
    expect(result.bound).toBe('max_steps');
    expect(result.answer).toBe('');
    expect(result.answer_retried).toBe(true);
    expect(result.discarded_preamble).toBe('Let me check the remaining two cases.');
    expect(result.reads_withheld).toBe(false);
    expect(result.trace).toHaveLength(3);
  });

  /**
   * The predicate the replay filter runs on, pinned clause by clause — same rule
   * as `carriesSubstance` below: the behavioural tests cover the shapes the
   * doubles produce, the direct assertions cover every clause.
   */
  it('counts a tool-call turn as dangling exactly when a call of its has no result', () => {
    const answered = {
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: 'call_0', toolName: 'x', input: {} }],
    } as import('ai').ModelMessage;
    const dangling = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Let me check.' },
        { type: 'tool-call', toolCallId: 'call_9', toolName: 'x', input: {} },
      ],
    } as import('ai').ModelMessage;
    const idless = {
      role: 'assistant',
      content: [{ type: 'tool-call', toolName: 'x', input: {} }],
    } as import('ai').ModelMessage;
    const toolResult = {
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: 'call_0', toolName: 'x', output: {} }],
    } as import('ai').ModelMessage;

    const executed = executedToolCallIds([answered, toolResult, dangling, idless]);
    expect(executed).toEqual(new Set(['call_0']));
    // Pairing is by id: the answered call is kept, the unanswered one is not.
    expect(isDanglingToolCallTurn(answered, executed)).toBe(false);
    expect(isDanglingToolCallTurn(dangling, executed)).toBe(true);
    // A call with no id can never have a result attached; it dangles by definition.
    expect(isDanglingToolCallTurn(idless, executed)).toBe(true);
    // Only assistant turns can dangle; a text turn and a tool turn never do.
    expect(isDanglingToolCallTurn(toolResult, executed)).toBe(false);
    expect(
      isDanglingToolCallTurn(
        { role: 'assistant', content: [{ type: 'text', text: 'done' }] } as import('ai').ModelMessage,
        executed,
      ),
    ).toBe(false);
  });

  it('still fails at the step bound when both asks for the answer produced no text', async () => {
    const read = vi.fn(async () => ({ ok: true }));
    const tool = descriptor(read);
    const { fn, retries } = greedyModel({ toolName: tool.name, answer: '   ' });

    const result = await runAssistantLoop(input(fn, [tool], { maxSteps: 3 }));

    // Asked twice and still nothing to keep, so the residual failure path — but
    // now a failure the attempt earned, and the reads that were paid for are
    // still reported.
    expect(retries()).toHaveLength(1);
    expect(result.outcome).toBe('bound_exceeded');
    expect(result.bound).toBe('max_steps');
    expect(result.answer).toBe('');
    expect(result.answer_retried).toBe(true);
    expect(result.trace).toHaveLength(2);
    // The three steps the ceiling allowed, and no more: the second ask is a model
    // call the ceiling did not count, and `answer_retried` above is what reports it.
    expect(result.steps).toBe(3);
  });
});

/**
 * The reserved answer step ran, inside its allowance, and emitted nothing. That is
 * not a bound being hit — and two of the first five real runs died there, so it is
 * not the rare residual it was taken for either. The remedy is to ask again,
 * plainly, and the properties that make it safe are what this block pins: the ask
 * carries the reads already made, it gets no tools, it happens once, and if it is
 * also empty the attempt fails rather than having an answer written for it.
 */
describe('runAssistantLoop — the reserved answer step gets a second, plainer ask', () => {
  it('keeps the answer the second ask produces, and records that it was needed', async () => {
    const read = vi.fn(async () => ({ ok: true }));
    const tool = descriptor(read);
    const { fn, retries } = greedyModel({
      toolName: tool.name,
      answer: '',
      answerOnRetry: 'Two cases are open: case-a and case-b.',
    });

    const result = await runAssistantLoop(input(fn, [tool], { maxSteps: 3 }));

    expect(result.outcome).toBe('answered');
    expect(result.answer).toBe('Two cases are open: case-a and case-b.');
    expect(result.answer_retried).toBe(true);
    // Still a degraded attempt: the reads were withheld, and that fact is
    // unchanged by which ask produced the text.
    expect(result.reads_withheld).toBe(true);
    expect(result.reads_withheld_reason).toBe('step_budget');
    expect(result.bound).toBeNull();
    expect(retries()).toHaveLength(1);
  });

  it('asks with the reads already made, not with the request alone', async () => {
    const tool = descriptor(async () => ({ rows: ['a'] }));
    const { fn, retries } = greedyModel({
      toolName: tool.name,
      answer: '',
      answerOnRetry: 'One case is open.',
    });

    await runAssistantLoop(input(fn, [tool], { maxSteps: 3 }));

    const retry = retries()[0]!;
    // The tool results are what the answer has to come from. A retry that resent
    // only the request would ask the model to answer with its reads discarded,
    // which turns a missing answer into a groundless one.
    const roles = retry.messages!.map((message) => message.role);
    expect(roles).toContain('tool');
    expect(roles[0]).toBe('user');
    expect(roles[roles.length - 1]).toBe('user');
    expect(retry.messages![roles.length - 1]!.content).toBe(ASSISTANT_ANSWER_RETRY_INSTRUCTION);
    // The empty assistant turn being retried is dropped: a message with no parts
    // is what providers reject.
    expect(
      retry.messages!.filter(
        (message) => message.role === 'assistant' && (message.content as unknown[]).length === 0,
      ),
    ).toHaveLength(0);
  });

  /**
   * The turn being retried must not be in the history the retry replays, whichever
   * shape it came back as. Replaying it hands the model, as its most recent turn,
   * exactly the shape the second ask exists to escape — and for the whitespace
   * variant it is worse than useless: Anthropic rejects a text block that holds only
   * whitespace, so the second ask fails with a 400 on the very run it was added to
   * rescue. Dropping the turn also leaves the history ending on the tool results,
   * which is where the answer has to come from.
   */
  it.each([
    ['a turn with no parts at all', 'no_parts' as EmptyTurnShape, ''],
    ['a turn holding a single space', 'blank_text' as EmptyTurnShape, ' '],
    ['a turn that only thought', 'reasoning_only' as EmptyTurnShape, ''],
    ['a turn whose thinking was redacted', 'redacted_reasoning' as EmptyTurnShape, ''],
  ])('replays the reads but not %s', async (_name, emptyTurn, answer) => {
    const tool = descriptor(async () => ({ rows: ['a'] }));
    const { fn, retries } = greedyModel({
      toolName: tool.name,
      answer,
      emptyTurn,
      answerOnRetry: 'One case is open.',
    });

    const result = await runAssistantLoop(input(fn, [tool], { maxSteps: 3 }));

    expect(result.answer).toBe('One case is open.');
    const messages = retries()[0]!.messages!;
    // Production's own predicate, imported rather than copied: the copy that used
    // to stand here omitted the redacted-reasoning clause, so this assertion could
    // not fail for a shape production kept in the replay.
    const substantive = (content: unknown): boolean =>
      Array.isArray(content) && content.some(carriesSubstance);
    expect(
      messages.filter((message) => message.role === 'assistant' && !substantive(message.content)),
    ).toHaveLength(0);
    // What the answer rests on is the last thing the model sees before the ask.
    expect(messages[messages.length - 2]!.role).toBe('tool');
  });

  /**
   * The predicate itself, pinned clause by clause. The behavioural test above
   * exercises it through a run, which is what matters — but it can only cover the
   * shapes a double produces, and the clause that used to go uncovered was one no
   * double emitted. Asserting the production function directly means every clause
   * has a test that fails when the clause goes.
   */
  it('counts each part shape as substance or not', () => {
    expect(carriesSubstance({ type: 'text', text: 'One case is open.' })).toBe(true);
    expect(carriesSubstance({ type: 'text', text: '  ' })).toBe(false);
    expect(carriesSubstance({ type: 'text' })).toBe(false);
    // Thinking is not saying, withheld thinking least of all.
    expect(carriesSubstance({ type: 'reasoning', text: 'I should count.' })).toBe(false);
    expect(carriesSubstance({ type: 'redacted-reasoning', data: 'AAAA' })).toBe(false);
    // What the tool results attach to, and what the answer comes from.
    expect(carriesSubstance({ type: 'tool-call', toolName: 'x', input: {} })).toBe(true);
    expect(carriesSubstance({ type: 'tool-result', toolName: 'x', output: {} })).toBe(true);
    // An unrecognised part is more likely a payload than an empty turn in disguise.
    expect(carriesSubstance({ type: 'a-part-type-from-a-later-sdk' })).toBe(true);
  });

  /**
   * A turn can be worth replaying AND carry a part the provider refuses. A model
   * that says something whitespace-only before calling a tool leaves that block in
   * the turn the tool results attach to, and Anthropic answers 400 `text content
   * blocks must contain non-whitespace text` for any such block, not just a
   * trailing one — so the second ask would die on the transport for a reason that
   * has nothing to do with the answer. Dropping the turn is not the remedy: its
   * tool calls are what the results attach to.
   */
  it('strips a blank text part from a tool-call turn it keeps', async () => {
    const tool = descriptor(async () => ({ rows: ['a'] }));
    const { fn, retries } = greedyModel({
      toolName: tool.name,
      answer: '',
      blankPreamble: true,
      answerOnRetry: 'One case is open.',
    });

    const result = await runAssistantLoop(input(fn, [tool], { maxSteps: 3 }));

    expect(result.answer).toBe('One case is open.');
    const messages = retries()[0]!.messages!;
    const parts = messages
      .filter((message) => Array.isArray(message.content))
      .flatMap((message) => message.content as { type?: string; text?: string }[]);
    // Nothing whitespace-only survives anywhere in the replayed history …
    expect(
      parts.filter((part) => part.type === 'text' && (part.text ?? '').trim().length === 0),
    ).toHaveLength(0);
    // … and the calls the results attach to are still there, both of them.
    expect(parts.filter((part) => part.type === 'tool-call')).toHaveLength(2);
    expect(parts.filter((part) => part.type === 'tool-result')).toHaveLength(2);
    expect(messages[messages.length - 2]!.role).toBe('tool');
  });

  /**
   * The second ask is a best-effort extra on an attempt that had already failed to
   * produce text, so a provider error there must not cost the run its record.
   * Rethrowing lands in the executor's `model_call_failed` path, which has no loop
   * result to take `tool_call_records` or `bounds` from — two completed reads would
   * vanish from the audit trail — and a 5xx in the message would classify the whole
   * attempt as retryable, re-running them.
   */
  it('keeps the trace when the provider fails the second ask', async () => {
    const read = vi.fn(async () => ({ ok: true }));
    const tool = descriptor(read);
    const { fn, retries } = greedyModel({
      toolName: tool.name,
      answer: '',
      retryThrows: new Error('provider returned 503 service unavailable'),
    });

    const result = await runAssistantLoop(input(fn, [tool], { maxSteps: 3 }));

    expect(retries()).toHaveLength(1);
    // Where the attempt was already headed when the first ask came back empty.
    expect(result.outcome).toBe('bound_exceeded');
    expect(result.bound).toBe('max_steps');
    expect(result.answer).toBe('');
    // The two reads made on the requester's behalf are still on the record.
    expect(read).toHaveBeenCalledTimes(2);
    expect(result.trace).toHaveLength(2);
    expect(result.answer_retried).toBe(true);
  });

  it('still propagates a provider error from the FIRST ask, which is a real failure', async () => {
    // The retry's catch must not swallow anything else: an attempt that never got
    // an answer step at all is a model failure, not a bound.
    const { fn } = fakeGenerate(async () => {
      throw new Error('provider returned 401 unauthorized');
    });

    await expect(runAssistantLoop(input(fn, [], { maxSteps: 3 }))).rejects.toThrow(/401/);
  });

  it('withholds the tools on the second ask too, and does not raise the step ceiling', async () => {
    const read = vi.fn(async () => ({ ok: true }));
    const tool = descriptor(read);
    const { fn, retries } = greedyModel({
      toolName: tool.name,
      answer: '',
      answerOnRetry: 'One case is open.',
    });

    const result = await runAssistantLoop(input(fn, [tool], { maxSteps: 3 }));

    // `toolChoice: 'none'` at call level — the same mechanism the reserved step
    // already uses — and the tool budget is untouched by the retry.
    expect(retries()[0]!.toolChoice).toBe('none');
    expect(read).toHaveBeenCalledTimes(2);
    expect(result.trace).toHaveLength(2);
    // `steps` counts steps of the ceiling, and the retry is a model call OUTSIDE
    // what `stepCountIs(maxSteps)` counted — so it is reported by `answer_retried`
    // rather than added here. A record that says four steps against a ceiling of
    // three reads as a violated bound, and the panel prints it as one.
    expect(result.steps).toBe(3);
    expect(result.steps).toBeLessThanOrEqual(bounds({ maxSteps: 3 }).maxSteps);
    expect(result.answer_retried).toBe(true);
  });

  /**
   * A usage block is read as one thing — "57 tokens · 46 in / 23 out" — so the
   * parts have to sum to the total. They did not: the retry's tokens were
   * accumulated by the shared step counter AND added again from the retry's return,
   * while the total was added once, so every retried run stored 46 + 23 against a
   * total of 57. Asserting the identity rather than the three numbers is the point:
   * an edit that reintroduces a second addition cannot pass by matching a constant.
   */
  it('reports usage whose input and output sum to its total, with and without a retry', async () => {
    const tool = descriptor(async () => ({ ok: true }));
    const retried = await runAssistantLoop(
      input(
        greedyModel({ toolName: tool.name, answer: '', answerOnRetry: 'Two are open.' }).fn,
        [tool],
        { maxSteps: 3 },
      ),
    );
    const answeredFirstTime = await runAssistantLoop(
      input(greedyModel({ toolName: tool.name, answer: 'Two are open.' }).fn, [tool], {
        maxSteps: 3,
      }),
    );

    for (const result of [retried, answeredFirstTime]) {
      expect(result.outcome).toBe('answered');
      expect(result.input_tokens + result.output_tokens).toBe(result.total_tokens);
    }
    // And the retry's own tokens are in there exactly once: three steps at 10/5
    // plus the second ask at 8/4.
    expect(retried.answer_retried).toBe(true);
    expect(retried.input_tokens).toBe(38);
    expect(retried.output_tokens).toBe(19);
    expect(retried.total_tokens).toBe(57);
  });

  it('keeps the identity when a bound ends the attempt', async () => {
    const tool = descriptor(async () => ({ ok: true }));
    const { fn } = greedyModel({ toolName: tool.name, answer: '   ' });

    const result = await runAssistantLoop(input(fn, [tool], { maxSteps: 3 }));

    expect(result.outcome).toBe('bound_exceeded');
    expect(result.input_tokens + result.output_tokens).toBe(result.total_tokens);
  });

  it('asks once, not until it gets something', async () => {
    const tool = descriptor(async () => ({ ok: true }));
    const { fn, retries } = greedyModel({ toolName: tool.name, answer: '', answerOnRetry: '  ' });

    const result = await runAssistantLoop(input(fn, [tool], { maxSteps: 3 }));

    expect(retries()).toHaveLength(1);
    expect(result.outcome).toBe('bound_exceeded');
    expect(result.answer).toBe('');
  });

  it('declines to ask again when the attempt reports no conversation to answer from', async () => {
    // A wrapped or substituted model that does not report `response.messages`
    // leaves nothing for the retry to reason over. Answering from an empty
    // history would produce a confident answer grounded in nothing, which is
    // worse than the failure the retry exists to prevent — so the attempt fails
    // instead, and the reads it made are still on the record.
    const tool = descriptor(async () => ({ ok: true }));
    const { fn, retries } = greedyModel({
      toolName: tool.name,
      answer: '',
      answerOnRetry: 'Must not be reachable without the reads.',
      omitResponseMessages: true,
    });

    const result = await runAssistantLoop(input(fn, [tool], { maxSteps: 3 }));

    expect(retries()).toHaveLength(0);
    expect(result.outcome).toBe('bound_exceeded');
    expect(result.bound).toBe('max_steps');
    expect(result.answer).toBe('');
    expect(result.answer_retried).toBe(false);
    expect(result.trace).toHaveLength(2);
  });

  it('does not ask again once a bound has already ended the attempt', async () => {
    // The token budget is spent, so `guard.bound` is set before the empty answer
    // is even examined. A retry there would spend tokens the attempt does not
    // have — the bound must still be what ends it.
    const tool = descriptor(async () => ({ ok: true }));
    const { fn, retries } = greedyModel({
      toolName: tool.name,
      answer: '',
      answerOnRetry: 'Should never be asked for.',
    });

    const result = await runAssistantLoop(input(fn, [tool], { maxSteps: 3, tokenBudget: 1 }));

    expect(retries()).toHaveLength(0);
    expect(result.outcome).toBe('bound_exceeded');
    expect(result.bound).toBe('token_budget');
    expect(result.answer_retried).toBe(false);
  });

  it('counts the second ask against the token budget rather than outside it', async () => {
    // The retry runs on the same guard, so a budget that survives the first ask
    // but not the second still ends the attempt instead of buying an answer.
    const tool = descriptor(async () => ({ ok: true }));
    const { fn, retries } = greedyModel({
      toolName: tool.name,
      answer: '',
      answerOnRetry: 'An answer the budget can no longer afford.',
    });

    // Three steps at 15 tokens each fit; the retry's 12 push the total past it.
    const result = await runAssistantLoop(input(fn, [tool], { maxSteps: 3, tokenBudget: 50 }));

    expect(retries()).toHaveLength(1);
    expect(result.outcome).toBe('bound_exceeded');
    expect(result.bound).toBe('token_budget');
    expect(result.answer_retried).toBe(true);
  });

  it('retries the same way when the tool-call allowance was what ended the reading', async () => {
    const tool = descriptor(async () => ({ ok: true }));
    const { fn, retries } = parallelModel({
      toolName: tool.name,
      callsPerStep: [2],
      answer: '   ',
      answerOnRetry: 'Both cases are open.',
    });

    const result = await runAssistantLoop(input(fn, [tool], { maxToolCalls: 2, maxSteps: 6 }));

    expect(retries()).toHaveLength(1);
    expect(result.outcome).toBe('answered');
    expect(result.answer).toBe('Both cases are open.');
    expect(result.answer_retried).toBe(true);
    expect(result.reads_withheld_reason).toBe('tool_call_budget');
    expect(result.trace).toHaveLength(2);
  });

  it('discards the second ask when the provider spent it on tool calls anyway, but keeps its preamble as the last thing said', async () => {
    // The same rule the first ask is held to: text a model emits WITH tool calls
    // is a preamble to calls that will never run, and storing it would make the
    // case's task_result a sentence about what the model was about to do. The
    // retry does not get an exemption from that — but the FIRST ask here ended
    // blank (`answer: ''`), so it has no preamble of its own to report. The
    // second ask's text is the only thing the model ever said, and must be what
    // `discarded_preamble` carries — not silently dropped because it was
    // computed from the first ask before the retry ran.
    const tool = descriptor(async () => ({ ok: true }));
    const { fn, retries } = greedyModel({
      toolName: tool.name,
      answer: '',
      answerOnRetry: 'Let me check the remaining two cases.',
      retryIgnoresToolChoice: true,
    });

    const result = await runAssistantLoop(input(fn, [tool], { maxSteps: 3 }));

    expect(retries()).toHaveLength(1);
    expect(result.outcome).toBe('bound_exceeded');
    expect(result.bound).toBe('max_steps');
    expect(result.answer).toBe('');
    expect(result.answer_retried).toBe(true);
    expect(result.discarded_preamble).toBe('Let me check the remaining two cases.');
  });

  it('leaves an answered attempt alone', async () => {
    const tool = descriptor(async () => ({ ok: true }));
    const { fn, retries } = greedyModel({
      toolName: tool.name,
      answer: 'Answered on the first ask.',
      answerOnRetry: 'never reached',
    });

    const result = await runAssistantLoop(input(fn, [tool], { maxSteps: 3 }));

    expect(retries()).toHaveLength(0);
    expect(result.answer).toBe('Answered on the first ask.');
    expect(result.answer_retried).toBe(false);
  });
});

/**
 * Issue #841: the answer step can end at `finish_reason: 'length'` with real
 * but truncated text — a shape neither the blank check nor the tool-calls
 * check caught. The fragment used across these tests stands in for a real
 * truncated answer: a mid-sentence tail the provider emitted before its output budget, spent
 * mostly on thinking, ran out.
 */
describe('runAssistantLoop — the answer step retries when the output-token ceiling cut it off', () => {
  it('retries a length-cut answer and keeps the retry text as the answer', async () => {
    // Reverted line: dropping `endedInLength` from the retry-trigger `if` in
    // assistant-loop.ts (back to `endedInToolCalls || (readsWithheldReason !==
    // null && answer.trim().length === 0)`) makes this fail — a non-blank
    // `finish_reason: 'length'` answer never triggered a retry pre-#841.
    const tool = descriptor(async () => ({ ok: true }));
    const { fn, retries } = greedyModel({
      toolName: tool.name,
      answer: 'Overall utilization: 7065 / 14400 = 49.06%, based on the hours',
      answerFinishReason: 'length',
      answerOnRetry: 'Overall utilization is 49.06%.',
    });

    const result = await runAssistantLoop(input(fn, [tool], { maxSteps: 3 }));

    expect(retries()).toHaveLength(1);
    expect(result.outcome).toBe('answered');
    expect(result.answer).toBe('Overall utilization is 49.06%.');
    expect(result.answer_retried).toBe(true);
    // The finish reason on the stored answer is the RETRY's, not the first
    // ask's — the retry is what actually produced the text being kept.
    expect(result.finish_reason).toBe('stop');
    expect(result.bound).toBeNull();
  });

  it('asks the length-specific instruction, not the "produced no text" one', async () => {
    // Reverted line: collapsing the `retryInstruction = endedInLength && ... ?
    // ASSISTANT_ANSWER_RETRY_LENGTH_INSTRUCTION : ASSISTANT_ANSWER_RETRY_INSTRUCTION`
    // ternary in assistant-loop.ts back to always `ASSISTANT_ANSWER_RETRY_INSTRUCTION`
    // makes this fail — that text opens with "your last turn produced no
    // text", which misdescribes a real, if truncated, fragment.
    const tool = descriptor(async () => ({ ok: true }));
    const { fn, retries } = greedyModel({
      toolName: tool.name,
      answer: 'a truncated fragment of the real answer',
      answerFinishReason: 'length',
      answerOnRetry: 'The full answer.',
    });

    await runAssistantLoop(input(fn, [tool], { maxSteps: 3 }));

    const retry = retries()[0]!;
    const lastMessage = retry.messages![retry.messages!.length - 1]!;
    expect(lastMessage.content).toBe(ASSISTANT_ANSWER_RETRY_LENGTH_INSTRUCTION);
  });

  it('gives the retry the wider answer-step ceiling while the main call keeps the tool-step one', async () => {
    // Reverted line: `maxOutputTokens: args.bounds.maxOutputTokens` in
    // `retryAnswerStep` (assistant-loop.ts), before it became
    // `args.bounds.maxAnswerOutputTokens` — reverting it back makes the retry
    // ask with the same ceiling that just cut the first ask off.
    const tool = descriptor(async () => ({ ok: true }));
    const mainCalls: FakeCallArgs[] = [];
    const { fn: rawFn, retries } = greedyModel({
      toolName: tool.name,
      answer: 'cut off mid-sentence',
      answerFinishReason: 'length',
      answerOnRetry: 'The full answer.',
    });
    const fn = (async (args: FakeCallArgs) => {
      if (args.messages === undefined) mainCalls.push(args);
      return rawFn(args);
    }) as unknown as GenerateTextFn;

    const result = await runAssistantLoop(input(fn, [tool], { maxSteps: 3 }));

    expect(result.answer_retried).toBe(true);
    expect(mainCalls[0]!.maxOutputTokens).toBe(bounds().maxOutputTokens);
    expect(retries()[0]!.maxOutputTokens).toBe(bounds().maxAnswerOutputTokens);
    expect(retries()[0]!.maxOutputTokens).not.toBe(mainCalls[0]!.maxOutputTokens);
  });

  it("adds the retry's tokens to the totals when the rescue was for a length cutoff", async () => {
    // Reverted line: same as the first test in this block — without
    // `endedInLength` in the retry trigger, no retry runs for this shape, so
    // its tokens never reach `countUsage` and the totals stay at 30/15/45.
    const tool = descriptor(async () => ({ ok: true }));
    const { fn } = greedyModel({
      toolName: tool.name,
      answer: 'cut off mid-sentence',
      answerFinishReason: 'length',
      answerOnRetry: 'The full answer.',
    });

    const result = await runAssistantLoop(input(fn, [tool], { maxSteps: 3 }));

    expect(result.answer_retried).toBe(true);
    expect(result.input_tokens + result.output_tokens).toBe(result.total_tokens);
    // Two tool steps plus the forced answer step at 10/5 each, plus the
    // retry's own 8/4 — the same shape the pre-existing blank-retry usage
    // test pins for the identical step layout.
    expect(result.input_tokens).toBe(38);
    expect(result.output_tokens).toBe(19);
    expect(result.total_tokens).toBe(57);
  });

  it.each([
    [
      'dies at length again with a shorter fragment',
      { answerOnRetry: 'cut off ag', retryFinishReason: 'length' },
    ],
    ['comes back blank', { answerOnRetry: '' }],
  ])('keeps the first fragment as the answer when the retry %s', async (_name, retryOptions) => {
    // Reverted line: the `retriedIsUsable` gate in assistant-loop.ts (the `if
    // (!retriedIsUsable && firstAttemptFragment.trim().length > 0) { answer =
    // firstAttemptFragment; }` branch) — without it, `answer = retried.text`
    // runs unconditionally and overwrites the real first fragment with the
    // retry's own failed (blank, or re-truncated) text.
    const tool = descriptor(async () => ({ ok: true }));
    const fragment = 'Overall utilization: 7065 / 14400 = 49.06%, based on the';
    const { fn, retries } = greedyModel({
      toolName: tool.name,
      answer: fragment,
      answerFinishReason: 'length',
      ...retryOptions,
    });

    const result = await runAssistantLoop(input(fn, [tool], { maxSteps: 3 }));

    expect(retries()).toHaveLength(1);
    // Still a governed answer, not a bound failure: a truncated answer beats
    // no answer, and the run must not regress below today's (pre-fix) floor
    // of storing the first fragment verbatim.
    expect(result.outcome).toBe('answered');
    expect(result.answer).toBe(fragment);
    expect(result.answer_retried).toBe(true);
    expect(result.bound).toBeNull();
    expect(result.finish_reason).toBe('length');
  });

  it('keeps the first fragment when the rescue itself throws, instead of failing the run', async () => {
    // Reverted line: the catch block's `if (firstAttemptFragment.trim().length
    // > 0) { …; return answeredResult(...); }` branch in assistant-loop.ts —
    // without it, a provider error on the rescue falls through to the
    // residual `bound_exceeded` path and the real fragment the first ask
    // produced is lost, turning an already-answered attempt into a failure.
    const tool = descriptor(async () => ({ ok: true }));
    const fragment = 'Overall utilization: 7065 / 14400 = 49.06%, based on the';
    const { fn, retries } = greedyModel({
      toolName: tool.name,
      answer: fragment,
      answerFinishReason: 'length',
      retryThrows: new Error('provider returned 503 service unavailable'),
    });

    const result = await runAssistantLoop(input(fn, [tool], { maxSteps: 3 }));

    expect(retries()).toHaveLength(1);
    expect(result.outcome).toBe('answered');
    expect(result.answer).toBe(fragment);
    expect(result.answer_retried).toBe(true);
    expect(result.bound).toBeNull();
    expect(result.finish_reason).toBe('length');
  });
});

describe('assistant bounds — the answer step gets its own output ceiling', () => {
  it('defaults the answer-step ceiling higher than the tool-step one', () => {
    // Reverted line: removing `maxAnswerOutputTokens: readPositiveInt(...)`
    // from `resolveAssistantBounds` in assistant-bounds.ts makes this fail
    // (and makes every caller of `AssistantBounds` fail to typecheck first).
    const resolved = resolveAssistantBounds();
    expect(resolved.maxAnswerOutputTokens).toBe(4_000);
    expect(resolved.maxAnswerOutputTokens).toBeGreaterThan(resolved.maxOutputTokens);
  });

  it('reads the answer-step ceiling from its own env var, with the same fallback rule as the others', () => {
    // Reverted line: same as above — without the `readPositiveInt(...)` call
    // for `maxAnswerOutputTokens`, this env var has nothing to read into.
    process.env['ARBITRA_ASSISTANT_MAX_ANSWER_OUTPUT_TOKENS'] = '9000';
    try {
      expect(resolveAssistantBounds().maxAnswerOutputTokens).toBe(9_000);
    } finally {
      delete process.env['ARBITRA_ASSISTANT_MAX_ANSWER_OUTPUT_TOKENS'];
    }
  });
});

describe('runAssistantLoop — a spent tool-call allowance keeps what was read', () => {
  it('withholds the reads instead of aborting, so a parallel step is not discarded', async () => {
    // Reviewer scenario, and the one the configured provider actually produces:
    // step 0 searches, step 1 fires three reads in parallel and uses up the
    // allowance, step 2 has to answer. Pre-fix, the abort threw every one of those
    // reads away and failed the run with `bound:max_tool_calls`.
    const read = vi.fn(async () => ({ rows: [1] }));
    const tool = descriptor(read);
    const { fn } = parallelModel({
      toolName: tool.name,
      callsPerStep: [1, 3],
      answer: 'All four cases are open: case-a, case-b, case-c, case-d.',
    });

    const result = await runAssistantLoop(input(fn, [tool], { maxToolCalls: 4, maxSteps: 6 }));

    expect(result.outcome).toBe('answered');
    expect(result.answer).toContain('case-d');
    expect(result.bound).toBeNull();
    // The allowance ran out BEFORE the step ceiling, and that is the distinction
    // the reason carries: three of the six steps were never needed.
    expect(result.reads_withheld).toBe(true);
    expect(result.reads_withheld_reason).toBe('tool_call_budget');
    expect(read).toHaveBeenCalledTimes(4);
    expect(result.trace).toHaveLength(4);
    expect(result.trace.every((record) => record.outcome === 'ok')).toBe(true);
    expect(result.steps).toBe(3);
  });

  it('hands a refused read back to the model as a tool result and keeps going', async () => {
    const read = vi.fn(async () => ({ rows: [1] }));
    const tool = descriptor(read);
    const { fn, results } = parallelModel({
      toolName: tool.name,
      // Five calls against an allowance of four: one of them is refused mid-step.
      callsPerStep: [5],
      answer: 'Four of the five cases are open; I could not read the fifth.',
    });

    const result = await runAssistantLoop(input(fn, [tool], { maxToolCalls: 4, maxSteps: 6 }));

    // The refusal is a tool result, not an abort — which is what lets the attempt
    // reach its answer at all.
    expect(results()).toContainEqual(
      expect.objectContaining({
        outcome: 'failed',
        message: 'Refused: the max_tool_calls bound is exhausted.',
      }),
    );
    expect(result.outcome).toBe('answered');
    expect(result.answer).toContain('could not read the fifth');
    expect(result.bound).toBeNull();
    expect(result.reads_withheld_reason).toBe('tool_call_budget');
    // Four reads completed, and the refused fifth is on the record as refused.
    expect(read).toHaveBeenCalledTimes(4);
    expect(result.trace.filter((record) => record.outcome === 'ok')).toHaveLength(4);
    expect(result.trace.filter((record) => record.outcome === 'bound_exceeded')).toMatchObject([
      { detail: 'max_tool_calls' },
    ]);
  });

  it('fails under max_tool_calls when the step that had to answer produced nothing', async () => {
    const tool = descriptor(async () => ({ ok: true }));
    const { fn } = parallelModel({
      toolName: tool.name,
      callsPerStep: [2],
      answer: '   ',
    });

    const result = await runAssistantLoop(input(fn, [tool], { maxToolCalls: 2, maxSteps: 6 }));

    // The residual case reports the budget that actually ended the reading, so
    // `error_message` does not name the step ceiling for a spent call allowance.
    expect(result.outcome).toBe('bound_exceeded');
    expect(result.bound).toBe('max_tool_calls');
    expect(result.answer).toBe('');
    expect(result.trace).toHaveLength(2);
  });
});

describe('assistant bounds — no bound may ship unreachable', () => {
  it('reserves one step of the ceiling for the answer', () => {
    expect(toolStepBudget({ maxSteps: 6 })).toBe(5);
  });

  it('lowers the step ceiling to what the tool-call budget can feed, never the reverse', () => {
    process.env['ARBITRA_ASSISTANT_MAX_STEPS'] = '6';
    process.env['ARBITRA_ASSISTANT_MAX_TOOL_CALLS'] = '2';
    try {
      const resolved = resolveAssistantBounds();
      // Sequential tool use spends one call per step, so a ceiling of 6 steps
      // could never be reached with 2 calls — `max_steps` would be dead config.
      expect(resolved.maxSteps).toBe(3);
      expect(toolStepBudget(resolved)).toBe(2);
      // The tighter bound is the one that survives; nothing was widened.
      expect(resolved.maxToolCalls).toBe(2);
    } finally {
      delete process.env['ARBITRA_ASSISTANT_MAX_STEPS'];
      delete process.env['ARBITRA_ASSISTANT_MAX_TOOL_CALLS'];
    }
  });

  it('keeps at least one step for tools next to the reserved answer step', () => {
    process.env['ARBITRA_ASSISTANT_MAX_STEPS'] = '1';
    try {
      const resolved = resolveAssistantBounds();
      expect(resolved.maxSteps).toBe(2);
      expect(toolStepBudget(resolved)).toBe(1);
    } finally {
      delete process.env['ARBITRA_ASSISTANT_MAX_STEPS'];
    }
  });
});

describe('bound failure messages', () => {
  it('classify as permanent for every bound, so a spent budget is not retried', () => {
    for (const bound of ASSISTANT_BOUND_IDS) {
      for (const answerRetried of [true, false]) {
        const message = boundFailureMessage(bound, { answerRetried });
        expect(message).toContain(bound);
        expect(classifyRunFailure(message)).toBe('permanent');
      }
    }
  });

  /**
   * The message is the run's `error_message`, rendered verbatim on the case. One
   * path into the residual bound never makes a second ask — an attempt whose
   * conversation was not reported back declines it — so a fixed "on the first ask or
   * the plainer second one" is a machine-authored claim about a call that did not
   * happen. Same class of defect as the "INCOMPLETE RESULT" prefix this feature
   * removed for the same reason.
   */
  it('claim a second ask only on the runs that made one', () => {
    for (const bound of ['max_steps', 'max_tool_calls'] as const) {
      expect(boundFailureMessage(bound, { answerRetried: true })).toContain(
        'on the first ask or the plainer second one',
      );
      const once = boundFailureMessage(bound, { answerRetried: false });
      expect(once).not.toContain('second');
      expect(once).toContain('on the one ask it was given');
    }
  });

  it('are true for the path that declines the second ask', async () => {
    // The provider read past `toolChoice: 'none'` AND the wrapper reported no
    // conversation back: the second ask has nothing to answer from and declines,
    // so the message must not claim one was made.
    const tool = descriptor(async () => ({ ok: true }));
    const { fn, retries } = greedyModel({
      toolName: tool.name,
      answer: 'never reached',
      textWithToolCalls: 'Let me check the remaining two cases.',
      ignoreToolChoice: true,
      omitResponseMessages: true,
    });

    const result = await runAssistantLoop(input(fn, [tool], { maxSteps: 3 }));

    expect(retries()).toHaveLength(0);
    expect(result.answer_retried).toBe(false);
    // Declined, not rescued — and the preamble still reaches the record, because
    // it was the last thing the model said on an attempt that now fails.
    expect(result.discarded_preamble).toBe('Let me check the remaining two cases.');
    expect(boundFailureMessage(result.bound!, { answerRetried: result.answer_retried }))
      .not.toContain('second');
  });
});
