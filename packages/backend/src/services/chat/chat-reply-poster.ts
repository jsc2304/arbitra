/**
 * ChatReplyPoster — posts Clerk's answer back into a Google Chat space/thread
 * (Slice F, `docs/specs/clerk-config-scheduling-chat.md` — "Clerk in Chat
 * (inbound channel)"). This is the FOUNDATION half of slice F: the poster
 * itself, callable once the `/api/chat/events` MESSAGE handler (built by a
 * sibling change) has a case and a thread to reply into.
 *
 * ## API shape — verified against Google's current docs (2026-08-20)
 *
 *   POST https://chat.googleapis.com/v1/{parent=spaces/*}/messages
 *   https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces.messages/create
 *
 * To reply INTO an existing thread rather than starting a new one, the
 * request carries `thread: { name: <threadName> }` in the body plus the
 * query parameter `messageReplyOption=REPLY_MESSAGE_OR_FAIL` — one of three
 * documented enum values (`MESSAGE_REPLY_OPTION_UNSPECIFIED` — the default,
 * starts a new thread; `REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`; and the one
 * used here, `REPLY_MESSAGE_OR_FAIL`, which errors instead of silently
 * starting a new thread if the named thread is gone — a stale thread should
 * surface as a failed reply, not a reply that quietly landed somewhere the
 * user isn't looking). When `threadName` is absent, no query parameter is
 * sent and the message starts a new top-level thread, matching the
 * unspecified-default behavior.
 *
 * App/bot authentication uses OAuth scope `https://www.googleapis.com/auth/chat.bot`
 * (same reference page, "Authorization scopes").
 *
 * ## Credentials — ADC + the `chat.bot` scope, no key file, no IAM role
 *
 * Verified live against a Google Cloud project while building this module:
 *
 *   1. `chat.googleapis.com` is already enabled on the project — no API
 *      enablement step needed.
 *   2. The Workspace add-on authorization identity
 *      (`service-<project-number>@gcp-sa-gsuiteaddons.iam.gserviceaccount.com`,
 *      see `packages/frontend/src/lib/chat-auth.ts`) signs INBOUND event
 *      tokens only. It is Google-managed — we cannot obtain its
 *      credentials — and it is never used for the outbound call this module
 *      makes; the two directions have different identities on purpose.
 *   3. Outbound, app-authenticated Chat calls use Google Chat's app-identity
 *      model: any service account belonging to this GCP project,
 *      authenticating with scope `chat.bot`. Chat associates the calling
 *      app with the project by SCOPE, not by IAM role — no extra IAM role
 *      grant is needed or expected for this to work.
 *   4. In production this runs on Cloud Run as a dedicated runtime service
 *      account (e.g. `arbitra-runner@<project-id>.iam.gserviceaccount.com`,
 *      flipped from the default compute SA in PR #917).
 *      `defaultChatHttpSend` below therefore does plain Application Default
 *      Credentials (`new GoogleAuth({ scopes: [CHAT_BOT_SCOPE] })` +
 *      `getClient()`) — on Cloud Run this resolves via the metadata server
 *      automatically. There is no service-account key file anywhere in this
 *      design, and none should ever be added: ADC is sufficient and a
 *      mounted key would be a credential this module does not need.
 *   5. Locally, or anywhere ADC has nothing to resolve (no metadata server,
 *      no `gcloud auth application-default login`), `getClient()` /
 *      `getAccessToken()` throws. Every failure mode below — that throw, a
 *      credential that resolves but Chat doesn't recognize, a network
 *      error, a non-2xx response — degrades to `{ok: false, reason}` and
 *      ONE warning log. This function must never throw: a caller posting a
 *      reply is always a best-effort notification after the real work (the
 *      Clerk answer) already happened, so a delivery failure here must
 *      never fail, retry, or roll back that work.
 *
 * `ARBITRA_CHAT_REPLIES_ENABLED=false` force-disables delivery outright
 * (ops kill switch, no redeploy needed). Any other value, or the var being
 * unset, leaves delivery attempted — whether it actually succeeds still
 * depends on credentials resolving, which is the "enabled if credentials
 * resolve" half: there is no separate "enabled" flag to flip once
 * credentials exist, because the credential-resolution failure path already
 * degrades to the same `{ok: false}` a hard disable would produce.
 *
 * ## Never logged
 *
 * Never the message text (it is, or quotes, a Clerk answer) and never a
 * user email — matching the `*_unverified`-field discipline in
 * `packages/frontend/src/app/api/chat/events/route.ts`. Only space/thread
 * resource names (opaque Google ids, not user identifiers) and numeric
 * status codes are logged.
 */

const CHAT_BOT_SCOPE = 'https://www.googleapis.com/auth/chat.bot';

/**
 * Google Chat's current documented message-size ceiling: "The maximum
 * message size (including any text or cards) is 32,000 bytes."
 * https://developers.google.com/chat/api/guides/message-formats/text
 * (verified 2026-08-20). This supersedes the older, webhook-era 4096
 * *character* limit some Chat surfaces still enforce — this poster uses the
 * REST API (`spaces.messages.create`), not a webhook, so the byte-based
 * 32,000 figure is the one that actually applies here. Measured in UTF-8
 * BYTES, not JS string length: an answer routinely contains multi-byte
 * characters (umlauts, `…`), so a naive character-count budget could still
 * overshoot the real ceiling.
 */
export const CHAT_MESSAGE_MAX_BYTES = 32_000;

export interface ChatReplyTarget {
  spaceName: string;
  threadName?: string | undefined;
}

export interface ChatReplyResult {
  ok: boolean;
  reason?: string | undefined;
}

export interface ChatReplyPoster {
  post(target: ChatReplyTarget, text: string): Promise<ChatReplyResult>;
}

/**
 * Minimal shape read off the HTTP response — satisfied structurally by both
 * a real `fetch` `Response` and a test fake, so tests never need to
 * construct a real `Response` object.
 */
export interface ChatHttpResponse {
  status: number;
  text(): Promise<string>;
}

/**
 * The single injectable seam covering BOTH credential resolution and the
 * network call — mirroring `GoogleChatNotifier`'s injectable `sleep`
 * (`packages/backend/src/services/notification/google-chat-notifier.ts`).
 * One seam, not two, because the two failure modes this module must never
 * throw on (no credentials; a bad HTTP response) are exercised by a test
 * simply choosing to reject vs. resolve `send` — no second seam needed to
 * tell them apart.
 */
export type ChatHttpSend = (url: string, body: string) => Promise<ChatHttpResponse>;

/**
 * Wall-clock ceiling for the whole outbound attempt (credential resolution
 * plus the Chat API POST). This module is called from the notification path;
 * an un-timeboxed metadata-server or Chat API stall would hang that path
 * indefinitely. Same `AbortSignal.timeout` discipline the repo already
 * applies to outbound HTTP elsewhere.
 */
const CHAT_SEND_TIMEOUT_MS = 10_000;

async function defaultChatHttpSend(url: string, body: string): Promise<ChatHttpResponse> {
  // Credential resolution: plain ADC scoped to `chat.bot` — on Cloud Run
  // this resolves to the `arbitra-runner` runtime service account via the
  // metadata server; locally it throws when nothing is configured. No key
  // file, no IAM role grant — see module doc's "Credentials" section.
  //
  // The credential half is raced against the same deadline as the POST: a
  // hung metadata server is exactly as damaging as a hung Chat API, and
  // `AbortSignal.timeout` only covers `fetch`.
  const deadline = new Promise<never>((_resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Chat credential resolution exceeded ${CHAT_SEND_TIMEOUT_MS}ms`)),
      CHAT_SEND_TIMEOUT_MS,
    );
    // Never keep the process alive just for this watchdog.
    timer.unref?.();
  });

  const token = await Promise.race([
    (async () => {
      const { GoogleAuth } = await import('google-auth-library');
      const auth = new GoogleAuth({ scopes: [CHAT_BOT_SCOPE] });
      const client = await auth.getClient();
      const { token } = await client.getAccessToken();
      if (!token) {
        throw new Error('Google credentials resolved but returned no access token');
      }
      return token;
    })(),
    deadline,
  ]);

  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      Authorization: `Bearer ${token}`,
    },
    body,
    signal: AbortSignal.timeout(CHAT_SEND_TIMEOUT_MS),
  });
}

/**
 * Google Chat resource-name shapes, per the Chat REST reference:
 * spaces are `spaces/{space}` and threads `spaces/{space}/threads/{thread}`.
 * Both segments are opaque ids; these patterns deliberately reject anything
 * carrying `/`, `?`, `#`, `..` or whitespace so a malformed value can never
 * reshape the request path.
 */
const CHAT_SPACE_NAME_PATTERN = /^spaces\/[A-Za-z0-9_-]+$/;
const CHAT_THREAD_NAME_PATTERN = /^spaces\/[A-Za-z0-9_-]+\/threads\/[A-Za-z0-9_-]+$/;

/** `ARBITRA_CHAT_REPLIES_ENABLED=false` (or `0`) is the only way to force-disable; every other value (including unset) leaves delivery attempted. */
function chatRepliesForceDisabled(): boolean {
  const flag = process.env['ARBITRA_CHAT_REPLIES_ENABLED'];
  return flag === 'false' || flag === '0';
}

export class GoogleChatReplyPoster implements ChatReplyPoster {
  /**
   * @param send Injectable authenticated-POST seam, defaulting to the real
   *   GoogleAuth + `fetch` path. Tests inject a stub that either resolves
   *   with a status (to exercise the 2xx/4xx/5xx branches) or rejects (to
   *   simulate a credential/network failure) without ever touching a real
   *   network call or real credentials.
   */
  constructor(private readonly send: ChatHttpSend = defaultChatHttpSend) {}

  async post(target: ChatReplyTarget, text: string): Promise<ChatReplyResult> {
    if (chatRepliesForceDisabled()) {
      return { ok: false, reason: 'chat_replies_disabled' };
    }

    // `spaceName`/`threadName` originate in the inbound Chat event payload,
    // i.e. they are attacker-influenced if the JWT gate were ever bypassed,
    // and they are interpolated straight into the request path below. The
    // host is a fixed literal so this is not host-takeover SSRF, but an
    // unvalidated segment could still reshape the path. Validate the
    // documented resource-name shapes before use — the sibling
    // `GoogleChatNotifier` validates its webhook URL for the same reason.
    if (!CHAT_SPACE_NAME_PATTERN.test(target.spaceName)) {
      console.warn('[ChatReplyPoster] Refusing to send: malformed space name');
      return { ok: false, reason: 'invalid_target' };
    }
    if (target.threadName !== undefined && !CHAT_THREAD_NAME_PATTERN.test(target.threadName)) {
      console.warn('[ChatReplyPoster] Refusing to send: malformed thread name');
      return { ok: false, reason: 'invalid_target' };
    }

    const query = target.threadName ? '?messageReplyOption=REPLY_MESSAGE_OR_FAIL' : '';
    const url = `https://chat.googleapis.com/v1/${target.spaceName}/messages${query}`;
    const body = JSON.stringify(
      target.threadName ? { text, thread: { name: target.threadName } } : { text },
    );

    try {
      const response = await this.send(url, body);
      if (response.status >= 200 && response.status < 300) {
        return { ok: true };
      }
      // Only the numeric status is logged — never the response body (could
      // echo request content back) and never `text`/emails, per module doc.
      console.warn(`[ChatReplyPoster] Chat API returned ${response.status}; reply not delivered`);
      return { ok: false, reason: `http_${response.status}` };
    } catch (err) {
      console.warn(
        '[ChatReplyPoster] Reply not delivered (credential resolution or network failure):',
        err instanceof Error ? err.message : String(err),
      );
      return { ok: false, reason: 'send_failed' };
    }
  }
}

let singleton: ChatReplyPoster | undefined;

/** Singleton accessor — callers never construct `GoogleChatReplyPoster` directly. */
export function getChatReplyPoster(): ChatReplyPoster {
  if (!singleton) {
    singleton = new GoogleChatReplyPoster();
  }
  return singleton;
}

/** Test seam: inject a fake poster, or pass `null` to restore the real singleton. */
export function setChatReplyPosterForTesting(p: ChatReplyPoster | null): void {
  singleton = p ?? undefined;
}

/**
 * Converts the Markdown a Clerk answer is written in into Google Chat's
 * OWN lightweight text syntax, which is NOT Markdown and does not render
 * `**bold**` — without conversion a literal `**bold**` would reach the
 * delivered message.
 *
 * ## Why conversion, not a `markup_syntax` request field
 *
 * Google's `format-messages` guide says a message can use either Chat's own
 * original syntax (the default) or standard Markdown, "supported by
 * specifying `markup_syntax` in the request body" —
 * https://developers.google.com/workspace/chat/format-messages
 * (fetched 2026-08-21). Do not take that at face value: the field does not
 * appear to exist. The `spaces.messages` REST reference lists no
 * `markup_syntax`/`markupSyntax` among the Message fields or the
 * `spaces.messages.create` parameters, the anchor the guide links to is
 * absent from that page, and the generated client libraries have no such
 * accessor (all three re-checked 2026-08-21). The only
 * confirmed Markdown switch in this API family is `TextParagraph.TextSyntax`,
 * which belongs to the Cards v2 widget — not the plain `text` field this
 * poster sends; using it would mean rebuilding every reply as a Card.
 * So conversion is not the second-best option here, it is the only viable
 * one for plain-text messages, and messages this poster sends are always
 * interpreted as original Chat syntax. This function targets THAT syntax:
 *
 *   | meaning       | Chat syntax | Markdown (what Clerk writes)   |
 *   |---------------|-------------|---------------------------------|
 *   | bold          | `*x*`       | `**x**` or `__x__`              |
 *   | italic        | `_x_`       | `*x*` or `_x_`                  |
 *   | bold+italic   | `*_x_*`     | `***x***` or `___x___`          |
 *   | strikethrough | `~x~`       | `~~x~~`                         |
 *   | inline code   | `` `x` ``   | same — both support it          |
 *   | code block    | ` ```x``` ` | same — both support it          |
 *   | bullet list   | `* x`/`- x` | same — both render it           |
 *   | link          | `<url\|x>`  | `[x](url)`                      |
 *
 * ## Implementation: a single-pass tokeniser, not a regex chain
 *
 * A prior implementation ran a fixed chain of global regex `.replace()`
 * calls, stashing code spans and URLs behind NUL-wrapped placeholder
 * strings and re-scanning the *result* of each step with the next regex.
 * That shape had three confirmed defects (issue #953): (1) it wasn't
 * idempotent for nested/complex input, since intermediate output could be
 * re-read as Markdown by a later step; (2) a literal NUL-digit-NUL
 * sequence already present in the input text collided with a real
 * placeholder and got silently deleted or swapped on restore; (3) nested
 * mixed markers (`**bold *and* italic**`) corrupted, because a shorter
 * marker alternative could consume part of a longer span's own delimiters
 * before the longer alternative ever saw them.
 *
 * This version tokenises each line once into a flat node list — text runs,
 * atomic spans (inline code, links, bare URLs — rendered verbatim, never
 * re-scanned), and emphasis-delimiter runs (`*`, `_`, `~`) — then resolves
 * delimiter runs into opener/closer pairs with a small delimiter-stack
 * scan (the same technique CommonMark's own reference implementation uses
 * for nested emphasis), and finally renders the resolved tree recursively.
 * Defect (2) disappears structurally: there is no shared string that a
 * "restore" pass re-scans, so a literal NUL-digit-NUL run in the input is
 * just ordinary text. Defect (3) disappears because nesting is resolved by
 * matching *exact* delimiter-run lengths on a stack (innermost pair
 * first), not by a single greedy regex alternation.
 *
 * ### Delimiter-run rules (kept intentionally conservative)
 *
 * A run of 1/2/3 identical `*`/`_` characters is a candidate emphasis
 * marker (italic / bold / bold+italic respectively); a run of 4+ is always
 * literal text — never partially consumed — per the "when in doubt, leave
 * ambiguous markers as literal" design goal. `~~` (exactly two) is the only
 * strikethrough run length; any other tilde run length is literal.
 *
 * - A run can OPEN only if the character immediately following it exists
 *   and is not whitespace; it can CLOSE only if the character immediately
 *   preceding it exists and is not whitespace. (Mirrors the old regex's
 *   `(?!\s)`/`(?<!\s)` adjacency guards.)
 * - `_`/`__`/`___` additionally cannot open if the character immediately
 *   before the run is a word character (`\w`, i.e. letter/digit/`_`), and
 *   cannot close if the character immediately after is a word character —
 *   CommonMark's "no intraword underscore emphasis" rule. This is what
 *   keeps `variable__one and variable__two` from bridging the first
 *   token's trailing `__` with the second token's leading `__` into one
 *   (corrupting) bold span, and keeps `my_variable_name` untouched.
 * - A single `*` additionally cannot open if immediately preceded by a
 *   digit, and cannot close if immediately followed by a digit — this is
 *   new versus the prior implementation (which deliberately left it
 *   unfixed) and exists solely to keep unspaced arithmetic like `2*3*4`
 *   literal. It only applies to a *single* asterisk, so digit-adjacent
 *   bold/bold-italic (`3**bold**`) is unaffected.
 * - When a closer's run length doesn't exactly match the nearest active
 *   opener of the same character, no match is attempted (no partial-length
 *   pairing) — the closer stays literal and the opener stays on the stack
 *   for a possible later exact match, or is flushed as literal text at the
 *   end of the line. This is what keeps asymmetric counts (`***x**`) and
 *   4+ runs from ever leaking a stray marker into rendered content: the
 *   worst case is the whole ambiguous run staying untouched, never a
 *   half-consumed span.
 * - A bullet line's opening marker (`* item`) is followed by a space, so it
 *   can never open a span (and, being line-initial, can never close one
 *   either) — it is simply literal, and a hyphen bullet (`- item`) was
 *   never a marker character to begin with.
 *
 * Code spans, fenced code blocks, markdown links, and bare URLs are parsed
 * as atomic tokens up front (never turned into a placeholder string that
 * re-enters scanning) and rendered back verbatim, so their content —
 * including `*`, `_`, `#`, backticks — is never touched. A markdown link's
 * `[label](url)` becomes `label: url` (or the bare `url` alone when the
 * label duplicates it): the label re-enters tokenising (so emphasis inside
 * a link label, or a bold span wrapping a whole link, still resolves
 * correctly against the surrounding text) while the URL itself is always
 * an atomic, unprocessed token. Markdown headings lose their leading `#`s
 * and the remaining text re-enters the same per-line tokenising pass (so a
 * heading containing a link or emphasis still converts).
 *
 * The whole function is wrapped so a bug here degrades to the original,
 * unconverted text rather than ever throwing.
 *
 * ### Known, accepted limitation: idempotency
 *
 * Applying this function twice is NOT a no-op for text containing Chat's
 * own bold output (`*x*`): Chat's single-asterisk bold is byte-for-byte
 * identical to Markdown's single-asterisk italic, so a second pass
 * necessarily re-reads already-converted bold as Markdown italic and
 * re-emits it as `_x_` (`markdownToChatText('**bold**')` gives `'*bold*'`;
 * running that result back through gives `'_bold_'`). This is not a
 * converter bug to fix — it is the same ambiguity called out in the syntax
 * table above, and no single-pass Markdown-to-Chat converter can tell
 * "already Chat bold" apart from "Markdown italic" for identical input
 * without an out-of-band marker neither syntax provides. Idempotency does
 * hold for every shape that isn't hit by this ambiguity — plain text,
 * Chat's italic output (`_x_`, which is *also* valid Markdown italic input,
 * so re-reading it is a no-op), code spans, and links — see the
 * `markdownToChatText` idempotency tests for the pinned-down boundary.
 */
type EmphasisChar = '*' | '_' | '~';

type ChatTextNode =
  | { readonly t: 'text'; readonly s: string }
  | { readonly t: 'atom'; readonly s: string }
  | {
      readonly t: 'delim';
      readonly ch: EmphasisChar;
      readonly run: number;
      readonly raw: string;
      readonly canOpen: boolean;
      readonly canClose: boolean;
      resolved: boolean;
      role?: 'opener' | 'closer';
      pairIndex?: number;
    };

const CHAT_HEADING_RE = /^ {0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const CHAT_LINK_RE = /^\[([^[\]\n]+)\]\((https?:\/\/[^\s()]+)\)/;
const CHAT_BARE_URL_RE = /^https?:\/\/[^\s)]+/;
const CHAT_INLINE_CODE_RE = /^`([^`\n]+)`/;

const isWhitespaceChar = (c: string | undefined): boolean => c === undefined || /\s/.test(c);
const isWordChar = (c: string | undefined): boolean => c !== undefined && /\w/.test(c);
const isDigitChar = (c: string | undefined): boolean => c !== undefined && /[0-9]/.test(c);

/**
 * Whether a run of `run` copies of `ch` can open and/or close an emphasis
 * span, given the single characters immediately outside the run on each
 * side. See the module doc's "Delimiter-run rules" section.
 */
function computeEmphasisFlanking(
  ch: EmphasisChar,
  run: number,
  prevChar: string | undefined,
  nextChar: string | undefined,
): { canOpen: boolean; canClose: boolean } {
  const inCandidateRange = ch === '~' ? run === 2 : run >= 1 && run <= 3;
  if (!inCandidateRange) {
    return { canOpen: false, canClose: false };
  }

  let canOpen = !isWhitespaceChar(nextChar);
  let canClose = !isWhitespaceChar(prevChar);

  if (ch === '_') {
    canOpen = canOpen && !isWordChar(prevChar);
    canClose = canClose && !isWordChar(nextChar);
  } else if (ch === '*' && run === 1) {
    canOpen = canOpen && !isDigitChar(prevChar);
    canClose = canClose && !isDigitChar(nextChar);
  }

  return { canOpen, canClose };
}

/**
 * Tokenises one line (never crosses a `\n`) into a flat, ordered node list.
 * Inline code, markdown links, and bare URLs are consumed as atomic tokens
 * in this same left-to-right scan — never stashed into a placeholder string
 * that a later pass re-scans, which is what makes a literal NUL-digit-NUL
 * run in the input inert (defect 2 in issue #953 is structurally
 * impossible here). A link's label recurses back into this function and
 * its nodes are spliced directly into the surrounding sequence (not kept
 * in an isolated sub-scope), so emphasis can still open before a link and
 * close after it.
 */
function tokenizeChatLine(raw: string): ChatTextNode[] {
  const nodes: ChatTextNode[] = [];
  let textBuf = '';
  const flushText = (): void => {
    if (textBuf) {
      nodes.push({ t: 'text', s: textBuf });
      textBuf = '';
    }
  };

  let i = 0;
  while (i < raw.length) {
    const c = raw[i]!;

    if (c === '`') {
      const m = CHAT_INLINE_CODE_RE.exec(raw.slice(i));
      if (m) {
        flushText();
        nodes.push({ t: 'atom', s: m[0] });
        i += m[0].length;
        continue;
      }
      textBuf += c;
      i += 1;
      continue;
    }

    if (c === '[') {
      const m = CHAT_LINK_RE.exec(raw.slice(i));
      if (m) {
        const label = m[1]!;
        const url = m[2]!;
        flushText();
        if (label.trim() === url) {
          nodes.push({ t: 'atom', s: url });
        } else {
          nodes.push(...tokenizeChatLine(label));
          nodes.push({ t: 'text', s: ': ' });
          nodes.push({ t: 'atom', s: url });
        }
        i += m[0].length;
        continue;
      }
      textBuf += c;
      i += 1;
      continue;
    }

    if (c === 'h') {
      const m = CHAT_BARE_URL_RE.exec(raw.slice(i));
      if (m) {
        flushText();
        nodes.push({ t: 'atom', s: m[0] });
        i += m[0].length;
        continue;
      }
      textBuf += c;
      i += 1;
      continue;
    }

    if (c === '*' || c === '_' || c === '~') {
      let j = i;
      while (j < raw.length && raw[j] === c) j++;
      const run = j - i;
      const prevChar = i > 0 ? raw[i - 1] : undefined;
      const nextChar = j < raw.length ? raw[j] : undefined;
      const { canOpen, canClose } = computeEmphasisFlanking(c, run, prevChar, nextChar);
      flushText();
      nodes.push({
        t: 'delim',
        ch: c,
        run,
        raw: raw.slice(i, j),
        canOpen,
        canClose,
        resolved: false,
      });
      i = j;
      continue;
    }

    textBuf += c;
    i += 1;
  }

  flushText();
  return nodes;
}

/**
 * Delimiter-stack pass: walks `nodes` once, and for every delimiter node
 * that can close, tries the nearest still-open opener of the SAME
 * character AND SAME run length (exact match only — see module doc on why
 * mismatched counts are left unresolved rather than partially paired).
 * A delimiter that fails to close but can open becomes a new opener
 * candidate for what follows ("try close, then open"). Mutates `nodes` in
 * place; anything left unresolved at the end simply renders as literal
 * marker text in `renderChatNodes`.
 */
function resolveChatEmphasis(nodes: ChatTextNode[]): void {
  const stack: number[] = [];

  for (let idx = 0; idx < nodes.length; idx++) {
    const n = nodes[idx]!;
    if (n.t !== 'delim') continue;

    let closed = false;
    if (n.canClose && stack.length > 0) {
      const topIdx = stack[stack.length - 1]!;
      const top = nodes[topIdx]!;
      if (top.t === 'delim' && top.ch === n.ch && top.run === n.run) {
        stack.pop();
        top.resolved = true;
        top.role = 'opener';
        top.pairIndex = idx;
        n.resolved = true;
        n.role = 'closer';
        n.pairIndex = topIdx;
        closed = true;
      }
    }

    if (!closed && n.canOpen) {
      stack.push(idx);
    }
  }
}

function wrapChatEmphasis(ch: EmphasisChar, run: number, inner: string): string {
  if (ch === '~') return `~${inner}~`;
  if (run === 3) return `*_${inner}_*`;
  if (run === 2) return `*${inner}*`;
  return `_${inner}_`; // run === 1
}

/** Renders the resolved node tree for `nodes[start..end]` (inclusive) to Chat syntax. */
function renderChatNodes(nodes: ChatTextNode[], start: number, end: number): string {
  let out = '';
  let i = start;
  while (i <= end) {
    const n = nodes[i]!;
    if (n.t === 'text' || n.t === 'atom') {
      out += n.s;
      i++;
      continue;
    }
    // n.t === 'delim'
    if (n.resolved && n.role === 'opener') {
      const pairIndex = n.pairIndex!;
      const inner = renderChatNodes(nodes, i + 1, pairIndex - 1);
      out += wrapChatEmphasis(n.ch, n.run, inner);
      i = pairIndex + 1;
      continue;
    }
    if (n.resolved && n.role === 'closer') {
      // The matching opener already rendered this span and jumped past it;
      // only reachable defensively (e.g. a caller rendering a sub-range).
      i++;
      continue;
    }
    out += n.raw; // unresolved run -> literal marker text
    i++;
  }
  return out;
}

/** Heading-strip + tokenise + resolve + render for exactly one line (never crosses `\n`). */
function convertChatLine(line: string): string {
  const headingMatch = CHAT_HEADING_RE.exec(line);
  const content = headingMatch ? headingMatch[1]!.trim() : line;
  const nodes = tokenizeChatLine(content);
  resolveChatEmphasis(nodes);
  return renderChatNodes(nodes, 0, nodes.length - 1);
}

/**
 * Splits `text` into fenced-code-block segments (rendered verbatim,
 * backticks included — both syntaxes support ` ```code``` ` identically)
 * and plain segments (further processed line by line). An unterminated
 * fence (no closing ` ``` ` anywhere after it) is never treated as a fence
 * start — it is left for the plain-text/inline-code path, matching the
 * "never throws, degrades to something reasonable" contract.
 */
function splitChatFences(text: string): Array<{ fence: boolean; text: string }> {
  const segments: Array<{ fence: boolean; text: string }> = [];
  let pos = 0;
  let searchFrom = 0;

  while (true) {
    const start = text.indexOf('```', searchFrom);
    if (start === -1) break;
    const closeAt = text.indexOf('```', start + 3);
    if (closeAt === -1) {
      // No valid close from here; keep looking for a later, well-formed
      // fence rather than giving up on the whole rest of the text.
      searchFrom = start + 1;
      continue;
    }
    if (start > pos) {
      segments.push({ fence: false, text: text.slice(pos, start) });
    }
    segments.push({ fence: true, text: text.slice(start, closeAt + 3) });
    pos = closeAt + 3;
    searchFrom = pos;
  }

  if (pos < text.length) {
    segments.push({ fence: false, text: text.slice(pos) });
  }
  return segments;
}

export function markdownToChatText(text: string): string {
  try {
    if (!text) return text;

    return splitChatFences(text)
      .map((seg) => (seg.fence ? seg.text : seg.text.split('\n').map(convertChatLine).join('\n')))
      .join('');
  } catch (err) {
    console.warn('[ChatReplyPoster] markdownToChatText failed, sending original text:', err);
    return text;
  }
}

/**
 * Fits `text` under `CHAT_MESSAGE_MAX_BYTES` (see that constant's doc for
 * the source), cutting at the nearest word boundary and appending
 * `deepLink` so the full answer stays reachable when the body is cut. Text
 * already under budget passes through completely unchanged — no link is
 * appended when nothing was cut.
 */
/** Largest prefix of `value` whose UTF-8 encoding fits `maxBytes`. */
function truncateRawToBytes(
  value: string,
  maxBytes: number,
  encoder: InstanceType<typeof TextEncoder>,
): string {
  let lo = 0;
  let hi = value.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (encoder.encode(value.slice(0, mid)).length <= maxBytes) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return value.slice(0, lo);
}

export function truncateForChat(text: string, deepLink: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= CHAT_MESSAGE_MAX_BYTES) {
    return text;
  }

  const suffix = `\n\n… (truncated — full answer: ${deepLink})`;
  const suffixBytes = encoder.encode(suffix).length;

  // Degenerate case: a deep link long enough that the suffix alone would
  // blow the ceiling. Returning body+suffix anyway would violate the exact
  // invariant this function exists to enforce, so the link wins — it is the
  // only part that keeps the full answer reachable. Unreachable with today's
  // short case URLs; enforced rather than assumed.
  if (suffixBytes >= CHAT_MESSAGE_MAX_BYTES) {
    return truncateRawToBytes(deepLink, CHAT_MESSAGE_MAX_BYTES, encoder);
  }

  const budget = CHAT_MESSAGE_MAX_BYTES - suffixBytes;

  // Binary search the largest character-count prefix whose UTF-8 encoding
  // still fits `budget` bytes. A naive character-count trim could overshoot:
  // a multi-byte character sitting exactly at the cut point encodes to more
  // bytes than characters.
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (encoder.encode(text.slice(0, mid)).length <= budget) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  let cut = lo;

  // Prefer cutting at a word boundary within the last ~80 characters of the
  // budget so the truncated body doesn't end mid-word.
  const boundaryWindowStart = Math.max(0, cut - 80);
  const lastSpace = text.lastIndexOf(' ', cut);
  if (lastSpace > boundaryWindowStart) {
    cut = lastSpace;
  }

  return text.slice(0, cut).trimEnd() + suffix;
}
