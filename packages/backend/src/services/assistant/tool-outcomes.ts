/**
 * What a tool call amounts to for the model's NEXT move.
 *
 * ## Why a class and not a message
 *
 * Before this, a call that returned no rows could only be `{ error: <message> }`,
 * and that shape cannot express the difference between the three things such a
 * call actually means. The consequence was observed rather than theorised: a case
 * search whose `project` filter matched no project came back with the candidate
 * list — the answer to the question, in 385 bytes — and the model read it as "my
 * filter does not work", dropped the filter, and spent the rest of its budget on
 * an unfiltered sweep and paging. A single call failing against a composite index
 * that was still building produced the same move.
 *
 * Rewording the message would not settle it, because the same model reported the
 * same refusal correctly on another run. The behaviour is unreliable rather than
 * absent, so no wording can be shown to fix it — what the model needs is a field
 * it can branch on rather than prose it has to interpret.
 *
 * Widening a search stays a legitimate move when data is genuinely missing. The
 * point is not to forbid it; it is to let the model tell "I have my answer" from
 * "my approach failed".
 *
 * ## Its own module
 *
 * `tool-reads.ts` produces refusals and `tool-registry.ts` wraps them, so both
 * need this vocabulary. Putting it in either one would make the two import each
 * other.
 */

/**
 * - `ok` — the read ran and returned data.
 * - `answer` — the read could not do what was asked, and WHY is the answer: a
 *   requester who can see no project at all, a case the requester may not see.
 *   Final for THIS call — nothing about it is worth retrying or widening — and
 *   silent about the rest of the request, which still needs its own reads.
 * - `transient` — the call failed for now and the same call may succeed again: an
 *   index still building, a throttle, a timeout.
 * - `failed` — the call genuinely cannot be done. Tell the requester; reading
 *   more broadly answers a different question and is not a substitute.
 * - `invalid_call` — the call did not run AS GIVEN, and the message names what to
 *   change. Kept apart from `failed` because the tool is fine and a corrected
 *   call will work, so "say it cannot be done" would be the wrong move: a
 *   malformed input, a date that does not exist, a cursor from another filter
 *   set, a project name that matches several projects or none of them (the
 *   refusal lists the projects to pick from either way).
 */
export const TOOL_OUTCOMES = ['ok', 'answer', 'transient', 'failed', 'invalid_call'] as const;

export type ToolOutcome = (typeof TOOL_OUTCOMES)[number];

/**
 * The classes a READ may declare for itself — everything but `ok`, which is the
 * absence of a declaration.
 */
export type ToolReadOutcome = Exclude<ToolOutcome, 'ok'>;

/**
 * The key a read sets on a payload it could not answer from.
 *
 * Deliberately not `outcome`: `liftReadOutcome` moves it into the envelope's
 * `outcome` and removes it from the payload, so the model reads the class in one
 * place, and a result payload that one day carries a field of its own called
 * `outcome` cannot be mistaken for a declaration.
 */
export const READ_OUTCOME_KEY = 'read_outcome';

/** Tag a refusal payload with the class it belongs to. */
export function classifiedRefusal(
  outcome: ToolReadOutcome,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return { ...payload, [READ_OUTCOME_KEY]: outcome };
}

/**
 * Split a read's return into the class it declared and the payload without the
 * declaration. No declaration means the read answered.
 *
 * Non-mutating, and the `ok` branch returns the very object the read produced —
 * so nothing about a successful result changes, not even by a rebuilt key order.
 */
export function liftReadOutcome(raw: Record<string, unknown>): {
  outcome: ToolOutcome;
  payload: Record<string, unknown>;
} {
  const declared = raw[READ_OUTCOME_KEY];
  if (
    typeof declared !== 'string'
    || declared === 'ok'
    || !(TOOL_OUTCOMES as readonly string[]).includes(declared)
  ) {
    return { outcome: 'ok', payload: raw };
  }
  const { [READ_OUTCOME_KEY]: _declared, ...payload } = raw;
  return { outcome: declared as ToolOutcome, payload };
}

/**
 * What the model is told to do with each class, verbatim on the result.
 *
 * On the result and not only in the system prompt, because by the time a result
 * lands the prompt is thousands of tokens away, and the move this text rules out
 * — widening a search that already answered — is exactly the one the model made
 * when it had to remember a rule instead of reading one.
 */
export const TOOL_OUTCOME_GUIDANCE: Record<Exclude<ToolOutcome, 'ok'>, string> = {
  /**
   * Scoped to THIS CALL, deliberately. An earlier wording said "Report it and
   * stop", which is right about the call and wrong about the request: asked "how
   * many open cases in Globex and in Acme", a model whose first call refused
   * Globex reported that and never searched Acme — the half of the request that
   * had data. The property the class exists for is unchanged and is the other half
   * of this sentence: a refusal is not to be answered by dropping the filter.
   */
  answer:
    'This is a RESULT, not a failure: what it says is the answer for what THIS call asked, and it '
    + 'is final. Do not repeat this call and do not repeat it with the filter removed, which '
    + 'answers a different question. If the request has other parts, they still need their own '
    + 'reads before you answer.',
  transient:
    'This call failed FOR NOW and the same call may succeed if repeated. Nothing about the '
    + 'filters you used is wrong, so do not drop them and do not read more broadly instead.',
  failed:
    'This call cannot be done. Say so plainly in your answer. Reading more broadly is not a '
    + 'substitute, because it answers a different question.',
  invalid_call:
    'The call did not run as given, so nothing was silently ignored. The message names what to '
    + 'change; call again with that change — the tool itself works.',
};
