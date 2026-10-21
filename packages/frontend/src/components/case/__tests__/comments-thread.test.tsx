/**
 * @file comments-thread — attachment content-loading states.
 *
 * Background: attachment content used to be a plain `<a href="/api/artifacts/
 * {id}/content">` navigation, which the browser fetches with no Authorization
 * header → 401. The fix routes it through the authenticated API client
 * (`api.artifacts.content`, see api-client.ts) behind an on-demand SWR call
 * gated by local `shouldLoad` state (comments-thread.tsx:81-94). This adds
 * the missing component test for `CommentAttachment` (rendered here through
 * the public `<CommentsThread>` — the sub-component itself isn't exported).
 *
 * Node-only per the frontend convention (renderToStaticMarkup, no jsdom, no
 * fireEvent/userEvent) — same pattern as decision-history.test.tsx /
 * decision-cluster.test.tsx. `swr` is replaced with a controllable fake that
 * dispatches on the SWR key, mirroring decision-history.test.tsx's
 * `swrState` object but extended to also capture the `fetcher` argument
 * (always passed positionally regardless of key), since we need it to model
 * two behaviours a single static render can't otherwise reach:
 *
 *   - `CommentAttachment`'s SWR key is built by `artifactContentSwrKey`
 *     (comments-thread.tsx:73-79): `null` unless both `shouldLoad` is true
 *     and a uid is known. `shouldLoad` is real `useState(false)` and can
 *     only flip via a real click, which is unreachable in a single SSR
 *     pass. So the "on demand" test asserts the REAL gate directly: every
 *     attachment's captured key is `null` on mount, and `api.artifacts
 *     .content` is never invoked — nothing is fetched eagerly. The key
 *     builder also includes the signed-in user's uid, so a cached artifact
 *     response can't leak across accounts in the same tab (`AuthProvider
 *     .signOut` neither reloads the app nor clears SWR's cache) — since
 *     `shouldLoad` can't be flipped here either, that scoping is exercised
 *     by calling `artifactContentSwrKey` directly (see the last describe
 *     block below) rather than through a full render.
 *   - "opening" an attachment / "retrying" are modelled by invoking the
 *     captured fetcher ourselves, which is exactly what SWR does once
 *     `shouldLoad` becomes true, or when the Retry button's parameterless
 *     `mutate()` (comments-thread.tsx:107) revalidates.
 *   - The click-driven spinner visual itself (`loading={shouldLoad &&
 *     (isLoading || isValidating)}`, comments-thread.tsx:120) can't be
 *     exercised without jsdom — consistent with the limits documented in
 *     helper-bot-drawer.test.tsx / lifecycle-tracker.test.tsx — so it is not
 *     asserted here. The "pending" test below covers what IS observable
 *     from render alone: no content or error leaks while unresolved.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import useSWR from 'swr';
import type { Artifact, Comment } from '@arbitra/shared';
import { CommentsThread, artifactContentSwrKey } from '../comments-thread';
import { api } from '../../../lib/api-client';
import { ToastProvider } from '../../../providers/toast-provider';

vi.mock('../../../hooks/use-users', () => ({
  useUserMap: () => ({}),
}));

vi.mock('../../../lib/api-client', () => ({
  api: {
    cases: {
      comments: vi.fn(),
      addComment: vi.fn(),
    },
    findings: {
      comments: vi.fn(),
      addComment: vi.fn(),
    },
    artifacts: {
      content: vi.fn(),
    },
  },
}));

vi.mock('swr', () => ({ default: vi.fn() }));

type CommentsSwrState = {
  data?: { comments: Comment[] };
  error?: unknown;
  isLoading: boolean;
  mutate: () => void;
};

type AttachmentSwrState = {
  data?: string;
  error?: unknown;
  isLoading?: boolean;
  isValidating?: boolean;
  mutate?: () => void;
};

type CapturedSwrCall = { key: unknown; fetcher: () => Promise<unknown> };

const mockedUseSWR = useSWR as unknown as ReturnType<typeof vi.fn>;

let commentsState: CommentsSwrState;
// Per-attachment forced states, matched positionally to render order.
// Leave empty (or shorter than the attachment count) to fall through to
// the idle default for entries not explicitly forced.
let attachmentStates: AttachmentSwrState[];
let attachmentCallOrder: CapturedSwrCall[];

/**
 * `noUncheckedIndexedAccess` makes `attachmentCallOrder[i]` a
 * `CapturedSwrCall | undefined`. Rather than assert it away, fail the test
 * loudly if a call we expect to have been captured is actually missing —
 * that would mean the render captured fewer SWR calls than the test thinks
 * it did, which is itself a bug worth surfacing, not silencing.
 */
function requireCapturedCall(index: number): CapturedSwrCall {
  const call = attachmentCallOrder[index];
  if (!call) {
    throw new Error(
      `Expected a captured SWR call at index ${index}, but attachmentCallOrder only has ${attachmentCallOrder.length} entries.`,
    );
  }
  return call;
}

beforeEach(() => {
  commentsState = { data: { comments: [] }, error: undefined, isLoading: false, mutate: vi.fn() };
  attachmentStates = [];
  attachmentCallOrder = [];
  vi.mocked(api.artifacts.content).mockReset();

  mockedUseSWR.mockImplementation((key: unknown, fetcher?: () => Promise<unknown>) => {
    if (Array.isArray(key) && key[0] === 'comments') {
      return commentsState;
    }
    // Attachment call site (comments-thread.tsx:65-73). `key` is `null`
    // whenever `shouldLoad` is false — i.e. always, in a single SSR pass.
    const idx = attachmentCallOrder.length;
    attachmentCallOrder.push({ key, fetcher: fetcher! });
    return (
      attachmentStates[idx] ?? {
        data: undefined,
        error: undefined,
        isLoading: false,
        isValidating: false,
        mutate: vi.fn(),
      }
    );
  });
});

function makeArtifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    artifact_id: 'artifact_1',
    filename: 'screenshot.png',
    content_type: 'image/png',
    storage_path: 'gs://bucket/artifact_1',
    size_bytes: 2048,
    created_by: 'usr_1',
    created_at: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeComment(overrides: Partial<Comment> = {}): Comment {
  return {
    comment_id: 'comment_1',
    parent_type: 'case',
    parent_id: 'case_1',
    author_id: 'usr_1',
    body: 'See attached.',
    created_at: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function renderThread(): string {
  return renderToStaticMarkup(
    <ToastProvider>
      <CommentsThread caseId="case_1" parentType="case" parentId="case_1" />
    </ToastProvider>,
  );
}

describe('CommentAttachment — loaded', () => {
  it('renders the resolved image inline for an image attachment (asserts the <img> src)', () => {
    const attachment = makeArtifact({
      artifact_id: 'art_img',
      filename: 'diagram.png',
      content_type: 'image/png',
    });
    commentsState.data = { comments: [makeComment({ attachments: [attachment] })] };
    attachmentStates = [{ data: 'data:image/png;base64,AAECAw==' }];

    const html = renderThread();

    expect(html).toContain('src="data:image/png;base64,AAECAw=="');
    // The idle "Load" affordance is gone once content has resolved.
    expect(html).not.toContain(`aria-label="Load ${attachment.filename}"`);
  });

  it('renders a download link (not an inline image) for a non-image attachment (asserts the <a> href)', () => {
    const attachment = makeArtifact({
      artifact_id: 'art_pdf',
      filename: 'report.pdf',
      content_type: 'application/pdf',
    });
    commentsState.data = { comments: [makeComment({ attachments: [attachment] })] };
    attachmentStates = [{ data: 'data:application/pdf;base64,JVBERi0=' }];

    const html = renderThread();

    expect(html).toContain('href="data:application/pdf;base64,JVBERi0="');
    expect(html).toContain(`download="${attachment.filename}"`);
    expect(html).not.toContain('<img');
  });
});

describe('CommentAttachment — pending (request in flight, not yet resolved)', () => {
  it('shows only the load affordance while unresolved; no content and no error leak through', () => {
    const attachment = makeArtifact({
      artifact_id: 'art_pending',
      filename: 'trace.log',
      content_type: 'text/plain',
    });
    commentsState.data = { comments: [makeComment({ attachments: [attachment] })] };
    attachmentStates = [{ data: undefined, error: undefined, isLoading: true, isValidating: true }];

    const html = renderThread();

    expect(html).toContain(`aria-label="Load ${attachment.filename}"`);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<a href');
    expect(html).not.toContain('Failed to load attachment');
  });
});

describe('CommentAttachment — error with retry', () => {
  it('renders the inline error and a Retry control instead of content', () => {
    const attachment = makeArtifact({
      artifact_id: 'art_err',
      filename: 'crash.log',
      content_type: 'text/plain',
    });
    commentsState.data = { comments: [makeComment({ attachments: [attachment] })] };
    attachmentStates = [
      { data: undefined, error: new Error('Request failed: 401'), isLoading: false, isValidating: false },
    ];

    const html = renderThread();

    expect(html).toContain('Request failed: 401');
    expect(html).toContain('Retry');
    expect(html).not.toContain('<img');
    expect(html).not.toContain(`aria-label="Load ${attachment.filename}"`);
  });

  it('retry re-issues a request for the same attachment', async () => {
    const attachment = makeArtifact({
      artifact_id: 'art_err2',
      filename: 'crash.log',
      content_type: 'text/plain',
    });
    commentsState.data = { comments: [makeComment({ attachments: [attachment] })] };
    attachmentStates = [{ data: undefined, error: new Error('boom'), isLoading: false, isValidating: false }];
    vi.mocked(api.artifacts.content).mockResolvedValue('data:text/plain;base64,eA==');

    renderThread();
    expect(attachmentCallOrder).toHaveLength(1);
    const { fetcher } = requireCapturedCall(0);

    // The initial (failed) fetch.
    await fetcher();
    // Retry: the Retry button's onClick is `() => void mutate()`
    // (comments-thread.tsx:86). SWR's contract for a parameterless
    // `mutate()` is to revalidate by re-invoking the bound fetcher — so
    // calling the same captured fetcher again models exactly what retry
    // does.
    await fetcher();

    expect(api.artifacts.content).toHaveBeenCalledTimes(2);
    expect(api.artifacts.content).toHaveBeenNthCalledWith(1, 'art_err2');
    expect(api.artifacts.content).toHaveBeenNthCalledWith(2, 'art_err2');
  });
});

describe('CommentAttachment — on demand, not eager', () => {
  it('does not fetch any attachment content up front when a comment has several attachments', () => {
    const attachments = [
      makeArtifact({ artifact_id: 'art_a', filename: 'a.png', content_type: 'image/png' }),
      makeArtifact({ artifact_id: 'art_b', filename: 'b.png', content_type: 'image/png' }),
      makeArtifact({ artifact_id: 'art_c', filename: 'c.pdf', content_type: 'application/pdf' }),
    ];
    commentsState.data = { comments: [makeComment({ attachments })] };

    const html = renderThread();

    for (const attachment of attachments) {
      expect(html).toContain(`aria-label="Load ${attachment.filename}"`);
    }
    expect(html).not.toContain('<img');

    // The real production gate (comments-thread.tsx:66) disabled every
    // attachment's SWR key because `shouldLoad` starts false for each.
    expect(attachmentCallOrder).toHaveLength(3);
    for (const call of attachmentCallOrder) {
      expect(call.key).toBeNull();
    }
    // Nothing actually reached the API client.
    expect(api.artifacts.content).not.toHaveBeenCalled();
  });

  it('opening one attachment fetches only that one, not its siblings', async () => {
    const attachments = [
      makeArtifact({ artifact_id: 'art_x', filename: 'x.png', content_type: 'image/png' }),
      makeArtifact({ artifact_id: 'art_y', filename: 'y.png', content_type: 'image/png' }),
    ];
    commentsState.data = { comments: [makeComment({ attachments })] };
    vi.mocked(api.artifacts.content).mockResolvedValue('data:image/png;base64,eA==');

    renderThread();
    expect(attachmentCallOrder).toHaveLength(2);

    // Simulate the user opening ONLY the first attachment: this is exactly
    // what SWR does once `shouldLoad` flips true for that one instance — it
    // invokes the bound fetcher captured from comments-thread.tsx:67.
    await requireCapturedCall(0).fetcher();

    expect(api.artifacts.content).toHaveBeenCalledTimes(1);
    expect(api.artifacts.content).toHaveBeenCalledWith('art_x');
    expect(api.artifacts.content).not.toHaveBeenCalledWith('art_y');
  });
});

describe('CommentAttachment — SWR key is scoped to the signed-in user', () => {
  // `AuthProvider.signOut` neither reloads the app nor clears SWR's global
  // cache, so if the key were just the artifact id, a different user signing
  // in afterwards in the same tab could be served the previous user's
  // cached artifact bytes. `artifactContentSwrKey` (comments-thread.tsx) is
  // the exact function `CommentAttachment` calls to build its SWR key —
  // exercised directly here since real component state (`shouldLoad`)
  // cannot be flipped to `true` within a single SSR render (see file header).
  it('produces a different key for two different signed-in users on the same artifact id', () => {
    const keyForUserA = artifactContentSwrKey(true, 'art_shared', 'uid_a');
    const keyForUserB = artifactContentSwrKey(true, 'art_shared', 'uid_b');

    expect(keyForUserA).not.toEqual(keyForUserB);
    expect(keyForUserA).toEqual(['artifact-content', 'art_shared', 'uid_a']);
    expect(keyForUserB).toEqual(['artifact-content', 'art_shared', 'uid_b']);
  });

  it('stays null until the attachment is opened, even once a user is known', () => {
    // `shouldLoad` (local state, starts false) still gates the fetch — this
    // must remain true even after the identity fix, so nothing is fetched
    // eagerly just because a uid is available.
    expect(artifactContentSwrKey(false, 'art_shared', 'uid_a')).toBeNull();
  });

  it('stays null if no user is signed in yet, even once the attachment is opened', () => {
    // Guards against firing a request keyed on `undefined` before auth
    // resolves, which would otherwise let an anonymous fetch's cache entry
    // collide with nothing in particular — belt-and-braces with the
    // `shouldLoad` gate above.
    expect(artifactContentSwrKey(true, 'art_shared', undefined)).toBeNull();
  });
});
