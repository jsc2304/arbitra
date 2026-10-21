/**
 * @file clerk-scheduled-panel — the blueprint list, the editor's rendering
 * contract, and the create/update/archive/run-now logic (#793 slice B3).
 *
 * Node-only per the frontend convention (renderToStaticMarkup, no jsdom, no
 * `fireEvent`/`userEvent`), same split `clerk-context-panel.tsx` already
 * uses:
 *
 *  - `describeCronSchedule`, `defaultBrowserTimeZone`,
 *    `describeBlueprintOccurrenceOutcome`, `recordBlueprintRunResult`,
 *    `recordBlueprintOverlap`, `groupAssistantTasksByBlueprint`,
 *    `occurrencesForBlueprint`, `blueprintFieldErrors`, and
 *    `scheduledEditorKey` are pure — exercised directly with plain inputs, no
 *    rendering, no module mocking, and (for the ones that inspect an
 *    `ApiError`) the REAL `ApiError` class, not a stand-in.
 *  - `createBlueprint`/`updateBlueprint`/`archiveBlueprint`/`runBlueprintNow`
 *    are pure, deps-injected async functions — exercised against a plain
 *    `vi.fn()` deps object, the same way `createContextEntry` et al. are in
 *    `clerk-context-panel.test.tsx`. This is also how "toggle" is covered:
 *    the Enabled checkbox's handler in the real component is just
 *    `updateBlueprint(..., { enabled: !blueprint.enabled })`, so the toggle
 *    behaviour IS the update-blueprint test below, not a separate one.
 *  - `ClerkScheduledEditor` and `BlueprintRow` are exported so their render
 *    contracts are directly assertable without going through the clicks that
 *    open/reach them in `ClerkScheduledPanel`.
 *  - `ClerkScheduledPanel`'s own suite covers the list render (name, cron
 *    raw + human sentence, timezone), the empty state, that an archived
 *    blueprint is hidden even though the route still returns it, the
 *    archive confirmation flow (`ConfirmDialog` mocked to capture its props,
 *    same technique `clerk-context-panel.test.tsx` uses for delete), and
 *    (#858) that the task-list SWR call carries the limit in its key with a
 *    15s `refreshInterval`, and that Run-now calls `mutateTasks` after a
 *    success. That last one needs an actual `onClick` closure to invoke —
 *    `<Button>` is wrapped (not replaced: it still renders the real `Button`
 *    underneath, so every existing text/`disabled=""` assertion elsewhere in
 *    this file sees identical output) to stash each rendered button's props
 *    in `mocks.buttonProps`, the same "capture via a mocked child's props"
 *    technique the `ConfirmDialog` mock already uses for the archive flow.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import useSWR from 'swr';
import type { TaskBlueprint } from '@arbitra/shared';
import { ApiError, type AssistantTaskSummary } from '../../../lib/api-client';
import {
  BlueprintRow,
  ClerkScheduledEditor,
  ClerkScheduledPanel,
  OCCURRENCE_TASK_LIST_LIMIT,
  archiveBlueprint,
  blueprintFieldErrors,
  blueprintsSwrKey,
  createBlueprint,
  defaultBrowserTimeZone,
  describeBlueprintOccurrenceOutcome,
  describeCronSchedule,
  groupAssistantTasksByBlueprint,
  occurrencesForBlueprint,
  recordBlueprintOverlap,
  recordBlueprintRunResult,
  runBlueprintNow,
  scheduledEditorKey,
  updateBlueprint,
} from '../clerk-scheduled-panel';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  archive: vi.fn(),
  runNow: vi.fn(),
  addToast: vi.fn(),
  mutate: vi.fn(),
  mutateTasks: vi.fn(),
  confirmDialogProps: { current: undefined as undefined | { onConfirm: () => void } },
  // Every `<Button>` rendered anywhere in this file, in render order — a
  // side channel to reach a button's `onClick` closure without jsdom/
  // fireEvent (this suite is deliberately Node-only — see the file header).
  // The wrapper below DELEGATES to the real `Button` (renders it, does not
  // replace it), so every existing text/`disabled=""` assertion in this file
  // still sees byte-identical output; only this array is new.
  buttonProps: [] as Array<Record<string, unknown>>,
}));

vi.mock('swr', () => ({ default: vi.fn() }));

vi.mock('../../../lib/api-client', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/api-client')>(
    '../../../lib/api-client',
  );
  return {
    ...actual,
    api: {
      assistant: {
        blueprints: {
          list: vi.fn(),
          create: mocks.create,
          update: mocks.update,
          archive: mocks.archive,
          runNow: mocks.runNow,
        },
      },
    },
  };
});

vi.mock('../../../providers/auth-provider', () => ({
  useAuth: () => ({ user: { uid: 'uid_a' } }),
}));

vi.mock('../../../providers/toast-provider', () => ({
  useToast: () => ({ addToast: mocks.addToast }),
}));

vi.mock('../../shared/confirm-dialog', () => ({
  ConfirmDialog: (props: { onConfirm: () => void }) => {
    mocks.confirmDialogProps.current = props;
    return null;
  },
}));

vi.mock('../../ui/button', async () => {
  const actual = await vi.importActual<typeof import('../../ui/button')>('../../ui/button');
  return {
    ...actual,
    Button: (props: import('../../ui/button').ButtonProps) => {
      mocks.buttonProps.push(props as unknown as Record<string, unknown>);
      return <actual.Button {...props} />;
    },
  };
});

const mockedUseSWR = useSWR as unknown as ReturnType<typeof vi.fn>;

function blueprint(over: Partial<TaskBlueprint> = {}): TaskBlueprint {
  return {
    blueprint_id: 'taskBlueprint_roster_check',
    owner_user_id: 'uid_a',
    project_id: 'proj_clerk_uid_a',
    name: 'Weekly team case review',
    prompt_text: "Every Monday at 9, summarize my team's open cases",
    cron_schedule: '0 9 * * 1',
    timezone: 'Europe/Berlin',
    enabled: true,
    archived_at: null,
    version: 1,
    overlap_policy: 'skip',
    missed_run_policy: 'skip',
    created_at: '2026-08-01T09:00:00.000Z',
    updated_at: '2026-08-01T09:00:00.000Z',
    ...over,
  };
}

function task(over: Partial<AssistantTaskSummary> = {}): AssistantTaskSummary {
  return {
    case_id: 'case_occurrence',
    title: "Every Monday at 9, summarize my team's open cases",
    status: 'done',
    created_at: '2026-08-01T09:00:00.000Z',
    updated_at: '2026-08-01T09:00:14.000Z',
    ...over,
  };
}

/** Isolates the `<input type="checkbox" ...>` fragment for an attribute check. */
function checkboxHtml(html: string, afterIndex = 0): string {
  const openIndex = html.indexOf('type="checkbox"', afterIndex);
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

/**
 * Isolates the `<input type="radio" .../>` or `<input type="checkbox" .../>`
 * immediately preceding the given label text — every radio/checkbox in this
 * file's markup (frequency options, the weekday grid, Enabled) is laid out
 * as `<input .../>{label text}</label>` inside a shared `<label>`. Anchoring
 * on `{label}</label>` (rather than a bare `indexOf(label)`) matters here:
 * a blueprint NAME can itself contain a frequency word (the fixture below is
 * literally "Weekly team case review"), and a bare search would find that
 * `value="…Weekly…"` attribute instead of the "Weekly" radio option's label.
 */
function inputHtmlBeforeLabel(html: string, label: string): string {
  const labelIndex = html.indexOf(`${label}</label>`);
  expect(labelIndex).toBeGreaterThan(-1);
  const tagStart = html.lastIndexOf('<input', labelIndex);
  const tagEnd = html.indexOf('/>', tagStart) + '/>'.length;
  return html.slice(tagStart, tagEnd);
}

describe('blueprintsSwrKey', () => {
  it('scopes the cached list to the signed-in user and waits for one', () => {
    expect(blueprintsSwrKey('uid_a')).toEqual(['clerk-blueprints', 'uid_a']);
    expect(blueprintsSwrKey(undefined)).toBeNull();
  });
});

describe('describeCronSchedule', () => {
  it('describes the unconstrained schedule', () => {
    expect(describeCronSchedule('* * * * *')).toBe('Every minute');
  });

  it('describes every-N-minutes', () => {
    expect(describeCronSchedule('*/15 * * * *')).toBe('Every 15 minutes');
  });

  it('describes every-N-hours at a fixed minute', () => {
    expect(describeCronSchedule('0 */6 * * *')).toBe('Every 6 hours');
    expect(describeCronSchedule('30 */2 * * *')).toBe('Every 2 hours at minute 30');
  });

  it('describes a fixed daily time', () => {
    expect(describeCronSchedule('0 9 * * *')).toBe('Every day at 09:00');
  });

  it('describes a fixed time on one named weekday, by number and by abbreviation', () => {
    // The canonical example from the spec's empty state ("every Monday at 9").
    expect(describeCronSchedule('0 9 * * 1')).toBe('Every Monday at 09:00');
    expect(describeCronSchedule('0 9 * * MON')).toBe('Every Monday at 09:00');
  });

  it('treats day-of-week 0 and 7 as the same Sunday', () => {
    expect(describeCronSchedule('0 9 * * 0')).toBe('Every Sunday at 09:00');
    expect(describeCronSchedule('0 9 * * 7')).toBe('Every Sunday at 09:00');
  });

  it('joins multiple weekdays with an Oxford comma at three or more', () => {
    expect(describeCronSchedule('30 14 * * 1,3')).toBe('Every Monday and Wednesday at 14:30');
    expect(describeCronSchedule('30 14 * * 1,3,5')).toBe(
      'Every Monday, Wednesday, and Friday at 14:30',
    );
  });

  it('describes a fixed time on one day of the month', () => {
    expect(describeCronSchedule('0 0 1 * *')).toBe('On day 1 of the month at 00:00');
  });

  it('falls back to the raw string for a constrained month field', () => {
    expect(describeCronSchedule('0 9 15 6 *')).toBe('0 9 15 6 *');
  });

  it('falls back to the raw string for an unrecognized day-of-week token', () => {
    expect(describeCronSchedule('0 9 * * XYZ')).toBe('0 9 * * XYZ');
  });

  it('falls back to the raw string for a malformed field count — too few fields', () => {
    expect(describeCronSchedule('* * *')).toBe('* * *');
  });

  it('falls back to the raw string for a malformed field count — too many fields', () => {
    // Reviewer-noted gap on PR #857: the 5-field length guard covers this
    // (`fields.length !== 5`), but it had no explicit test of its own — only
    // the too-few-fields case above. Reverting that guard to `< 5` (instead
    // of `!== 5`) would let this 6-field string slip through and fail here.
    expect(describeCronSchedule('* * * * * *')).toBe('* * * * * *');
  });

  it('falls back to the raw string for a step of 0 minutes, rather than saying "Every 0 minutes"', () => {
    // PR #857 review fix: `*/0` matches the every-N-minutes regex (one or
    // more digits) but is not a real cron step. Reverting the `n < 1` guard
    // in the minutes branch makes this render the false sentence
    // "Every 0 minutes" instead of falling back to the raw string.
    expect(describeCronSchedule('*/0 * * * *')).toBe('*/0 * * * *');
  });

  it('falls back to the raw string for a step of 0 hours, rather than saying "Every 0 hours"', () => {
    // Same fix, hours branch: reverting its `n < 1` guard makes this render
    // "Every 0 hours" instead of falling back.
    expect(describeCronSchedule('0 */0 * * *')).toBe('0 */0 * * *');
  });
});

describe('defaultBrowserTimeZone', () => {
  it('reads the runtime-resolved IANA zone', () => {
    // Node's own ICU data resolves a real zone here — asserting it is a
    // non-empty string (rather than a fixed value) keeps this test honest
    // about not knowing which CI timezone it runs under.
    expect(defaultBrowserTimeZone().length).toBeGreaterThan(0);
  });

  it('falls back to UTC if Intl throws', () => {
    const spy = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(() => {
      throw new Error('no ICU data');
    });
    expect(defaultBrowserTimeZone()).toBe('UTC');
    spy.mockRestore();
  });
});

describe('describeBlueprintOccurrenceOutcome', () => {
  it('maps a done case with no reads-withheld flag to Done', () => {
    expect(describeBlueprintOccurrenceOutcome({ status: 'done' }).outcome).toBe('done');
  });

  it('maps a done case WITH reads-withheld to the reads-withheld outcome, not Done', () => {
    // This is the case a status-only mapping would get wrong: `done` alone
    // is not enough to rule out reads-withheld — the flag must win.
    const badge = describeBlueprintOccurrenceOutcome({ status: 'done', readsWithheld: true });
    expect(badge.outcome).toBe('reads_withheld');
    expect(badge.label).toBe('Reads withheld');
  });

  it('maps a rejected case to Failed regardless of the reads-withheld flag', () => {
    expect(describeBlueprintOccurrenceOutcome({ status: 'rejected' }).outcome).toBe('failed');
    expect(
      describeBlueprintOccurrenceOutcome({ status: 'rejected', readsWithheld: true }).outcome,
    ).toBe('failed');
  });

  it('maps every non-terminal status, and the synthetic overlap marker, to Pending', () => {
    expect(describeBlueprintOccurrenceOutcome({ status: 'open' }).outcome).toBe('pending');
    expect(describeBlueprintOccurrenceOutcome({ status: 'overlap_pending' }).outcome).toBe(
      'pending',
    );
  });
});

describe('recordBlueprintRunResult / recordBlueprintOverlap', () => {
  it('records a run result under its blueprint id, leaving other entries untouched', () => {
    const before = { taskBlueprint_other: { case_id: 'case_other', status: 'done', replayed: false } };
    const after = recordBlueprintRunResult(before, 'taskBlueprint_roster_check', {
      case_id: 'case_new',
      status: 'open',
      replayed: false,
    });
    expect(after.taskBlueprint_roster_check).toEqual({
      case_id: 'case_new',
      status: 'open',
      replayed: false,
    });
    expect(after.taskBlueprint_other).toBe(before.taskBlueprint_other);
  });

  it('records an overlap with the synthetic pending status, not the target case\'s real status', () => {
    const after = recordBlueprintOverlap({}, 'taskBlueprint_roster_check', 'case_existing');
    expect(after.taskBlueprint_roster_check).toEqual({
      case_id: 'case_existing',
      status: 'overlap_pending',
      replayed: false,
    });
  });
});

describe('createBlueprint / updateBlueprint / archiveBlueprint', () => {
  beforeEachClearMocks();

  it('creates a blueprint and prepends it to the list', async () => {
    const created = blueprint({ blueprint_id: 'taskBlueprint_new' });
    mocks.create.mockResolvedValue({ blueprint: created });
    const deps = { create: mocks.create };

    const result = await createBlueprint(deps, [blueprint({ blueprint_id: 'taskBlueprint_old' })], {
      name: created.name,
      prompt_text: created.prompt_text,
      cron_schedule: created.cron_schedule,
      timezone: created.timezone,
      enabled: true,
    });

    expect(result.map((b) => b.blueprint_id)).toEqual(['taskBlueprint_new', 'taskBlueprint_old']);
  });

  it('updates a blueprint in place — this IS the toggle path (an update with only `enabled` flipped)', async () => {
    const before = blueprint({ enabled: true });
    const after = blueprint({ enabled: false, version: 2 });
    mocks.update.mockResolvedValue({ blueprint: after });
    const sibling = blueprint({ blueprint_id: 'taskBlueprint_sibling' });
    const deps = { update: mocks.update };

    const result = await updateBlueprint(deps, [before, sibling], before.blueprint_id, {
      enabled: false,
    });

    expect(mocks.update).toHaveBeenCalledWith(before.blueprint_id, { enabled: false });
    expect(result.find((b) => b.blueprint_id === before.blueprint_id)?.enabled).toBe(false);
    expect(result.find((b) => b.blueprint_id === 'taskBlueprint_sibling')).toBe(sibling);
  });

  it('archives a blueprint in place without removing it from the returned list', async () => {
    const before = blueprint();
    const archived = blueprint({ archived_at: '2026-08-06T00:00:00.000Z', enabled: false });
    mocks.archive.mockResolvedValue({ blueprint: archived });
    const deps = { archive: mocks.archive };

    const result = await archiveBlueprint(deps, [before], before.blueprint_id);

    expect(mocks.archive).toHaveBeenCalledWith(before.blueprint_id);
    // Archiving does not delete the row — hiding it is `visibleBlueprints`'s
    // job in the panel, not this function's.
    expect(result).toHaveLength(1);
    expect(result[0]?.archived_at).toBe('2026-08-06T00:00:00.000Z');
  });
});

describe('runBlueprintNow', () => {
  beforeEachClearMocks();

  it('records a started run and reports it as such', async () => {
    mocks.runNow.mockResolvedValue({
      case_id: 'case_new',
      run_id: 'run_new',
      status: 'open',
      replayed: false,
    });

    const result = await runBlueprintNow({ runNow: mocks.runNow }, {}, 'taskBlueprint_roster_check');

    expect(result.kind).toBe('started');
    if (result.kind !== 'error') {
      expect(result.lastRun.taskBlueprint_roster_check).toEqual({
        case_id: 'case_new',
        status: 'open',
        replayed: false,
      });
    }
  });

  it('reports a replay distinctly from a fresh start', async () => {
    mocks.runNow.mockResolvedValue({
      case_id: 'case_existing',
      run_id: 'run_existing',
      status: 'open',
      replayed: true,
    });

    const result = await runBlueprintNow({ runNow: mocks.runNow }, {}, 'taskBlueprint_roster_check');

    expect(result.kind).toBe('replayed');
  });

  it('turns a 409 TASK_BLUEPRINT_OVERLAP into an overlap result carrying the blocking case id', async () => {
    mocks.runNow.mockRejectedValue(
      new ApiError(
        "Task blueprint 'taskBlueprint_roster_check' already has a non-terminal case 'case_blocking'...",
        409,
        'TASK_BLUEPRINT_OVERLAP',
        { blueprint_id: 'taskBlueprint_roster_check', case_id: 'case_blocking' },
      ),
    );

    const result = await runBlueprintNow({ runNow: mocks.runNow }, {}, 'taskBlueprint_roster_check');

    expect(result.kind).toBe('overlap');
    if (result.kind === 'overlap') {
      expect(result.existingCaseId).toBe('case_blocking');
      expect(result.lastRun.taskBlueprint_roster_check?.status).toBe('overlap_pending');
    }
  });

  it('reports any other failure as a plain error, without touching lastRun', async () => {
    mocks.runNow.mockRejectedValue(new Error('network down'));
    const before = { taskBlueprint_other: { case_id: 'case_x', status: 'done', replayed: false } };

    const result = await runBlueprintNow({ runNow: mocks.runNow }, before, 'taskBlueprint_roster_check');

    expect(result).toEqual({ kind: 'error', message: 'network down' });
  });
});

describe('blueprintFieldErrors', () => {
  it('maps each field path to its first issue message', () => {
    const error = new ApiError('Invalid request payload', 400, 'VALIDATION_ERROR', {
      issues: [
        { code: 'invalid_string', message: 'cron_schedule must be 5 whitespace-separated fields (minute hour day-of-month month day-of-week)', path: ['cron_schedule'] },
        { code: 'custom', message: 'timezone must be a recognized IANA time zone name', path: ['timezone'] },
      ],
    });

    expect(blueprintFieldErrors(error)).toEqual({
      cron_schedule:
        'cron_schedule must be 5 whitespace-separated fields (minute hour day-of-month month day-of-week)',
      timezone: 'timezone must be a recognized IANA time zone name',
    });
  });

  it('returns an empty map for a non-validation error', () => {
    expect(blueprintFieldErrors(new ApiError('archived', 409, 'TASK_BLUEPRINT_ARCHIVED'))).toEqual({});
    expect(blueprintFieldErrors(new Error('network down'))).toEqual({});
  });
});

describe('scheduledEditorKey', () => {
  it('gives create and every edit target a distinct key', () => {
    const createKey = scheduledEditorKey({ mode: 'create' });
    const editAKey = scheduledEditorKey({
      mode: 'edit',
      blueprint: blueprint({ blueprint_id: 'taskBlueprint_a' }),
    });
    const editBKey = scheduledEditorKey({
      mode: 'edit',
      blueprint: blueprint({ blueprint_id: 'taskBlueprint_b' }),
    });

    // Guards the same regression `editorKey` guards in clerk-context-panel:
    // a key that only tracked "is an editor open" would make these equal,
    // letting a save meant for B's edit target land on A instead.
    expect(createKey).not.toBe(editAKey);
    expect(editAKey).not.toBe(editBKey);
  });
});

describe('ClerkScheduledEditor', () => {
  it('renders empty fields, the browser default timezone selected, and Save disabled for a new blueprint', () => {
    const spy = vi.spyOn(Intl, 'DateTimeFormat').mockReturnValue({
      resolvedOptions: () => ({ timeZone: 'Europe/Berlin' }),
    } as unknown as Intl.DateTimeFormat);

    const html = renderToStaticMarkup(
      <ClerkScheduledEditor saving={false} error={null} fieldErrors={{}} onSave={vi.fn()} onCancel={vi.fn()} />,
    );

    expect(html).toContain('Create blueprint');
    expect(html).not.toContain('Save changes');
    expect(buttonHtmlFor(html, 'Create blueprint')).toMatch(/\bdisabled=""/);
    // The default-selected <option> in a controlled <select> gets `selected=""`
    // from React's own server renderer — see this file's header comment.
    const berlinOptionIndex = html.indexOf('>Europe/Berlin<');
    const berlinOptionOpen = html.lastIndexOf('<option', berlinOptionIndex);
    expect(html.slice(berlinOptionOpen, berlinOptionIndex)).toContain('selected=""');

    spy.mockRestore();
  });

  it('pre-fills every field when editing, and enables Save', () => {
    const html = renderToStaticMarkup(
      <ClerkScheduledEditor
        initial={{
          name: 'Weekly team case review',
          prompt_text: "Every Monday at 9, summarize my team's open cases",
          cron_schedule: '0 9 * * 1',
          timezone: 'Europe/Berlin',
          enabled: false,
        }}
        saving={false}
        error={null}
        fieldErrors={{}}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(html).toContain('value="Weekly team case review"');
    expect(html).toContain('Every Monday at 9, summarize my team&#x27;s open cases');
    // The Enabled checkbox specifically — not the FIRST checkbox in the
    // markup, now that the weekday grid (also checkboxes) renders before it.
    // `Timezone` is the nearest preceding anchor with no checkbox of its
    // own, so searching after it lands on the Enabled checkbox.
    expect(checkboxHtml(html, html.indexOf('Timezone'))).not.toMatch(/\bchecked=""/);
    expect(html).toContain('Save changes');
    expect(buttonHtmlFor(html, 'Save changes')).not.toMatch(/\bdisabled=""/);
  });

  it('editing a builder-representable blueprint opens the Weekly builder populated (day, time), not the raw cron field', () => {
    const html = renderToStaticMarkup(
      <ClerkScheduledEditor
        initial={{
          name: 'Weekly team case review',
          prompt_text: "Every Monday at 9, summarize my team's open cases",
          cron_schedule: '0 9 * * 1',
          timezone: 'Europe/Berlin',
          enabled: true,
        }}
        saving={false}
        error={null}
        fieldErrors={{}}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(inputHtmlBeforeLabel(html, 'Weekly')).toMatch(/\bchecked=""/);
    expect(inputHtmlBeforeLabel(html, 'Monday')).toMatch(/\bchecked=""/);
    expect(inputHtmlBeforeLabel(html, 'Tuesday')).not.toMatch(/\bchecked=""/);
    expect(html).toContain('value="09:00"');
    // The raw cron string is no longer a form field's `value` here — it
    // only appears as the live preview's muted mono text.
    expect(html).toContain('data-testid="schedule-preview"');
    expect(html).toContain('Every Monday at 09:00');
    expect(html).toContain('0 9 * * 1');
    expect(html).not.toContain('data-testid="schedule-weekday-error"');
  });

  it('editing a foreign-cron blueprint (outside the five builder families) opens in Advanced with the raw string intact', () => {
    const html = renderToStaticMarkup(
      <ClerkScheduledEditor
        initial={{
          name: 'Yearly kickoff reminder',
          prompt_text: 'Reminds the team on 1 Jan',
          cron_schedule: '0 9 1 1 *', // constrained month — outside all five families
          timezone: 'Europe/Berlin',
          enabled: true,
        }}
        saving={false}
        error={null}
        fieldErrors={{}}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(inputHtmlBeforeLabel(html, 'Advanced (cron)')).toMatch(/\bchecked=""/);
    expect(html).toContain('value="0 9 1 1 *"');
    expect(html).not.toContain('data-testid="schedule-weekday-grid"');
    // Advanced's own raw cron is a valid syntactic shape, so
    // `describeCronSchedule` still renders SOME sentence for it — the point
    // of this test is that the field opened populated with the raw string,
    // not that no translation exists.
    expect(html).toContain('0 9 1 1 *');
  });

  it('the live preview renders both the human sentence and the generated cron for the Daily default', () => {
    const html = renderToStaticMarkup(
      <ClerkScheduledEditor saving={false} error={null} fieldErrors={{}} onSave={vi.fn()} onCancel={vi.fn()} />,
    );

    expect(inputHtmlBeforeLabel(html, 'Daily')).toMatch(/\bchecked=""/);
    const previewStart = html.indexOf('data-testid="schedule-preview"');
    expect(previewStart).toBeGreaterThan(-1);
    const previewEnd = html.indexOf('</p>', previewStart);
    const preview = html.slice(previewStart, previewEnd);
    expect(preview).toContain('Every day at 09:00');
    expect(preview).toContain('0 9 * * *');
  });

  it('disables Save and Cancel while saving, and labels the button accordingly', () => {
    const html = renderToStaticMarkup(
      <ClerkScheduledEditor
        initial={{
          name: 'Weekly team case review',
          prompt_text: "Every Monday at 9, summarize my team's open cases",
          cron_schedule: '0 9 * * 1',
          timezone: 'Europe/Berlin',
          enabled: true,
        }}
        saving
        error={null}
        fieldErrors={{}}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(html).toContain('Saving…');
    expect(buttonHtmlFor(html, 'Saving…')).toMatch(/\bdisabled=""/);
    expect(buttonHtmlFor(html, 'Cancel')).toMatch(/\bdisabled=""/);
  });

  it('renders the cron field\'s inline validation message from the route, not a generic banner', () => {
    const html = renderToStaticMarkup(
      <ClerkScheduledEditor
        saving={false}
        error={null}
        fieldErrors={{ cron_schedule: 'cron_schedule must be 5 whitespace-separated fields (minute hour day-of-month month day-of-week)' }}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(html).toContain(
      'cron_schedule must be 5 whitespace-separated fields (minute hour day-of-month month day-of-week)',
    );
  });

  it('renders a generic save error without hiding the form', () => {
    const html = renderToStaticMarkup(
      <ClerkScheduledEditor
        saving={false}
        error="This blueprint could not be saved."
        fieldErrors={{}}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(html).toContain('This blueprint could not be saved.');
    expect(html).toContain('Create blueprint');
  });
});

describe('BlueprintRow', () => {
  it('renders the cron schedule both raw and as a human sentence, plus the timezone', () => {
    const html = renderToStaticMarkup(
      <BlueprintRow
        blueprint={blueprint()}
        occurrences={[]}
        editingLocked={false}
        running={false}
        toggling={false}
        onEdit={vi.fn()}
        onArchive={vi.fn()}
        onToggleEnabled={vi.fn()}
        onRunNow={vi.fn()}
      />,
    );

    expect(html).toContain('0 9 * * 1');
    expect(html).toContain('Every Monday at 09:00');
    expect(html).toContain('Europe/Berlin');
    expect(html).not.toContain('data-testid="blueprint-occurrences"');
  });

  it('renders the outcome badge and a case link for a known occurrence', () => {
    const html = renderToStaticMarkup(
      <BlueprintRow
        blueprint={blueprint()}
        occurrences={[
          {
            case_id: 'case_from_run_now',
            outcome: describeBlueprintOccurrenceOutcome({ status: 'done' }),
            optimistic: false,
          },
        ]}
        editingLocked={false}
        running={false}
        toggling={false}
        onEdit={vi.fn()}
        onArchive={vi.fn()}
        onToggleEnabled={vi.fn()}
        onRunNow={vi.fn()}
      />,
    );

    expect(html).toContain('data-testid="blueprint-occurrences"');
    expect(html).toContain('Done');
    expect(html).toContain('href="/cases/case_from_run_now"');
  });

  it('renders every occurrence row passed in, newest first, each with its own case link', () => {
    const html = renderToStaticMarkup(
      <BlueprintRow
        blueprint={blueprint()}
        occurrences={[
          { case_id: 'case_newest', outcome: describeBlueprintOccurrenceOutcome({ status: 'done' }), optimistic: false },
          { case_id: 'case_middle', outcome: describeBlueprintOccurrenceOutcome({ status: 'rejected' }), optimistic: false },
          { case_id: 'case_oldest', outcome: describeBlueprintOccurrenceOutcome({ status: 'open' }), optimistic: false },
        ]}
        editingLocked={false}
        running={false}
        toggling={false}
        onEdit={vi.fn()}
        onArchive={vi.fn()}
        onToggleEnabled={vi.fn()}
        onRunNow={vi.fn()}
      />,
    );

    expect(html).toContain('href="/cases/case_newest"');
    expect(html).toContain('href="/cases/case_middle"');
    expect(html).toContain('href="/cases/case_oldest"');
    // Newest first — the same order `occurrences` was given in.
    expect(html.indexOf('case_newest')).toBeLessThan(html.indexOf('case_middle'));
    expect(html.indexOf('case_middle')).toBeLessThan(html.indexOf('case_oldest'));
  });

  it('renders the reads-withheld badge with a neutral grey class, not an amber warning color', () => {
    // The locked "Withheld reads" rule: this flag must not
    // render as an amber warning. Reverting `READS_WITHHELD_BADGE_CLASS` back
    // to a `corp-yellow` token makes this fail.
    const html = renderToStaticMarkup(
      <BlueprintRow
        blueprint={blueprint()}
        occurrences={[
          {
            case_id: 'case_reads_withheld',
            outcome: describeBlueprintOccurrenceOutcome({ status: 'done', readsWithheld: true }),
            optimistic: false,
          },
        ]}
        editingLocked={false}
        running={false}
        toggling={false}
        onEdit={vi.fn()}
        onArchive={vi.fn()}
        onToggleEnabled={vi.fn()}
        onRunNow={vi.fn()}
      />,
    );

    expect(html).toContain('Reads withheld');
    expect(html).not.toContain('corp-yellow');
    expect(html).not.toContain('corp-red');
    expect(html).toContain('bg-gray-100');
  });

  it('locks Run now, Edit, Archive, and the Enabled toggle while another row is being edited', () => {
    const html = renderToStaticMarkup(
      <BlueprintRow
        blueprint={blueprint()}
        occurrences={[]}
        editingLocked
        running={false}
        toggling={false}
        onEdit={vi.fn()}
        onArchive={vi.fn()}
        onToggleEnabled={vi.fn()}
        onRunNow={vi.fn()}
      />,
    );

    expect(buttonHtmlFor(html, 'Run now')).toMatch(/\bdisabled=""/);
    expect(buttonHtmlFor(html, 'Edit')).toMatch(/\bdisabled=""/);
    expect(buttonHtmlFor(html, 'Archive')).toMatch(/\bdisabled=""/);
    expect(checkboxHtml(html)).toMatch(/\bdisabled=""/);
  });

  it('labels the toggle Enabled/Disabled to match the blueprint state', () => {
    const enabledHtml = renderToStaticMarkup(
      <BlueprintRow
        blueprint={blueprint({ enabled: true })}
        occurrences={[]}
        editingLocked={false}
        running={false}
        toggling={false}
        onEdit={vi.fn()}
        onArchive={vi.fn()}
        onToggleEnabled={vi.fn()}
        onRunNow={vi.fn()}
      />,
    );
    expect(enabledHtml).toContain('>Enabled<');

    const disabledHtml = renderToStaticMarkup(
      <BlueprintRow
        blueprint={blueprint({ enabled: false })}
        occurrences={[]}
        editingLocked={false}
        running={false}
        toggling={false}
        onEdit={vi.fn()}
        onArchive={vi.fn()}
        onToggleEnabled={vi.fn()}
        onRunNow={vi.fn()}
      />,
    );
    expect(disabledHtml).toContain('>Disabled<');
  });
});

describe('groupAssistantTasksByBlueprint', () => {
  it('groups tasks by blueprint_id and drops tasks with none', () => {
    const grouped = groupAssistantTasksByBlueprint([
      task({ case_id: 'case_a', blueprint_id: 'taskBlueprint_x' }),
      task({ case_id: 'case_b' }), // no blueprint_id — an Ask-tab task
      task({ case_id: 'case_c', blueprint_id: 'taskBlueprint_y' }),
      task({ case_id: 'case_d', blueprint_id: 'taskBlueprint_x' }),
    ]);

    expect(grouped.taskBlueprint_x?.map((t) => t.case_id)).toEqual(['case_a', 'case_d']);
    expect(grouped.taskBlueprint_y?.map((t) => t.case_id)).toEqual(['case_c']);
    expect(Object.keys(grouped)).not.toContain('undefined');
  });

  it('preserves the input order within each group (already newest-first from the route)', () => {
    const grouped = groupAssistantTasksByBlueprint([
      task({ case_id: 'case_newest', blueprint_id: 'taskBlueprint_x', updated_at: '2026-08-03T00:00:00.000Z' }),
      task({ case_id: 'case_oldest', blueprint_id: 'taskBlueprint_x', updated_at: '2026-08-01T00:00:00.000Z' }),
    ]);

    expect(grouped.taskBlueprint_x?.map((t) => t.case_id)).toEqual(['case_newest', 'case_oldest']);
  });
});

describe('occurrencesForBlueprint', () => {
  it('caps at three occurrences even when more real ones exist', () => {
    const byBlueprint = {
      taskBlueprint_x: [
        task({ case_id: 'case_1' }),
        task({ case_id: 'case_2' }),
        task({ case_id: 'case_3' }),
        task({ case_id: 'case_4' }),
      ],
    };

    const rows = occurrencesForBlueprint(byBlueprint, {}, 'taskBlueprint_x');

    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.case_id)).toEqual(['case_1', 'case_2', 'case_3']);
  });

  it('prepends the session-local overlay when its case is not yet in the real list', () => {
    const byBlueprint = { taskBlueprint_x: [task({ case_id: 'case_real' })] };
    const lastRun = { taskBlueprint_x: { case_id: 'case_just_fired', status: 'open', replayed: false } };

    const rows = occurrencesForBlueprint(byBlueprint, lastRun, 'taskBlueprint_x');

    expect(rows.map((r) => r.case_id)).toEqual(['case_just_fired', 'case_real']);
    expect(rows[0]?.optimistic).toBe(true);
    expect(rows[1]?.optimistic).toBe(false);
  });

  it('drops the overlay once its case appears in the real list, using the real row instead', () => {
    // This is the "overlay superseded by revalidation" behaviour #858 asks
    // for. Reverting the `overlayIsReal` check (always prepending the
    // overlay regardless) would duplicate this case as two rows.
    const byBlueprint = {
      taskBlueprint_x: [task({ case_id: 'case_confirmed', status: 'done', reads_withheld: true })],
    };
    const lastRun = { taskBlueprint_x: { case_id: 'case_confirmed', status: 'open', replayed: false } };

    const rows = occurrencesForBlueprint(byBlueprint, lastRun, 'taskBlueprint_x');

    expect(rows).toHaveLength(1);
    expect(rows[0]?.optimistic).toBe(false);
    // The real row's outcome reflects `reads_withheld`, which the overlay
    // (sourced from the Run-now response at creation time) could never know.
    expect(rows[0]?.outcome.outcome).toBe('reads_withheld');
  });

  it('returns nothing for a blueprint with neither a real occurrence nor an overlay', () => {
    expect(occurrencesForBlueprint({}, {}, 'taskBlueprint_never_run')).toEqual([]);
  });
});

describe('ClerkScheduledPanel', () => {
  beforeEachClearMocks();

  function mockBlueprints(blueprints: TaskBlueprint[], tasks: AssistantTaskSummary[] = []): void {
    mockedUseSWR.mockImplementation((key: unknown) => {
      if (Array.isArray(key) && key[0] === 'clerk-blueprints' && key[1] === 'uid_a') {
        return { data: { blueprints }, error: undefined, isLoading: false, mutate: mocks.mutate };
      }
      // Matches on the first two elements only — `assistantTasksSwrKey`'s
      // third element is the limit, and this mock does not care what limit
      // was asked for, only that IT is the key carrying `tasks`.
      if (Array.isArray(key) && key[0] === 'assistant-tasks' && key[1] === 'uid_a') {
        return { data: { tasks }, error: undefined, isLoading: false, mutate: mocks.mutateTasks };
      }
      return { data: undefined, error: undefined, isLoading: false, mutate: vi.fn() };
    });
  }

  it('lists blueprints from the route: name, raw cron, human sentence, and timezone', () => {
    mockBlueprints([blueprint()]);

    const html = renderToStaticMarkup(<ClerkScheduledPanel />);

    expect(html).toContain('Weekly team case review');
    expect(html).toContain('0 9 * * 1');
    expect(html).toContain('Every Monday at 09:00');
    expect(html).toContain('Europe/Berlin');
  });

  it('shows the empty-state hint and example when there are no blueprints', () => {
    mockBlueprints([]);

    const html = renderToStaticMarkup(<ClerkScheduledPanel />);

    expect(html).toContain('Nothing yet');
    expect(html).toContain('Every Monday at 9, summarize my team&#x27;s open cases');
    expect(html).not.toContain('data-testid="blueprint-list"');
  });

  it('hides an archived blueprint even though the route still returns it', () => {
    mockBlueprints([
      blueprint({ blueprint_id: 'taskBlueprint_live', name: 'Live one' }),
      blueprint({
        blueprint_id: 'taskBlueprint_archived',
        name: 'Archived one',
        archived_at: '2026-08-01T00:00:00.000Z',
      }),
    ]);

    const html = renderToStaticMarkup(<ClerkScheduledPanel />);

    expect(html).toContain('Live one');
    expect(html).not.toContain('Archived one');
  });

  it('archives a blueprint once its confirm dialog is confirmed', async () => {
    const target = blueprint({ blueprint_id: 'taskBlueprint_live', name: 'Live one' });
    mockBlueprints([target]);
    mocks.archive.mockResolvedValue({
      blueprint: { ...target, archived_at: '2026-08-06T00:00:00.000Z', enabled: false },
    });
    mocks.mutate.mockResolvedValue(undefined);

    renderToStaticMarkup(<ClerkScheduledPanel />);

    expect(mocks.confirmDialogProps.current).toBeDefined();
    mocks.confirmDialogProps.current!.onConfirm();

    await vi.waitFor(() => {
      expect(mocks.addToast).toHaveBeenCalledWith('success', 'Blueprint archived');
    });
    expect(mocks.archive).toHaveBeenCalledWith('taskBlueprint_live');
    expect(mocks.mutate).toHaveBeenCalledWith(
      { blueprints: [{ ...target, archived_at: '2026-08-06T00:00:00.000Z', enabled: false }] },
      { revalidate: false },
    );
  });

  it('reports a failed archive without crashing, and never claims success', async () => {
    const target = blueprint();
    mockBlueprints([target]);
    mocks.archive.mockRejectedValue(new Error('network down'));

    renderToStaticMarkup(<ClerkScheduledPanel />);
    mocks.confirmDialogProps.current!.onConfirm();

    await vi.waitFor(() => {
      expect(mocks.addToast).toHaveBeenCalledWith('error', 'network down');
    });
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it('renders each blueprint\'s real occurrences from the task list, grouped by blueprint_id', () => {
    const target = blueprint({ blueprint_id: 'taskBlueprint_live' });
    mockBlueprints(
      [target],
      [
        task({ case_id: 'case_from_route', blueprint_id: 'taskBlueprint_live', status: 'done' }),
        task({ case_id: 'case_other_blueprint', blueprint_id: 'taskBlueprint_other', status: 'done' }),
      ],
    );

    const html = renderToStaticMarkup(<ClerkScheduledPanel />);

    expect(html).toContain('href="/cases/case_from_route"');
    expect(html).not.toContain('href="/cases/case_other_blueprint"');
  });

  it('requests the task list at OCCURRENCE_TASK_LIST_LIMIT, with the limit folded into the SWR key, refreshing every 15s', () => {
    mockBlueprints([blueprint()]);

    renderToStaticMarkup(<ClerkScheduledPanel />);

    const tasksCall = mockedUseSWR.mock.calls.find(
      (call) => Array.isArray(call[0]) && call[0][0] === 'assistant-tasks',
    );
    expect(tasksCall).toBeDefined();
    // Reverting `assistantTasksSwrKey`'s limit branch (always returning the
    // 2-tuple) or dropping `OCCURRENCE_TASK_LIST_LIMIT` from this call would
    // make this collapse to the same key `ClerkAskPanel` uses — see that
    // key's own doc comment on why that is cache bleed, not dedup.
    expect(tasksCall?.[0]).toEqual(['assistant-tasks', 'uid_a', OCCURRENCE_TASK_LIST_LIMIT]);
    expect((tasksCall?.[2] as { refreshInterval?: number } | undefined)?.refreshInterval).toBe(15_000);
  });

  it('mutates the task list after a successful run-now, so the optimistic overlay is superseded', async () => {
    // #858: nothing else polls the task list while this tab is open besides
    // `refreshInterval`. Without this call, an occurrence fired from THIS
    // panel would show only the session-local overlay (status at creation)
    // until the next 15s tick — up to 15s of the panel showing a state it
    // could have corrected immediately. Removing the `void mutateTasks();`
    // line from `handleRunNow` makes this assertion fail.
    const target = blueprint({ blueprint_id: 'taskBlueprint_live' });
    mockBlueprints([target]);
    mocks.runNow.mockResolvedValue({
      case_id: 'case_new',
      run_id: 'run_new',
      status: 'open',
      replayed: false,
    });

    renderToStaticMarkup(<ClerkScheduledPanel />);

    const runNowProps = mocks.buttonProps.find((props) => props.children === 'Run now');
    expect(runNowProps).toBeDefined();
    (runNowProps!.onClick as () => void)();

    await vi.waitFor(() => {
      expect(mocks.mutateTasks).toHaveBeenCalled();
    });
    expect(mocks.runNow).toHaveBeenCalledWith('taskBlueprint_live');
  });
});

/**
 * `beforeEach` declared as a function (rather than a bare top-level call) so
 * every `describe` block above can opt in explicitly, next to the mocks it
 * actually resets — matching this suite's own naming, not a global default
 * that would silently apply to the pure-function blocks too.
 */
function beforeEachClearMocks(): void {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mutate.mockResolvedValue(undefined);
    mocks.confirmDialogProps.current = undefined;
    mocks.buttonProps.length = 0;
  });
}
