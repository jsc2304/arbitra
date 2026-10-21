/**
 * Event-shape helpers for `POST /api/chat/events`.
 *
 * These live outside `route.ts` because a Next.js App Router route module
 * may only export HTTP-method handlers plus a fixed config allowlist —
 * exporting anything else fails `next build` with "is not a valid Route
 * export field". The sibling `rate-limit.ts` exists for the same reason.
 *
 * Splitting them out also makes them directly testable against hostile
 * inputs, which matters most for `summarizePayloadShape`: it is the one
 * function here that touches an unverified body shape, and its whole
 * contract is that no value ever reaches a log line.
 */

export interface ChatEvent {
  type?: string;
  /**
   * Present only on the Workspace add-on shape — see `classifyChatEvent`'s
   * doc comment. Left loosely typed (`unknown`, narrowed inside that
   * function) rather than modeling the full add-on event schema: the only
   * thing this dispatcher currently needs from it is which of six
   * documented keys is present, never a value underneath.
   */
  chat?: unknown;
  [key: string]: unknown;
}

/** The three event kinds `dispatchEvent` has real branches for. */
export type ChatEventKind = 'ADDED_TO_SPACE' | 'REMOVED_FROM_SPACE' | 'MESSAGE';

/**
 * Classifies a verified Chat event into one of the three kinds
 * `dispatchEvent` has real branches for, recognizing BOTH request shapes
 * this endpoint can receive.
 *
 * ## Classic shape
 *
 * The classic Chat-API interaction-events console puts the discriminator
 * in a top-level `type` string: `{"type":"ADDED_TO_SPACE", ...}`. This is
 * what the original version of this dispatcher assumed, and it is kept
 * working here (it costs nothing to check) even though this app's actual
 * registration never sends it — see below.
 *
 * ## Add-on shape — the one this deployment actually sends
 *
 * This app is registered as a Google Workspace add-on extending Google
 * Chat (`chat-auth.ts`'s "Service-account identity" section covers the
 * same split on the auth side). That registration's event body has NO
 * `type` field at all (see `route.ts`'s module doc) — and Google's migration guide
 * says so explicitly for this exact field:
 * "type | N/A | The event type can be deduced from the trigger."
 * (https://developers.google.com/workspace/add-ons/chat/convert).
 *
 * Instead, the add-on event nests exactly ONE of six mutually exclusive
 * keys under `event.chat`, documented as a protobuf "Union field payload"
 * at https://developers.google.com/workspace/add-ons/concepts/event-objects
 * — and WHICH key is present is the entire signal. None of Google's own
 * add-on samples ever read a value there, only presence, e.g.
 * `if (this.event.chat.addedToSpacePayload) { ... } else if
 * (this.event.chat.removedFromSpacePayload) { ... }` in
 * https://github.com/googleworkspace/add-ons-samples/blob/main/node/chat/project-management-app/controllers/app.js.
 * This is the same class of trap that already hit this endpoint's auth
 * path twice (see `chat-auth.ts`'s module doc) and now the body too — the
 * discriminator lives in its own function, with this comment, so the next
 * reader does not have to rediscover it from a live 401 or a `type:
 * undefined` log line.
 *
 * Only the three add-on payload keys with a direct classic equivalent are
 * recognized here — `addedToSpacePayload`, `removedFromSpacePayload`,
 * `messagePayload` — matching the three kinds `dispatchEvent` already
 * handles. The other three documented union keys (`appCommandPayload` for
 * slash/quick commands, `buttonClickedPayload`, `widgetUpdatedPayload`)
 * have no classic equivalent in this dispatcher yet and deliberately fall
 * through to `undefined` here, same as any other unrecognized shape,
 * rather than guessing at handling for a payload this endpoint has not
 * seen a real instance of.
 */
export function classifyChatEvent(event: ChatEvent): ChatEventKind | undefined {
  if (typeof event.type === 'string') {
    return event.type === 'ADDED_TO_SPACE' || event.type === 'REMOVED_FROM_SPACE' || event.type === 'MESSAGE'
      ? event.type
      : undefined;
  }

  const chat = event.chat;
  if (chat && typeof chat === 'object' && !Array.isArray(chat)) {
    const payload = chat as Record<string, unknown>;
    if (payload['addedToSpacePayload'] !== undefined) return 'ADDED_TO_SPACE';
    if (payload['removedFromSpacePayload'] !== undefined) return 'REMOVED_FROM_SPACE';
    if (payload['messagePayload'] !== undefined) return 'MESSAGE';
  }

  return undefined;
}

/**
 * Cap on how many levels deep `summarizePayloadShape` descends. The
 * payload being summarized is, by definition, one this dispatcher doesn't
 * recognize — from a caller who has already passed JWT verification but
 * whose body shape is otherwise unconstrained — so an unbounded walk would
 * let a maliciously deep object make this diagnostic itself expensive.
 */
const SHAPE_SUMMARY_MAX_DEPTH = 3;

/**
 * Cap on the total number of key-path entries collected across the WHOLE
 * summary, not per level — protects against a wide object (many keys at
 * one level, or spread across the allowed depth) producing an unbounded
 * log line.
 */
const SHAPE_SUMMARY_MAX_KEYS = 40;

export interface PayloadShapeSummary {
  /**
   * Key paths only, e.g. `"chat.addedToSpacePayload.space"` or
   * `"tags[]:3"` for a 3-element array. NEVER a value, of any type, at any
   * depth, and NEVER array contents.
   */
  keyPaths: string[];
  /** True if the depth or key-count cap stopped the walk before it was exhaustive. */
  truncated: boolean;
}

/**
 * Produces a STRUCTURE-ONLY summary of an unrecognized event payload, safe
 * to log.
 *
 * A Chat event payload carries real user content at nearly every depth —
 * message text, display names, email addresses, space names — in every
 * one of the six documented add-on union payloads and the classic shape
 * alike. None of it may reach Cloud Logging (this is the discipline the
 * `identity_mismatch` branch in `route.ts`'s `POST` already follows for
 * the auth path — classify and hash rather than log a real address
 * verbatim). This function is the equivalent discipline for an unknown
 * BODY: it walks the object emitting KEY NAMES and, for arrays, LENGTHS —
 * never a value, of any type, at any depth, and never array contents.
 *
 * Key names themselves are safe to log because every key this endpoint
 * has ever seen documented is a fixed schema field name (`chat`,
 * `messagePayload`, `user`, `displayName`, ... — see `classifyChatEvent`'s
 * doc for the source), not user-supplied data. If a future payload ever
 * nests a map KEYED BY something user-controlled (a user id or an email
 * address used as a dictionary key, rather than as a value) that key text
 * would leak through here unchanged — none of the six known add-on
 * payloads are shaped that way today, but that assumption is exactly what
 * breaks silently if one ever is. Re-check this comment before trusting a
 * new key path blindly.
 *
 * Pure and exported so it can be tested directly against hostile inputs
 * (deep nesting, wide objects, arrays, and realistic sensitive values)
 * without going through the route.
 */
/**
 * Cap on a single key segment's length. The doc above explains why key
 * names are safe to log *today* — every documented key is a fixed schema
 * field name. This cap is what keeps that from being the only thing
 * standing between a future user-keyed map and an unbounded log line: a
 * key long enough to matter is truncated, so the worst case is a
 * recognisable fragment rather than a whole address or message.
 */
const SHAPE_SUMMARY_MAX_KEY_LENGTH = 64;

function capKeySegment(key: string): string {
  return key.length <= SHAPE_SUMMARY_MAX_KEY_LENGTH
    ? key
    : `${key.slice(0, SHAPE_SUMMARY_MAX_KEY_LENGTH)}…`;
}

export function summarizePayloadShape(payload: unknown): PayloadShapeSummary {
  const keyPaths: string[] = [];
  // Two independent reasons the walk can be incomplete, tracked
  // separately: `depthTruncated` means ONE branch stopped early because it
  // hit the depth cap — sibling branches at the same or lower depth are
  // unaffected and must still be visited. `keyCountTruncated` means the
  // shared key-path budget ran out — that DOES stop the whole walk, since
  // there is nothing left to spend on any branch. Collapsing these into a
  // single flag that also gated recursion caused a real bug here: hitting
  // the depth cap on one nested branch (e.g. `chat.messagePayload.message`)
  // silently aborted an unrelated sibling branch (`chat.space`) that had
  // budget and depth left of its own.
  let depthTruncated = false;
  let keyCountTruncated = false;

  const visit = (node: unknown, prefix: string, depth: number): void => {
    if (keyCountTruncated) return;
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return;

    for (const key of Object.keys(node as Record<string, unknown>)) {
      if (keyPaths.length >= SHAPE_SUMMARY_MAX_KEYS) {
        keyCountTruncated = true;
        return;
      }
      const childPath = prefix ? `${prefix}.${capKeySegment(key)}` : capKeySegment(key);
      const child = (node as Record<string, unknown>)[key];

      if (Array.isArray(child)) {
        // Length only — never the elements themselves, which may be
        // strings of message text or nested objects with user content.
        keyPaths.push(`${childPath}[]:${child.length}`);
        continue;
      }
      if (child !== null && typeof child === 'object') {
        keyPaths.push(childPath);
        if (depth + 1 >= SHAPE_SUMMARY_MAX_DEPTH) {
          if (Object.keys(child as Record<string, unknown>).length > 0) depthTruncated = true;
          continue;
        }
        visit(child, childPath, depth + 1);
        if (keyCountTruncated) return;
        continue;
      }
      // A leaf: log only that this key exists, never `child`'s value.
      keyPaths.push(childPath);
    }
  };

  if (Array.isArray(payload)) {
    keyPaths.push(`[]:${payload.length}`);
  } else {
    visit(payload, '', 0);
  }

  return { keyPaths, truncated: depthTruncated || keyCountTruncated };
}
