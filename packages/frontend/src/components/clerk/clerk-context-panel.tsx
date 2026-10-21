'use client';

/**
 * `<ClerkContextPanel>` — the Context tab on `/clerk` (#832 slice A).
 *
 * Teaches Clerk durable facts about the signed-in user or their team (the
 * canonical example is a team roster): entries marked "always inject" are
 * read into every one of that user's task prompts, bounded and visibly (the
 * run's method details list the titles and ids — see
 * `AssistantMethodDetails` in `assistant-answer-panel.tsx`). Unmarked entries
 * stay search-only, reachable through `arbitra_search_knowledge` like any
 * other knowledge asset.
 *
 * Storage is a `KnowledgeAsset` with `type: 'clerk_context'`, scoped to the
 * caller's own private Clerk project — there is no type/scope picker here
 * because there is nothing to pick: the dedicated
 * `GET/POST/PATCH/DELETE /api/assistant/context[/id]` routes fix both to the
 * caller's identity (`docs/specs/clerk-config-scheduling-chat.md`, slice A).
 * Chrome mirrors `CredentialsPanel`'s section/card layout; the CRUD wiring
 * mirrors `ClerkAskPanel`'s SWR-list-plus-composer shape.
 *
 * `entries.summary` is NOT used for the row preview: the write-path's PATCH
 * schema has no `summary` field, so an edited body would leave `summary`
 * stale (`KnowledgeService.applyAssetUpdate` only touches fields explicitly
 * present in the update payload). `contextBodyPreview` recomputes the
 * preview from `body` on the client instead, so an edit is reflected the
 * moment it renders.
 */

import { useMemo, useState } from 'react';
import useSWR from 'swr';
import type { KnowledgeAsset } from '@arbitra/shared';
import { api } from '../../lib/api-client';
import { useAuth } from '../../providers/auth-provider';
import { useToast } from '../../providers/toast-provider';
import { RelativeTime } from '../shared/relative-time';
import { Badge } from '../shared/badge';
import { ConfirmDialog } from '../shared/confirm-dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import Card from '../shared/card';
import SectionHeader from '../shared/section-header';

const ALWAYS_INJECT_BADGE_CLASS =
  'bg-accent-50 text-accent-700 ring-accent-600/20 dark:bg-accent-950/40 dark:text-accent-300 dark:ring-accent-500/30';
const SEARCH_ONLY_BADGE_CLASS =
  'bg-gray-100 text-gray-500 ring-gray-300 dark:bg-gray-800 dark:text-gray-400 dark:ring-gray-700';

/**
 * SWR key for the signed-in user's own context entries, scoped by uid for the
 * same reason `assistantTasksSwrKey` is: sign-out neither reloads the app
 * nor clears SWR's cache, so an unscoped key would hand one account's
 * context entries to the next account signed in the same tab.
 */
export function contextEntriesSwrKey(uid: string | undefined): [string, string] | null {
  return uid ? ['clerk-context', uid] : null;
}

/**
 * The row preview, collapsed and elided the same way the write route's own
 * `summarizeContextBody` is — just recomputed here from the live `body`
 * rather than read from the possibly-stale stored `summary`.
 */
export function contextBodyPreview(body: string): string {
  const collapsed = body.trim().replace(/\s+/g, ' ');
  return collapsed.length <= 140 ? collapsed : `${collapsed.slice(0, 139)}…`;
}

export interface ContextEntryFormValues {
  title: string;
  body: string;
  always_inject: boolean;
}

export interface ContextEntryInput {
  title: string;
  body: string;
  always_inject?: boolean;
}

interface ContextActionDeps {
  create(input: ContextEntryInput): Promise<{ entry: KnowledgeAsset }>;
  update(
    knowledgeId: string,
    input: Partial<ContextEntryInput>,
  ): Promise<{ entry: KnowledgeAsset }>;
  remove(knowledgeId: string): Promise<{ success: boolean }>;
}

/**
 * Create one entry and return the list with it prepended (newest first,
 * matching the panel's own updated-at sort — a fresh entry is the newest
 * update there could possibly be).
 *
 * Kept as a pure, deps-injected function — same shape as
 * `submitClerkTask` in `clerk-task-submit.ts` — so the create/update/delete
 * contract is directly testable without rendering anything.
 */
export async function createContextEntry(
  deps: ContextActionDeps,
  entries: KnowledgeAsset[],
  input: ContextEntryInput,
): Promise<KnowledgeAsset[]> {
  const { entry } = await deps.create(input);
  return [entry, ...entries];
}

/** Update one entry in place; the rest of the list is untouched. */
export async function updateContextEntry(
  deps: ContextActionDeps,
  entries: KnowledgeAsset[],
  knowledgeId: string,
  input: Partial<ContextEntryInput>,
): Promise<KnowledgeAsset[]> {
  const { entry } = await deps.update(knowledgeId, input);
  return entries.map((existing) => (existing.knowledge_id === entry.knowledge_id ? entry : existing));
}

/** Delete one entry and return the list without it. */
export async function deleteContextEntry(
  deps: ContextActionDeps,
  entries: KnowledgeAsset[],
  knowledgeId: string,
): Promise<KnowledgeAsset[]> {
  await deps.remove(knowledgeId);
  return entries.filter((entry) => entry.knowledge_id !== knowledgeId);
}

/**
 * The title/body/always-inject form, shared by create and edit.
 *
 * Exported so its rendering contract — pre-filled values, the disabled Save
 * guard, error/saving states — is directly testable without going through
 * the click that opens it (same reasoning `AssistantMethodDetails` is
 * exported in `assistant-answer-panel.tsx`).
 */
export function ClerkContextEditor({
  initial,
  saving,
  error,
  onSave,
  onCancel,
}: {
  /** Omit for a new entry; pass the current values to edit one in place. */
  initial?: ContextEntryFormValues;
  saving: boolean;
  error: string | null;
  onSave: (values: ContextEntryFormValues) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [body, setBody] = useState(initial?.body ?? '');
  const [alwaysInject, setAlwaysInject] = useState(initial?.always_inject ?? false);
  const isEditing = initial !== undefined;

  return (
    <Card as="section" padding="none" data-testid="context-editor">
      <form
        className="p-4 space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          const trimmedTitle = title.trim();
          const trimmedBody = body.trim();
          if (!trimmedTitle || !trimmedBody) return;
          onSave({ title: trimmedTitle, body: trimmedBody, always_inject: alwaysInject });
        }}
      >
        <Input
          label="Title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="e.g. Team roster"
        />
        <Input
          as="textarea"
          label="Body (markdown)"
          rows={6}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder="What should Clerk always know?"
        />
        <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400 cursor-pointer">
          <input
            type="checkbox"
            checked={alwaysInject}
            onChange={(event) => setAlwaysInject(event.target.checked)}
            className="rounded border-gray-300 dark:border-gray-600 text-accent focus:ring-accent"
          />
          Always inject into every task
        </label>
        {error && (
          <p className="text-xs text-red-600 dark:text-red-400" data-testid="editor-error">
            {error}
          </p>
        )}
        <div className="flex items-center gap-2">
          <Button
            type="submit"
            variant="primary"
            size="sm"
            disabled={saving || !title.trim() || !body.trim()}
          >
            {saving ? 'Saving…' : isEditing ? 'Save changes' : 'Create entry'}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

/** One row's delete affordance: a button plus its own confirm dialog. */
function DeleteEntryControl({
  entryTitle,
  disabled,
  onConfirm,
}: {
  entryTitle: string;
  /** Locked out while any row's editor is open — see `ContextEntryRow`. */
  disabled: boolean;
  onConfirm: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handleConfirm = async (): Promise<void> => {
    setDeleting(true);
    try {
      await onConfirm();
    } finally {
      setDeleting(false);
      setOpen(false);
    }
  };

  return (
    <>
      <Button
        variant="ghost"
        size="xs"
        disabled={disabled}
        onClick={() => setOpen(true)}
        className="text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300"
      >
        Delete
      </Button>
      <ConfirmDialog
        open={open}
        title="Delete context entry"
        message={`Delete "${entryTitle}"? Clerk stops injecting it into future tasks immediately. This cannot be undone.`}
        confirmLabel="Delete"
        variant="danger"
        loading={deleting}
        onConfirm={() => void handleConfirm()}
        onCancel={() => setOpen(false)}
      />
    </>
  );
}

/**
 * One entry's row. `editingLocked` disables BOTH Edit and Delete on every
 * row — including this one — while any row's editor is open elsewhere:
 * without it, clicking `Edit` on a second entry while a first entry's
 * unsaved edit is still open reuses the editor's single instance (see
 * `editorKey`'s doc comment) and clicking `Delete` on the entry currently
 * being edited leaves that editor pointed at a since-deleted target. Locking
 * the whole list while one entry is mid-edit is the simplest correct
 * behaviour: exactly one edit in flight, matching `editorState`'s own shape
 * (never more than one target at a time).
 */
export function ContextEntryRow({
  entry,
  editingLocked,
  onEdit,
  onDelete,
}: {
  entry: KnowledgeAsset;
  editingLocked: boolean;
  onEdit: () => void;
  onDelete: () => Promise<void>;
}) {
  return (
    <li className="px-4 py-3 flex items-start justify-between gap-4">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{entry.title}</p>
          <Badge
            size="sm"
            colorClassName={entry.always_inject ? ALWAYS_INJECT_BADGE_CLASS : SEARCH_ONLY_BADGE_CLASS}
          >
            {entry.always_inject ? 'Always injected' : 'Search only'}
          </Badge>
        </div>
        <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
          {contextBodyPreview(entry.body)}
        </p>
        <RelativeTime
          timestamp={entry.updated_at}
          prefix="Updated"
          className="mt-1 block text-[11px] text-gray-400 dark:text-gray-500"
        />
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        <Button variant="secondary" size="xs" disabled={editingLocked} onClick={onEdit}>
          Edit
        </Button>
        <DeleteEntryControl entryTitle={entry.title} disabled={editingLocked} onConfirm={onDelete} />
      </div>
    </li>
  );
}

type EditorState = { mode: 'create' } | { mode: 'edit'; entry: KnowledgeAsset } | null;

/**
 * A `key` for `<ClerkContextEditor>` that changes whenever its EDIT TARGET
 * changes — not just whenever the editor opens.
 *
 * Without this, switching from editing entry A straight to editing entry B
 * (click `Edit` on B while A's editor is still open, unsaved) reuses the
 * SAME component instance: `ClerkContextEditor`'s `title`/`body`/
 * `always_inject` are `useState(initial?.… ?? …)`, seeded only on first
 * mount, so the fields would keep showing A's text while `editorState`
 * (and therefore `handleSave`'s target `knowledgeId`) has already moved to
 * B — a save would silently PATCH A's text onto B. Forcing a remount via a
 * target-scoped key means the fields are always re-seeded from the CURRENT
 * target, matching what the form visibly shows.
 */
export function editorKey(state: EditorState): string {
  return state?.mode === 'edit' ? `edit-${state.entry.knowledge_id}` : 'create';
}

export function ClerkContextPanel() {
  const { user } = useAuth();
  const { addToast } = useToast();
  const { data, mutate } = useSWR(
    contextEntriesSwrKey(user?.uid),
    () => api.assistant.context.list(),
  );
  // Most-recently-updated first — the route itself makes no ordering
  // guarantee (a straight Firestore `where` query, no `orderBy`).
  const entries = useMemo(
    () => [...(data?.entries ?? [])].sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at)),
    [data?.entries],
  );

  const [editorState, setEditorState] = useState<EditorState>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const deps: ContextActionDeps = {
    create: api.assistant.context.create,
    update: api.assistant.context.update,
    remove: api.assistant.context.remove,
  };

  async function handleSave(values: ContextEntryFormValues): Promise<void> {
    setSaving(true);
    setFormError(null);
    try {
      const updated = editorState?.mode === 'edit'
        ? await updateContextEntry(deps, entries, editorState.entry.knowledge_id, values)
        : await createContextEntry(deps, entries, values);
      await mutate({ entries: updated }, { revalidate: false });
      addToast('success', editorState?.mode === 'edit' ? 'Context entry updated' : 'Context entry created');
      setEditorState(null);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'This entry could not be saved.');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(entry: KnowledgeAsset): Promise<void> {
    try {
      const updated = await deleteContextEntry(deps, entries, entry.knowledge_id);
      await mutate({ entries: updated }, { revalidate: false });
      addToast('success', 'Context entry deleted');
    } catch (err) {
      addToast('error', err instanceof Error ? err.message : 'This entry could not be deleted.');
    }
  }

  return (
    <div data-testid="clerk-context-panel">
      <SectionHeader
        eyebrow
        title="Context"
        description="Clerk reads marked entries with every task you ask."
        className="mb-4"
        actions={
          editorState === null && (
            <Button variant="primary" size="sm" onClick={() => setEditorState({ mode: 'create' })}>
              New entry
            </Button>
          )
        }
      />

      {editorState !== null && (
        <div className="mb-4">
          <ClerkContextEditor
            key={editorKey(editorState)}
            initial={editorState.mode === 'edit'
              ? {
                title: editorState.entry.title,
                body: editorState.entry.body,
                always_inject: editorState.entry.always_inject ?? false,
              }
              : undefined}
            saving={saving}
            error={formError}
            onSave={(values) => void handleSave(values)}
            onCancel={() => {
              setEditorState(null);
              setFormError(null);
            }}
          />
        </div>
      )}

      {entries.length === 0 ? (
        <p className="text-xs text-gray-500 dark:text-gray-400" data-testid="no-entries">
          Nothing yet. Teach Clerk something it should always know — for example, a &ldquo;Team
          roster&rdquo; entry saying who is on your team and what they work on.
        </p>
      ) : (
        <Card as="section" padding="none" data-testid="context-entries">
          <ul className="divide-y divide-gray-100 dark:divide-gray-800">
            {entries.map((entry) => (
              <ContextEntryRow
                key={entry.knowledge_id}
                entry={entry}
                editingLocked={editorState !== null}
                onEdit={() => setEditorState({ mode: 'edit', entry })}
                onDelete={() => handleDelete(entry)}
              />
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
