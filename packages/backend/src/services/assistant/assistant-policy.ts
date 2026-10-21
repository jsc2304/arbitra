import {
  ASSISTANT_TOOL_SELECTION_REASON,
  type AssistantToolPolicyTrace,
  type Case,
} from '@arbitra/shared';
export type { AssistantTaskKind } from '@arbitra/shared';
import {
  ASSISTANT_TOOL_REGISTRY,
  isReadToolDescriptor,
} from './tool-registry.js';

/**
 * The deterministic gate in front of the model.
 *
 * Two separate jobs, deliberately not merged:
 *
 * 1. `checkAssistantTaskInput` — is this attempt runnable at all? Purely
 *    mechanical checks on state the executor already holds. Nothing here
 *    depends on the model, so a task that can never succeed fails before a
 *    single token is spent.
 * 2. `decideAssistantPolicy` — bind the requester-scoped read registry to this
 *    attempt. Keywords label `task_kind` for telemetry only; they never grant
 *    or remove a read tool. The access boundary is each descriptor's
 *    `effect: read` declaration plus requester scoping at execution time.
 *
 * Classification is keyword-based rather than model-based on purpose: a model
 * call to decide what the model may read is both circular and steerable by the
 * very content it is inspecting.
 */

export interface AssistantInputCheck {
  ok: boolean;
  /** Machine-readable reason id, recorded on the run and in the event payload. */
  reason?: 'empty_text' | 'text_too_long' | 'missing_requester';
  message?: string;
}

export type AssistantPolicyDecision = AssistantToolPolicyTrace;

/**
 * Signals that the task is about Arbitra's own records. Deliberately narrow:
 * these are Arbitra domain nouns, not common English words, so an unrelated
 * request does not accidentally unlock data access.
 */
const ARBITRA_DATA_SIGNALS: readonly RegExp[] = [
  /\bcases?\b/i,
  /\bcase[-_ ]?id\b/i,
  /\bcase-[a-z]+-[a-z]+-[a-z0-9]{4}\b/i,
  /\bknowledge (asset|base)\b/i,
  /\bprecedent(s)?\b/i,
  /\banti[- ]?pattern(s)?\b/i,
  /\barbitra\b/i,
  /\bevidence\b/i,
  /\bfinding(s)?\b/i,
  /\bdecision(s)?\b/i,
  /\brule[- ]?set(s)?\b/i,
  /\bgovernance\b/i,
  // German equivalents — the requester writes in their own language.
  /\bfälle\b/i,
  /\bfall\b/i,
  /\bnachweis(e)?\b/i,
  /\bentscheidung(en)?\b/i,
  /\bwissensbaustein(e)?\b/i,
];

/**
 * Requests for an outward effect. Clerk has no tool for any of them, so the
 * classification exists to shape the answer ("I cannot do that, here is what you
 * would do"), not to refuse the task.
 *
 * The verb must be followed by an Arbitra object, optionally behind a
 * determiner. A bare verb list would be useless here: "which cases are still
 * OPEN", "any CHANGE since Friday", "the review COMMENT" would all read as
 * action requests, and half of these words are ordinary English. The object
 * requirement is what makes the signal mean something.
 */
const ACTION_OBJECTS =
  '(?:cases?|comments?|decisions?|evidence|rules?|rule sets?|knowledge assets?|pull requests?|'
  + 'PRs?|branch|branches|issues?|tickets?|files?|emails?|messages?|deployments?|approvals?|waivers?)';

const ACTION_OBJECTS_DE =
  '(?:Fall|Fälle|Kommentar|Kommentare|Entscheidung|Entscheidungen|Nachweis|Nachweise|Regel|Regeln|'
  + 'Regelsatz|Wissensbaustein|Pull Request|PR|Branch|Ticket|Datei|E-Mail|Nachricht|Freigabe)';

const ACTION_SIGNALS: readonly RegExp[] = [
  new RegExp(
    // Note: no "comment on" — "the review COMMENT ON my case" is a noun phrase,
    // and the verb sense is covered by "add"/"post".
    String.raw`\b(?:create|add|attach|upload|open|close|delete|remove|update|change|modify|approve|`
    + String.raw`reject|merge|deploy|send|email|post|assign|transition|register)\s+`
    + String.raw`(?:(?:a|an|the|this|that|my|our|new)\s+)?(?:new\s+)?${ACTION_OBJECTS}\b`,
    'i',
  ),
  new RegExp(
    String.raw`\b(?:erstell|erzeug|anleg|lösch|entfern|ändere|ändern|aktualisier|genehmig|ablehn|`
    + String.raw`zusammenführ|zuweis|verschick|sende|kommentier)\w*\s+`
    + String.raw`(?:(?:einen|eine|ein|den|die|das|meinen|meine|mein|neuen|neue)\s+)?${ACTION_OBJECTS_DE}\b`,
    'i',
  ),
];

function anyMatch(patterns: readonly RegExp[], text: string): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

/**
 * Mechanical runnability checks against the case as intake stored it. The task
 * text is `case_.description` verbatim.
 *
 * `maxInputChars` is the intake limit (`resolveAssistantIntakeLimits`), checked
 * a second time here on purpose: intake validated the text it accepted, and
 * this executor runs against whatever the case holds now — which a later edit,
 * an import or a lowered limit can have changed.
 */
export function checkAssistantTaskInput(
  case_: Case,
  maxInputChars: number,
): AssistantInputCheck {
  const requester = case_.assistant_context?.requester_user_id;
  if (!requester || requester.trim() === '') {
    return {
      ok: false,
      reason: 'missing_requester',
      message:
        'Assistant task cannot run: the case records no requester, so no access scope can be '
        + 'resolved for its tools.',
    };
  }
  const text = (case_.description ?? '').trim();
  if (text.length === 0) {
    return {
      ok: false,
      reason: 'empty_text',
      message: 'Assistant task cannot run: the request text is empty.',
    };
  }
  if (text.length > maxInputChars) {
    return {
      ok: false,
      reason: 'text_too_long',
      message:
        'Assistant task cannot run: the request text is longer than the configured input limit.',
    };
  }
  return { ok: true };
}

/**
 * Decide the enabled tool subset for one task.
 *
 * `availableNames` defaults to the whole registry's read tools — every
 * arbitra_* tool is always in that default, and it is a parameter so a caller
 * can narrow further. It only ever narrows: the result is intersected with the
 * registry, never widened past it.
 *
 * `availableNames` is never derived from `text` below. That keyword match
 * feeds `task_kind` ONLY — the #786 invariant this function's tests exist to
 * pin: the classifier labels, it never grants or removes a tool.
 */
export function decideAssistantPolicy(
  case_: Case,
  availableNames: readonly string[] = ASSISTANT_TOOL_REGISTRY.filter(isReadToolDescriptor).map(
    (d) => d.name,
  ),
): AssistantPolicyDecision {
  const text = `${case_.title ?? ''}\n${case_.description ?? ''}`;
  const registryReadNames = new Set(
    ASSISTANT_TOOL_REGISTRY.filter(isReadToolDescriptor).map((d) => d.name),
  );
  const available = new Set(availableNames.filter((name) => registryReadNames.has(name)));

  const wantsData = anyMatch(ARBITRA_DATA_SIGNALS, text);
  const wantsAction = anyMatch(ACTION_SIGNALS, text);
  const enabled = ASSISTANT_TOOL_REGISTRY
    .filter(isReadToolDescriptor)
    .map((descriptor) => descriptor.name)
    .filter((name) => available.has(name));

  return {
    schema_version: 1,
    task_kind: wantsAction
      ? 'action_request'
      : wantsData
        ? 'arbitra_data_question'
        : 'general_question',
    enabled_tools: enabled,
    tool_selection_reason: ASSISTANT_TOOL_SELECTION_REASON,
  };
}
