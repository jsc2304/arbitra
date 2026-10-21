/**
 * @file clerk-context-panel — the list, the editor's rendering contract, and
 * the create/update/delete logic (#832 slice A).
 *
 * Node-only per the frontend convention (renderToStaticMarkup, no jsdom, no
 * `fireEvent`/`userEvent`). Two halves, same split `clerk-task-submit.ts` /
 * `clerk-ask-panel.tsx` already use:
 *
 *  - `createContextEntry`/`updateContextEntry`/`deleteContextEntry` are pure,
 *    deps-injected async functions — exercised directly, the same way
 *    `submitClerkTask` is, so "creates with always_inject" and "toggles it"
 *    (an update with `always_inject` flipped) are asserted against the real
 *    request payload without needing a click to reach them.
 *  - `ClerkContextEditor` is exported specifically so its render contract —
 *    pre-filled values, the disabled-Save guard, error/saving states — is
 *    directly assertable without going through the "New entry" click that
 *    opens it in `ClerkContextPanel` (same reasoning `AssistantMethodDetails`
 *    is exported from `assistant-answer-panel.tsx`).
 *  - `ClerkContextPanel`'s own suite covers the list render (title, preview,
 *    badge, updated-at) and the delete confirmation: `ConfirmDialog` is
 *    mocked to capture its props regardless of `open` (its real, unmocked
 *    early-return already makes this harmless for every other test) —
 *    the same capture technique `assistant-answer-panel.test.tsx` uses for
 *    `StopTaskControl`'s confirm dialog.
 *  - `editorKey` is the regression test for a real bug caught in review:
 *    clicking `Edit` on entry B while entry A's editor was still open (both
 *    reusing the SAME `ClerkContextEditor` instance, keyed only on "is the
 *    editor open" rather than "which entry") let a save PATCH A's unsaved
 *    text onto B. `editorKey` is what makes the two cases remount instead of
 *    reuse; reverting it to a constant (or to `String(state !== null)`) is
 *    exactly the regression, and the second test below fails against that
 *    revert. `ContextEntryRow`'s `editingLocked` is the second, independent
 *    half of the fix (locks Edit/Delete everywhere while one edit is open)
 *    and is asserted directly on the exported row.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import useSWR from 'swr';
import type { KnowledgeAsset } from '@arbitra/shared';
import {
  ClerkContextEditor,
  ClerkContextPanel,
  ContextEntryRow,
  contextBodyPreview,
  contextEntriesSwrKey,
  createContextEntry,
  deleteContextEntry,
  editorKey,
  updateContextEntry,
} from '../clerk-context-panel';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  addToast: vi.fn(),
  mutate: vi.fn(),
  confirmDialogProps: { current: undefined as undefined | { onConfirm: () => void } },
}));

vi.mock('swr', () => ({ default: vi.fn() }));

vi.mock('../../../lib/api-client', () => ({
  api: {
    assistant: {
      context: {
        list: vi.fn(),
        create: mocks.create,
        update: mocks.update,
        remove: mocks.remove,
      },
    },
  },
}));

vi.mock('../../../providers/auth-provider', () => ({
  useAuth: () => ({ user: { uid: 'uid_a' } }),
}));

vi.mock('../../../providers/toast-provider', () => ({
  useToast: () => ({ addToast: mocks.addToast }),
}));

// Captures props regardless of `open` — the real component's own early
// return (`if (!open) return null`) already makes this harmless for every
// row this suite renders with the dialog closed.
vi.mock('../../shared/confirm-dialog', () => ({
  ConfirmDialog: (props: { onConfirm: () => void }) => {
    mocks.confirmDialogProps.current = props;
    return null;
  },
}));

const mockedUseSWR = useSWR as unknown as ReturnType<typeof vi.fn>;

function entry(over: Partial<KnowledgeAsset> = {}): KnowledgeAsset {
  return {
    knowledge_id: 'knowledge_roster',
    type: 'clerk_context',
    title: 'Team roster',
    summary: 'Who is on the team',
    body: 'Alice: backend. Bob: frontend.',
    scope_type: 'project',
    scope_ref: 'proj_clerk_uid_a',
    status: 'suggested',
    version: 1,
    trust_level: 0,
    source_case_refs: [],
    source_decision_refs: [],
    tags: [],
    artifact_refs: [],
    created_by: 'uid_a',
    created_at: '2026-08-01T09:00:00.000Z',
    updated_at: '2026-08-01T09:00:00.000Z',
    always_inject: false,
    ...over,
  };
}

/** Isolates the `<input type="checkbox" ...>` fragment for an attribute check. */
function checkboxHtml(html: string): string {
  const openIndex = html.indexOf('type="checkbox"');
  expect(openIndex).toBeGreaterThan(-1);
  const tagStart = html.lastIndexOf('<input', openIndex);
  const tagEnd = html.indexOf('/>', openIndex) + '/>'.length;
  return html.slice(tagStart, tagEnd);
}

/** Isolates the `<button>…</button>` whose text is `label`. */
function buttonHtmlFor(html: string, label: string): string {
  const labelIndex = html.indexOf(label);
  expect(labelIndex).toBeGreaterThan(-1);
  const openIndex = html.lastIndexOf('<button', labelIndex);
  const closeIndex = html.indexOf('</button>', labelIndex) + '</button>'.length;
  return html.slice(openIndex, closeIndex);
}

describe('contextEntriesSwrKey', () => {
  it('scopes the cached list to the signed-in user and waits for one', () => {
    expect(contextEntriesSwrKey('uid_a')).toEqual(['clerk-context', 'uid_a']);
    expect(contextEntriesSwrKey(undefined)).toBeNull();
  });
});

describe('contextBodyPreview', () => {
  it('collapses whitespace and passes short bodies through unchanged', () => {
    expect(contextBodyPreview('  Alice:   backend.\nBob: frontend.  ')).toBe(
      'Alice: backend. Bob: frontend.',
    );
  });

  it('elides past 140 characters', () => {
    const long = 'x'.repeat(200);
    const preview = contextBodyPreview(long);
    expect(preview.length).toBe(140);
    expect(preview.endsWith('…')).toBe(true);
  });
});

describe('editorKey', () => {
  it('gives create and every edit target a distinct key', () => {
    const createKey = editorKey({ mode: 'create' });
    const editAKey = editorKey({ mode: 'edit', entry: entry({ knowledge_id: 'knowledge_a' }) });
    const editBKey = editorKey({ mode: 'edit', entry: entry({ knowledge_id: 'knowledge_b' }) });

    // The regression this guards: clicking Edit on B while A's editor is
    // still open must remount `ClerkContextEditor` rather than reuse it —
    // reusing it would keep A's typed text on screen while `editorState`
    // (and therefore the save target) had already moved to B. A key that
    // only tracked "is an editor open" (e.g. `String(state !== null)`)
    // would make editAKey === editBKey here and fail this assertion.
    expect(createKey).not.toBe(editAKey);
    expect(editAKey).not.toBe(editBKey);
  });

  it('gives the same edit target the same key across re-renders', () => {
    const first = editorKey({ mode: 'edit', entry: entry({ knowledge_id: 'knowledge_a' }) });
    const second = editorKey({ mode: 'edit', entry: entry({ knowledge_id: 'knowledge_a' }) });
    expect(first).toBe(second);
  });
});

describe('createContextEntry / updateContextEntry / deleteContextEntry', () => {
  const deps = { create: mocks.create, update: mocks.update, remove: mocks.remove };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates an entry with always_inject and prepends it to the list', async () => {
    const created = entry({ knowledge_id: 'knowledge_new', always_inject: true });
    mocks.create.mockResolvedValue({ entry: created });

    const result = await createContextEntry(deps, [entry({ knowledge_id: 'knowledge_old' })], {
      title: 'Team roster',
      body: 'Alice: backend.',
      always_inject: true,
    });

    expect(mocks.create).toHaveBeenCalledWith({
      title: 'Team roster',
      body: 'Alice: backend.',
      always_inject: true,
    });
    expect(result.map((e) => e.knowledge_id)).toEqual(['knowledge_new', 'knowledge_old']);
    expect(result[0]?.always_inject).toBe(true);
  });

  it('toggles always_inject via an update and leaves the rest of the list untouched', async () => {
    const before = entry({ knowledge_id: 'knowledge_roster', always_inject: false });
    const after = entry({ knowledge_id: 'knowledge_roster', always_inject: true });
    mocks.update.mockResolvedValue({ entry: after });
    const sibling = entry({ knowledge_id: 'knowledge_other', title: 'Other' });

    const result = await updateContextEntry(deps, [before, sibling], 'knowledge_roster', {
      always_inject: true,
    });

    expect(mocks.update).toHaveBeenCalledWith('knowledge_roster', { always_inject: true });
    expect(result.find((e) => e.knowledge_id === 'knowledge_roster')?.always_inject).toBe(true);
    expect(result.find((e) => e.knowledge_id === 'knowledge_other')).toBe(sibling);
  });

  it('deletes an entry and removes only that one from the list', async () => {
    mocks.remove.mockResolvedValue({ success: true });
    const target = entry({ knowledge_id: 'knowledge_roster' });
    const sibling = entry({ knowledge_id: 'knowledge_other', title: 'Other' });

    const result = await deleteContextEntry(deps, [target, sibling], 'knowledge_roster');

    expect(mocks.remove).toHaveBeenCalledWith('knowledge_roster');
    expect(result).toEqual([sibling]);
  });
});

describe('ClerkContextEditor', () => {
  it('renders empty fields and an unchecked toggle for a new entry, with Save disabled', () => {
    const html = renderToStaticMarkup(
      <ClerkContextEditor saving={false} error={null} onSave={vi.fn()} onCancel={vi.fn()} />,
    );

    expect(html).toContain('Create entry');
    expect(html).not.toContain('Save changes');
    expect(checkboxHtml(html)).not.toMatch(/\bchecked=""/);
    expect(buttonHtmlFor(html, 'Create entry')).toMatch(/\bdisabled=""/);
  });

  it('pre-fills title, body, and the always-inject toggle when editing, and enables Save', () => {
    const html = renderToStaticMarkup(
      <ClerkContextEditor
        initial={{ title: 'Team roster', body: 'Alice: backend.', always_inject: true }}
        saving={false}
        error={null}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(html).toContain('value="Team roster"');
    expect(html).toContain('Alice: backend.');
    expect(html).toContain('Save changes');
    expect(checkboxHtml(html)).toMatch(/\bchecked=""/);
    expect(buttonHtmlFor(html, 'Save changes')).not.toMatch(/\bdisabled=""/);
  });

  it('disables Save and Cancel while saving, and labels the button accordingly', () => {
    const html = renderToStaticMarkup(
      <ClerkContextEditor
        initial={{ title: 'Team roster', body: 'Alice: backend.', always_inject: false }}
        saving
        error={null}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(html).toContain('Saving…');
    expect(buttonHtmlFor(html, 'Saving…')).toMatch(/\bdisabled=""/);
    expect(buttonHtmlFor(html, 'Cancel')).toMatch(/\bdisabled=""/);
  });

  it('renders a save error without hiding the form', () => {
    const html = renderToStaticMarkup(
      <ClerkContextEditor
        saving={false}
        error="This entry could not be saved."
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(html).toContain('This entry could not be saved.');
    expect(html).toContain('Create entry');
  });
});

describe('ContextEntryRow', () => {
  it('leaves Edit and Delete enabled when no editor is open elsewhere', () => {
    const html = renderToStaticMarkup(
      <ContextEntryRow
        entry={entry()}
        editingLocked={false}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(buttonHtmlFor(html, 'Edit')).not.toMatch(/\bdisabled=""/);
    expect(buttonHtmlFor(html, 'Delete')).not.toMatch(/\bdisabled=""/);
  });

  it('locks Edit and Delete on every row while one row is being edited — including itself', () => {
    // Half of the fix for a real review-caught bug: editing entry A must not
    // leave B (or A itself, mid-save) clickable, since only one edit target
    // exists at a time (`editorKey`'s docstring has the full scenario).
    const html = renderToStaticMarkup(
      <ContextEntryRow
        entry={entry()}
        editingLocked
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(buttonHtmlFor(html, 'Edit')).toMatch(/\bdisabled=""/);
    expect(buttonHtmlFor(html, 'Delete')).toMatch(/\bdisabled=""/);
  });
});

describe('ClerkContextPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mutate.mockResolvedValue(undefined);
    mocks.confirmDialogProps.current = undefined;
  });

  function mockEntries(entries: KnowledgeAsset[]): void {
    mockedUseSWR.mockImplementation((key: unknown) => {
      const scoped = Array.isArray(key) && key[0] === 'clerk-context' && key[1] === 'uid_a';
      return {
        data: scoped ? { entries } : undefined,
        error: undefined,
        isLoading: false,
        mutate: mocks.mutate,
      };
    });
  }

  it('lists entries from the route: title, body preview, always-inject badge, updated_at', () => {
    mockEntries([
      entry({ title: 'Team roster', body: 'Alice: backend.\nBob: frontend.', always_inject: true }),
    ]);

    const html = renderToStaticMarkup(<ClerkContextPanel />);

    expect(html).toContain('Team roster');
    expect(html).toContain('Alice: backend. Bob: frontend.');
    expect(html).toContain('Always injected');
    expect(html).toContain('Updated');
  });

  it('badges a non-injected entry as search-only', () => {
    mockEntries([entry({ always_inject: false })]);

    const html = renderToStaticMarkup(<ClerkContextPanel />);

    expect(html).toContain('Search only');
    expect(html).not.toContain('Always injected');
  });

  it('shows the empty-state hint and example when there are no entries', () => {
    mockEntries([]);

    const html = renderToStaticMarkup(<ClerkContextPanel />);

    expect(html).toContain('Nothing yet');
    expect(html).toContain('Team roster');
    expect(html).not.toContain('data-testid="context-entries"');
  });

  it('sorts entries by most-recently-updated first', () => {
    mockEntries([
      entry({ knowledge_id: 'knowledge_old', title: 'Old fact', updated_at: '2026-07-01T00:00:00.000Z' }),
      entry({ knowledge_id: 'knowledge_new', title: 'New fact', updated_at: '2026-08-01T00:00:00.000Z' }),
    ]);

    const html = renderToStaticMarkup(<ClerkContextPanel />);

    expect(html.indexOf('New fact')).toBeLessThan(html.indexOf('Old fact'));
  });

  it('deletes an entry once its confirm dialog is confirmed', async () => {
    mockEntries([entry({ knowledge_id: 'knowledge_roster', title: 'Team roster' })]);
    mocks.remove.mockResolvedValue({ success: true });

    renderToStaticMarkup(<ClerkContextPanel />);

    expect(mocks.confirmDialogProps.current).toBeDefined();
    mocks.confirmDialogProps.current!.onConfirm();

    // Wait for the LAST step in the chain (`remove` → `mutate` → `addToast`)
    // so the earlier two are guaranteed to have already happened too.
    await vi.waitFor(() => {
      expect(mocks.addToast).toHaveBeenCalled();
    });
    expect(mocks.remove).toHaveBeenCalledWith('knowledge_roster');
    expect(mocks.mutate).toHaveBeenCalledWith({ entries: [] }, { revalidate: false });
    expect(mocks.addToast).toHaveBeenCalledWith('success', 'Context entry deleted');
  });

  it('reports a failed delete without crashing, and never claims success', async () => {
    mockEntries([entry({ knowledge_id: 'knowledge_roster', title: 'Team roster' })]);
    mocks.remove.mockRejectedValue(new Error('network down'));

    renderToStaticMarkup(<ClerkContextPanel />);
    mocks.confirmDialogProps.current!.onConfirm();

    await vi.waitFor(() => {
      expect(mocks.addToast).toHaveBeenCalledWith('error', 'network down');
    });
    expect(mocks.mutate).not.toHaveBeenCalled();
  });
});
