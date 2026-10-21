import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GoogleChatReplyPoster,
  CHAT_MESSAGE_MAX_BYTES,
  truncateForChat,
  markdownToChatText,
  type ChatHttpResponse,
  type ChatHttpSend,
} from './chat-reply-poster.js';

function okResponse(status = 200): ChatHttpResponse {
  return { status, text: async () => '' };
}

function errorResponse(status: number, body = 'boom'): ChatHttpResponse {
  return { status, text: async () => body };
}

describe('GoogleChatReplyPoster.post', () => {
  const originalEnv = process.env['ARBITRA_CHAT_REPLIES_ENABLED'];

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env['ARBITRA_CHAT_REPLIES_ENABLED'];
    } else {
      process.env['ARBITRA_CHAT_REPLIES_ENABLED'] = originalEnv;
    }
  });

  it('posts a new top-level message with no thread/query when threadName is absent', async () => {
    const send = vi.fn<ChatHttpSend>().mockResolvedValue(okResponse());
    const poster = new GoogleChatReplyPoster(send);

    const result = await poster.post({ spaceName: 'spaces/AAAA' }, 'hello there');

    expect(result).toEqual({ ok: true });
    expect(send).toHaveBeenCalledTimes(1);
    const [url, body] = send.mock.calls[0]!;
    expect(url).toBe('https://chat.googleapis.com/v1/spaces/AAAA/messages');
    expect(url).not.toContain('messageReplyOption');
    const parsed = JSON.parse(body);
    expect(parsed).toEqual({ text: 'hello there' });
    expect(parsed.thread).toBeUndefined();
  });

  it('replies into an existing thread with thread.name in the body and REPLY_MESSAGE_OR_FAIL in the query', async () => {
    const send = vi.fn<ChatHttpSend>().mockResolvedValue(okResponse());
    const poster = new GoogleChatReplyPoster(send);

    const result = await poster.post(
      { spaceName: 'spaces/AAAA', threadName: 'spaces/AAAA/threads/BBBB' },
      'the answer',
    );

    expect(result).toEqual({ ok: true });
    const [url, body] = send.mock.calls[0]!;
    expect(url).toBe(
      'https://chat.googleapis.com/v1/spaces/AAAA/messages?messageReplyOption=REPLY_MESSAGE_OR_FAIL',
    );
    expect(url).toContain('spaces/AAAA');
    const parsed = JSON.parse(body);
    expect(parsed).toEqual({
      text: 'the answer',
      thread: { name: 'spaces/AAAA/threads/BBBB' },
    });
  });

  it('returns ok:false without throwing on a 4xx response', async () => {
    const send = vi.fn<ChatHttpSend>().mockResolvedValue(errorResponse(404));
    const poster = new GoogleChatReplyPoster(send);

    const result = await poster.post({ spaceName: 'spaces/AAAA' }, 'hi');

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('http_404');
  });

  it('returns ok:false without throwing on a 5xx response', async () => {
    const send = vi.fn<ChatHttpSend>().mockResolvedValue(errorResponse(503));
    const poster = new GoogleChatReplyPoster(send);

    const result = await poster.post({ spaceName: 'spaces/AAAA' }, 'hi');

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('http_503');
  });

  it('returns ok:false without throwing when credential resolution fails (unconfigured credentials)', async () => {
    const send = vi.fn<ChatHttpSend>().mockRejectedValue(
      new Error('Could not load the default credentials'),
    );
    const poster = new GoogleChatReplyPoster(send);

    await expect(poster.post({ spaceName: 'spaces/AAAA' }, 'hi')).resolves.toEqual({
      ok: false,
      reason: 'send_failed',
    });
  });

  it('returns ok:false without throwing on a network-level failure', async () => {
    const send = vi.fn<ChatHttpSend>().mockRejectedValue(new TypeError('fetch failed'));
    const poster = new GoogleChatReplyPoster(send);

    await expect(poster.post({ spaceName: 'spaces/AAAA' }, 'hi')).resolves.toEqual({
      ok: false,
      reason: 'send_failed',
    });
  });

  it('force-disables via ARBITRA_CHAT_REPLIES_ENABLED=false without ever calling send', async () => {
    process.env['ARBITRA_CHAT_REPLIES_ENABLED'] = 'false';
    const send = vi.fn<ChatHttpSend>().mockResolvedValue(okResponse());
    const poster = new GoogleChatReplyPoster(send);

    const result = await poster.post({ spaceName: 'spaces/AAAA' }, 'hi');

    expect(result).toEqual({ ok: false, reason: 'chat_replies_disabled' });
    expect(send).not.toHaveBeenCalled();
  });

  it('leaves delivery attempted when the env flag is unset or any other value', async () => {
    process.env['ARBITRA_CHAT_REPLIES_ENABLED'] = 'true';
    const send = vi.fn<ChatHttpSend>().mockResolvedValue(okResponse());
    const poster = new GoogleChatReplyPoster(send);

    const result = await poster.post({ spaceName: 'spaces/AAAA' }, 'hi');

    expect(result).toEqual({ ok: true });
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('GoogleChatReplyPoster.post — target validation', () => {
  // `spaceName`/`threadName` come from the inbound Chat payload and are
  // interpolated into the request path, so a malformed value must be
  // refused before it can reshape the URL.
  const malformedSpaces = [
    'spaces/AAA/messages?x=1',
    'spaces/AAA/../../v1/spaces/OTHER',
    'spaces/AAA#frag',
    'spaces/with space',
    'not-a-space',
    '',
  ];

  it.each(malformedSpaces)('refuses a malformed space name (%j) without sending', async (space) => {
    const send = vi.fn<ChatHttpSend>().mockResolvedValue(okResponse());
    const poster = new GoogleChatReplyPoster(send);

    const result = await poster.post({ spaceName: space }, 'hello');

    expect(result).toEqual({ ok: false, reason: 'invalid_target' });
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses a malformed thread name without sending', async () => {
    const send = vi.fn<ChatHttpSend>().mockResolvedValue(okResponse());
    const poster = new GoogleChatReplyPoster(send);

    const result = await poster.post(
      { spaceName: 'spaces/AAA', threadName: 'spaces/AAA/threads/X?y=1' },
      'hello',
    );

    expect(result).toEqual({ ok: false, reason: 'invalid_target' });
    expect(send).not.toHaveBeenCalled();
  });

  it('accepts well-formed space and thread names', async () => {
    const send = vi.fn<ChatHttpSend>().mockResolvedValue(okResponse());
    const poster = new GoogleChatReplyPoster(send);

    const result = await poster.post(
      { spaceName: 'spaces/AAA-bb_9', threadName: 'spaces/AAA-bb_9/threads/T-1_z' },
      'hello',
    );

    expect(result).toEqual({ ok: true });
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('truncateForChat', () => {
  it('never exceeds the byte ceiling even when the deep link alone is oversized', () => {
    // Degenerate but enforced: a link longer than the whole budget must not
    // produce a message that violates the ceiling this function enforces.
    const hugeLink = `https://example.test/${'x'.repeat(CHAT_MESSAGE_MAX_BYTES + 500)}`;
    const out = truncateForChat('body text that will be dropped', hugeLink);

    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(CHAT_MESSAGE_MAX_BYTES);
  });

  it('passes text through unchanged when under the byte budget', () => {
    const text = 'A short Clerk answer.';
    expect(truncateForChat(text, 'https://arbitra.example.com/cases/case_1')).toBe(text);
  });

  it('truncates text over the byte budget to at most the budget and includes the deep link', () => {
    const longText = 'word '.repeat(20_000); // ~100,000 bytes, well over budget
    const deepLink = 'https://arbitra.example.com/cases/case_abc123';

    const result = truncateForChat(longText, deepLink);

    const byteLength = new TextEncoder().encode(result).length;
    expect(byteLength).toBeLessThanOrEqual(CHAT_MESSAGE_MAX_BYTES);
    expect(result).toContain(deepLink);
  });

  it('never overshoots the byte budget even with multi-byte characters near the cut point', () => {
    // Every character here is a multi-byte UTF-8 emoji, so a naive
    // character-count trim would very likely overshoot the byte budget.
    const longText = '🎉'.repeat(20_000);
    const deepLink = 'https://arbitra.example.com/cases/case_emoji';

    const result = truncateForChat(longText, deepLink);

    const byteLength = new TextEncoder().encode(result).length;
    expect(byteLength).toBeLessThanOrEqual(CHAT_MESSAGE_MAX_BYTES);
    expect(result).toContain(deepLink);
  });
});

describe('markdownToChatText', () => {
  // Fails pre-fix: the double-asterisk bold branch of the emphasis regex
  // (chat-reply-poster.ts) — revert it and this reproduces the defect of
  // literal `**bold**` asterisks reaching Chat instead of its `*...*` bold.
  it('converts **bold** to Chat single-asterisk bold', () => {
    expect(markdownToChatText('This is **bold** text.')).toBe('This is *bold* text.');
    expect(markdownToChatText('This is __also bold__ text.')).toBe('This is *also bold* text.');
  });

  // Fails pre-fix (issue #946, gap 1): the emphasis regex tried the
  // double-asterisk bold branch first, which greedily-enough matches
  // "***text***" as "**" + boldStar("*text") + "**", leaving one stray
  // leading/trailing asterisk unconsumed on each side. Reverting the
  // triple-marker alternatives added to the regex in chat-reply-poster.ts
  // (i.e. dropping the `\*\*\*...\*\*\*|(?<!\w)___...___(?!\w)|` prefix
  // and the `tripleStar`/`tripleUnderscore` branches in the replacer)
  // reproduces `markdownToChatText('***critical***')` === '**critical**'
  // — literal double asterisks still reaching Chat, the exact defect class
  // this converter exists to fix.
  it('converts ***bold italic*** / ___bold italic___ to Chat combined *_bold italic_* syntax', () => {
    expect(markdownToChatText('This is ***critical*** to note.')).toBe('This is *_critical_* to note.');
    expect(markdownToChatText('This is ___critical___ to note.')).toBe('This is *_critical_* to note.');
  });

  it('converts a full sentence with en and em dashes end to end', () => {
    const input =
      'In the last 7 days (14–21 August UTC) **6 cases were closed** ' +
      '— completed and rejected together.';
    const expected =
      'In the last 7 days (14–21 August UTC) *6 cases were closed* ' +
      '— completed and rejected together.';
    expect(markdownToChatText(input)).toBe(expected);
  });

  it('converts standalone *italic*/_italic_ to Chat underscore italic without touching a preceding bold span', () => {
    // The tricky ordering case: a bold span's own single asterisks must
    // never be re-read as italic once the bold branch has already
    // consumed them.
    expect(markdownToChatText('**bold** and *italic* together')).toBe('*bold* and _italic_ together');
    expect(markdownToChatText('an _italic_ word')).toBe('an _italic_ word');
  });

  it('converts ~~strikethrough~~ to Chat single-tilde strikethrough', () => {
    expect(markdownToChatText('~~gone~~')).toBe('~gone~');
  });

  // Fails pre-fix: without the "not followed/preceded by whitespace" guard
  // on the emphasis regex, a hyphen-bullet list survives (hyphens are
  // never emphasis markers), but this pins the whole block down.
  it('leaves a hyphen bullet list unmangled', () => {
    const input = '- first item\n- second item\n- third item';
    expect(markdownToChatText(input)).toBe(input);
  });

  // Fails pre-fix: without the whitespace-adjacency guard, a naive
  // "*(.+?)*" pass matches from the first bullet's opening "*" all the way
  // to the second bullet's "*", swallowing the whole list into one
  // (wrong) italic span instead of leaving both bullets alone.
  it('does not mistake a leading "* " bullet for italic/bold emphasis', () => {
    const input = '* first item\n* second item\n* third item';
    expect(markdownToChatText(input)).toBe(input);
  });

  it('leaves a mixed bullet list line with genuine emphasis on another line unmangled', () => {
    const input = '* alpha\n* beta\n\nThe *beta* row is new.';
    expect(markdownToChatText(input)).toBe('* alpha\n* beta\n\nThe _beta_ row is new.');
  });

  // Fails pre-fix: without the code-span placeholder step, the inline
  // code's own asterisks (`*args, **kwargs`) get pulled into the emphasis
  // pass and the code content comes out mangled instead of verbatim.
  it('leaves inline code spans untouched even when they contain emphasis-like characters', () => {
    const input = 'call it as `*args, **kwargs` please';
    expect(markdownToChatText(input)).toBe(input);
  });

  it('leaves a fenced code block untouched, markdown emphasis inside included', () => {
    const input = 'before\n```\nconst x = **not bold**;\n_not italic_ either\n```\nafter';
    expect(markdownToChatText(input)).toBe(input);
  });

  // Fails pre-fix: without the heading step, "## Foo" is left with its
  // "#" markers instead of becoming plain text.
  it('strips a markdown heading down to plain text, losing the #', () => {
    expect(markdownToChatText('## Foo')).toBe('Foo');
    expect(markdownToChatText('# Top level\nbody text')).toBe('Top level\nbody text');
  });

  // Fails pre-fix: without the link step, "[label](url)" is posted
  // literally, brackets and parens included, instead of a form Chat can
  // auto-link.
  it('converts a markdown link to "label: url"', () => {
    expect(markdownToChatText('See [the case](https://arbitra.example.com/cases/case_1) for details.')).toBe(
      'See the case: https://arbitra.example.com/cases/case_1 for details.',
    );
  });

  it('converts a markdown link whose label repeats the url to the bare url alone', () => {
    const url = 'https://arbitra.example.com/cases/case_1';
    expect(markdownToChatText(`[${url}](${url})`)).toBe(url);
  });

  it('never lets a link conversion, or anything after it, mangle the url itself', () => {
    // A double underscore inside the url would, without URL protection,
    // get read by the bold branch and rewritten into asterisks.
    const url = 'https://arbitra.example.com/cases/case__neat__moor';
    expect(markdownToChatText(`[open it](${url})`)).toBe(`open it: ${url}`);
  });

  // Already works today (step 5 stashes every bare URL before the emphasis
  // pass runs at all), pinned down here so a future rewrite of the
  // emphasis step can't quietly regress it: a raw, non-markdown-link URL
  // containing "__" must survive untouched too, not just the markdown-link
  // form covered above.
  it('leaves a bare (non-markdown-link) URL containing a double underscore untouched', () => {
    const input = 'See https://arbitra.example.com/cases/case__neat__moor for the case.';
    expect(markdownToChatText(input)).toBe(input);
  });

  // Fails pre-fix (issue #946, gap 2): the bold-underscore branch
  // (`__(?!\s)([^\n]+?)(?<!\s)__`) had no restriction on what sits
  // immediately outside its delimiters, so it read the first token's
  // trailing "__" as an opener and the second token's leading "__" as the
  // matching closer, bridging both tokens into one bold span. Reverting
  // the `(?<!\w)`/`(?!\w)` guards added around the `__`/`_` alternatives in
  // chat-reply-poster.ts reproduces
  // `markdownToChatText('variable__one and variable__two are different')`
  // === 'variable*one and variable*two are different' — exactly the
  // corruption the issue reports.
  it('does not bridge two separate double-underscore identifier tokens on one line', () => {
    const input = 'variable__one and variable__two are different';
    expect(markdownToChatText(input)).toBe(input);
  });

  // Same guard, a second shape: a single identifier carrying its own
  // internal "__" pair (no second token needed to see the bug) must also
  // survive untouched rather than sprout a stray asterisk in the middle.
  it('leaves a double-underscore identifier with an internal pair unmangled', () => {
    const input = 'the feature__flag__enabled toggle';
    expect(markdownToChatText(input)).toBe(input);
  });

  // Already works today for a different reason (the single-underscore
  // italic branch's Chat output syntax is identical to its Markdown input
  // syntax, so even a same-token match is a no-op) — pinned down so a
  // future change to the italic-underscore output format can't silently
  // start corrupting ordinary snake_case identifiers.
  it('leaves underscores inside a single identifier unmangled', () => {
    const input = 'set my_variable_name to a new value';
    expect(markdownToChatText(input)).toBe(input);
  });

  // Two genuine, separately-spaced double-underscore bold spans on one
  // line must still both convert — the fix must reject the identifier
  // bridge above without breaking this legitimate case.
  it('still converts two genuine, separately spaced __bold__ spans on one line', () => {
    const input = 'This is __bold one__ and this is __bold two__ as well.';
    expect(markdownToChatText(input)).toBe('This is *bold one* and this is *bold two* as well.');
  });

  it('leaves plain text with a stray, unpaired asterisk alone', () => {
    const input = 'The price is $5 * quantity, unpaired on purpose.';
    expect(markdownToChatText(input)).toBe(input);
  });

  it('leaves plain text with no markdown at all completely unchanged', () => {
    const input = 'Nothing special here, just a normal sentence.';
    expect(markdownToChatText(input)).toBe(input);
  });

  it('never throws on empty or malformed input', () => {
    expect(markdownToChatText('')).toBe('');
    expect(() => markdownToChatText('**unterminated bold')).not.toThrow();
    expect(() => markdownToChatText('***unterminated triple')).not.toThrow();
    expect(() => markdownToChatText('__unterminated bold underscore')).not.toThrow();
    expect(() => markdownToChatText('```unterminated fence')).not.toThrow();
    expect(() => markdownToChatText('[broken](not a url')).not.toThrow();
  });

  // --- issue #953 regressions (the tokeniser rewrite) --------------------

  // Defect 3 (issue #953): the prior regex chain's combined emphasis regex
  // consumed markers via one greedy alternation, so a shorter alternative
  // (single `*`) could eat part of a longer span's own delimiters before
  // the longer alternative (`**`) ever got to look. Reproducing the old
  // implementation's alternation-based matching (instead of the tokeniser's
  // exact-run-length delimiter stack in `resolveChatEmphasis`) fails this:
  // it corrupts the inner `*and*` into the outer span's own asterisks,
  // yielding '*bold *and* italic*' — the exact reproduction issue #953
  // reports for this input.
  it('handles nested mixed markers correctly: outer ** with an inner *', () => {
    expect(markdownToChatText('**bold *and* italic**')).toBe('*bold _and_ italic*');
  });

  // Same defect class, underscore variant, from issue #953's second example.
  // The two inner `__` runs are each flanked by whitespace on BOTH sides
  // ("bold __ nested __ bold"), so per `computeEmphasisFlanking` they can
  // neither open nor close and stay literal; only the genuinely flanked
  // leading and trailing `__` pair up, wrapping everything between them
  // (including the two literal inner `__`s) in one bold span — content
  // preserved exactly, no marker lost or duplicated. Note: the OLD
  // regex-chain implementation happens to produce this SAME safe output for
  // this exact input too (its own whitespace-adjacency guard independently
  // keeps the middle runs inert) — this test does not itself reproduce a
  // pre-fix failure; the nested-`*`-inside-`**` test above is the one that
  // does. This test instead pins the tokeniser's own exact-run-length,
  // top-of-stack-only matching in `resolveChatEmphasis`: it would fail if
  // that were changed to search past a mismatched top-of-stack entry, or if
  // the whitespace-flanking check were loosened to let a both-sides-blank
  // run become a marker.
  it('handles nested mixed double-underscore markers without bridging the wrong pairs', () => {
    expect(markdownToChatText('__bold __ nested __ bold__')).toBe('*bold __ nested __ bold*');
  });

  // Task requirement: asymmetric marker counts must never leak a stray
  // marker into rendered content. Fails if `resolveChatEmphasis` matched
  // openers/closers by MINIMUM run length (CommonMark's own partial-match
  // rule) instead of requiring an exact run-length match — that would turn
  // this into a corrupted '**x*' (mismatched leftover asterisk) instead of
  // leaving the whole ambiguous run as literal text.
  it('leaves an asymmetric marker count (***x**) fully literal rather than corrupting it', () => {
    expect(markdownToChatText('***x**')).toBe('***x**');
  });

  // Task requirement: 4+ marker runs must be handled gracefully. Fails if
  // the `run >= 1 && run <= 3` candidate-range check in
  // `computeEmphasisFlanking` is widened to also treat run>=4 as a marker
  // candidate — that reintroduces exactly the kind of leftover-asterisk
  // corruption asymmetric runs produce (see the `***x**` test above).
  it('leaves a 4-or-more marker run fully literal', () => {
    expect(markdownToChatText('****text****')).toBe('****text****');
  });

  // Defect 2 (issue #953): the prior implementation stashed code/URL spans
  // behind literal NUL-digit-NUL placeholder strings embedded in the same
  // string it kept re-scanning, so real NUL-digit-NUL text in the input
  // collided with a placeholder and was silently dropped/swapped on
  // restore. The new tokeniser never builds such a shared placeholder
  // string — atoms are separate node objects, never re-serialized into text
  // that gets rescanned — so this is structurally impossible. Fails if
  // `markdownToChatText`/`tokenizeChatLine` were changed back to a
  // stash-into-the-same-string-and-restore-by-regex scheme.
  it('passes a literal NUL-digit-NUL sequence in the input straight through unchanged', () => {
    const input = `before  7  after and  42  too`;
    expect(markdownToChatText(input)).toBe(input);
  });

  // New in this rewrite (issue #953 asked for it explicitly, reversing the
  // module's previous "won't fix" call on this exact input): a bare single
  // asterisk immediately between two digits must never be read as emphasis.
  // Fails if the `ch === '*' && run === 1` digit-adjacency guard in
  // `computeEmphasisFlanking` is removed — reverting to the plain
  // whitespace-only check reads both asterisks as valid intraword emphasis
  // markers (matching real CommonMark's own rule for `*`) and corrupts this
  // into '2_3_4'.
  it('leaves unspaced arithmetic like 2*3*4 literal instead of reading it as emphasis', () => {
    expect(markdownToChatText('2*3*4')).toBe('2*3*4');
  });

  // The digit guard above is scoped to single asterisks only, so bold next
  // to a digit must keep converting — pinned here so the arithmetic fix
  // above can't be "generalized" into breaking this.
  it('still converts bold immediately adjacent to a digit (digit guard is single-* only)', () => {
    expect(markdownToChatText('3**bold**')).toBe('3*bold*');
  });

  describe('idempotency', () => {
    // Target per issue #953: converting twice should equal converting once,
    // wherever that is actually achievable. It is NOT achievable for Chat's
    // own bold output, and that is a property of the two syntaxes sharing a
    // token, not a bug in this converter — see the module doc's "Known,
    // accepted limitation: idempotency" section for the full reasoning.
    // Pinned here (rather than asserted equal) so a future change can't
    // silently start masking this, or silently "fix" it by making the
    // *first* pass wrong instead.
    it('is NOT idempotent for Chat bold output — documented, not a bug: Chat bold (*x*) is Markdown italic', () => {
      const once = markdownToChatText('**bold**');
      expect(once).toBe('*bold*');
      // Second pass reads the single-asterisk Chat-bold output as Markdown
      // italic, per the ambiguity the module doc calls out.
      expect(markdownToChatText(once)).toBe('_bold_');
    });

    it('is idempotent for plain text with no markdown', () => {
      const once = markdownToChatText('Nothing special here, just a normal sentence.');
      expect(markdownToChatText(once)).toBe(once);
    });

    // Chat's italic output (`_x_`) is also valid Markdown italic input, so
    // reading it again is a no-op — unlike bold, there is no syntax clash.
    it('is idempotent for Chat italic output', () => {
      const once = markdownToChatText('an *italic* word');
      expect(once).toBe('an _italic_ word');
      expect(markdownToChatText(once)).toBe(once);
    });

    it('is idempotent for text containing an inline code span', () => {
      const once = markdownToChatText('call it as `*args, **kwargs` please');
      expect(markdownToChatText(once)).toBe(once);
    });

    it('is idempotent for text containing a converted link', () => {
      const once = markdownToChatText(
        'See [the case](https://arbitra.example.com/cases/case_1) for details.',
      );
      expect(markdownToChatText(once)).toBe(once);
    });
  });
});
