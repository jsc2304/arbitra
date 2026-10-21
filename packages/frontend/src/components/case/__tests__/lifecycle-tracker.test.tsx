/**
 * @file LifecycleTracker — case-detail strip behaviour.
 *
 * Server-render only (renderToStaticMarkup) — the frontend test setup is
 * intentionally node-only (no jsdom, no fireEvent/userEvent), matching the
 * rest of the component suite. Locks:
 *   1. With `showLabels`, each main-stage label renders below its station.
 *   2. Past stages whose entry event is present render as activatable
 *      `<button>` elements with the canonical "Jump to <Label> in timeline"
 *      aria-label so the click-to-scroll wiring is keyboard-reachable.
 *   3. Future stages never render as buttons (no extra tab stops).
 *   4. The strip wraps the dot row in an `overflow-x-auto` container so
 *      narrow viewports scroll horizontally rather than compressing.
 *   5. `StageTooltipBody` renders the bold name, description, and either
 *      entry-timestamp footer (past) or "Next: <gate>" (future).
 *   6. `resolveEntryEventByStatus` (the pure helper behind the click wiring)
 *      selects each past stage's *entry* `event_id` — the exact payload the
 *      `onStageClick` handler fires. Asserting this directly proves the click
 *      contract without a DOM/renderer, mirroring how `canConfirmDelete` /
 *      `normalizeUserCode` unit-test handler logic elsewhere in this suite.
 *
 * Tooltip hover/portal behaviour is covered by the Tooltip primitive's own
 * suite — we don't re-test that here.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { getTransitionsFrom } from '@arbitra/shared';
import type { CaseEvent, CaseStatus } from '@arbitra/shared';
import { LifecycleTracker, StageTooltipBody, resolveEntryEventByStatus } from '../lifecycle-tracker';
import {
  getLifecycleDefinition,
  MAIN_STAGES,
  STAGE_COLORS,
} from '../../../lib/lifecycle-stages';

function evt(partial: Partial<CaseEvent> & { event_id: string; type: string; created_at: string }): CaseEvent {
  return {
    case_id: 'case_x',
    actor_id: 'actor_x',
    payload: {},
    ...partial,
  } as CaseEvent;
}

describe('LifecycleTracker — compact + showLabels', () => {
  const events: CaseEvent[] = [
    evt({ event_id: 'evt_open', type: 'case_created', created_at: '2026-05-01T10:00:00Z' }),
    evt({ event_id: 'evt_explore', type: 'exploration_requested', created_at: '2026-05-01T10:05:00Z' }),
    evt({ event_id: 'evt_ready', type: 'case_ready_for_build', created_at: '2026-05-01T10:10:00Z' }),
    evt({ event_id: 'evt_build', type: 'build_started', created_at: '2026-05-01T10:15:00Z' }),
  ];

  it('renders every main-stage label when showLabels is set', () => {
    const html = renderToStaticMarkup(
      <LifecycleTracker status="in_build" variant="compact" showLabels events={events} onStageClick={() => {}} />,
    );
    for (const label of ['Open', 'Exploring', 'Ready', 'Building', 'Validating', 'AI Review', 'Approved', 'Merge PR', 'Done']) {
      expect(html).toContain(`>${label}<`);
    }
  });

  it('renders past-stage stations as buttons with a "Jump to ..." aria-label', () => {
    const html = renderToStaticMarkup(
      <LifecycleTracker status="in_build" variant="compact" showLabels events={events} onStageClick={() => {}} />,
    );
    expect(html).toContain('aria-label="Jump to Open in timeline"');
    expect(html).toContain('aria-label="Jump to Exploring in timeline"');
    expect(html).toContain('aria-label="Jump to Ready in timeline"');
    // Current stage (Building) is NOT a jump target.
    expect(html).not.toContain('aria-label="Jump to Building in timeline"');
    // Future stages never become buttons.
    expect(html).not.toContain('aria-label="Jump to Validating in timeline"');
    expect(html).not.toContain('aria-label="Jump to Done in timeline"');
  });

  it('resolves each past stage to its entry event_id — the exact onStageClick payload', () => {
    // The past-stage `<button>` onClick is `() => onStageClick(entry.eventId)`,
    // where `entry = resolveEntryEventByStatus(MAIN_STAGES, events)[stage.status]`.
    // So this map *is* the click payload per stage; asserting it locks the
    // wiring without needing a DOM to dispatch a synthetic click.
    const byStatus = resolveEntryEventByStatus(MAIN_STAGES, events);

    expect(byStatus.open?.eventId).toBe('evt_open');
    expect(byStatus.exploration?.eventId).toBe('evt_explore');
    expect(byStatus.ready_for_build?.eventId).toBe('evt_ready');
    expect(byStatus.in_build?.eventId).toBe('evt_build');
  });

  it('takes the *first* (oldest) matching event as a stage\'s entry, ignoring later ones', () => {
    // Two `case_created` events; the entry must be the earliest, since the
    // BFF returns events ascending and the resolver breaks on first match.
    const withDup: CaseEvent[] = [
      evt({ event_id: 'evt_open_first', type: 'case_created', created_at: '2026-05-01T10:00:00Z' }),
      evt({ event_id: 'evt_open_later', type: 'case_created', created_at: '2026-05-01T11:00:00Z' }),
    ];
    expect(resolveEntryEventByStatus(MAIN_STAGES, withDup).open?.eventId).toBe('evt_open_first');
  });

  it('returns an empty map when no events are supplied', () => {
    expect(resolveEntryEventByStatus(MAIN_STAGES, undefined)).toEqual({});
    expect(resolveEntryEventByStatus(MAIN_STAGES, [])).toEqual({});
  });

  it('does not surface past-stage buttons when no events are supplied', () => {
    const html = renderToStaticMarkup(
      <LifecycleTracker status="in_build" variant="compact" showLabels onStageClick={() => {}} />,
    );
    // No entry event → no button → no jump aria-label even for past stages.
    expect(html).not.toContain('Jump to Open in timeline');
  });

  it('wraps the strip in an overflow-x-auto container so narrow viewports scroll', () => {
    const html = renderToStaticMarkup(
      <LifecycleTracker status="in_build" variant="compact" showLabels events={events} onStageClick={() => {}} />,
    );
    expect(html).toContain('overflow-x-auto');
  });

  it('does not render labels in compact mode by default (review-session, board cards)', () => {
    const html = renderToStaticMarkup(
      <LifecycleTracker status="in_build" variant="compact" />,
    );
    // Native title fallback is still present, but no rendered label text.
    expect(html).not.toContain('>Building<');
    expect(html).not.toContain('overflow-x-auto');
  });

  it('keeps an explicit engineering case byte-identical to the existing default', () => {
    const currentDefault = renderToStaticMarkup(
      <LifecycleTracker status="in_build" variant="compact" showLabels events={events} />,
    );
    const explicitEngineering = renderToStaticMarkup(
      <LifecycleTracker
        status="in_build"
        caseType="bugfix"
        variant="compact"
        showLabels
        events={events}
      />,
    );

    expect(explicitEngineering).toBe(currentDefault);
  });

  it('renders only the scoped Clerk happy-path stations for a completed assistant task', () => {
    const html = renderToStaticMarkup(
      <LifecycleTracker status="done" caseType="assistant_task" variant="compact" showLabels />,
    );

    for (const label of ['Open', 'Building', 'Done']) {
      expect(html).toContain(`>${label}<`);
    }
    for (const engineeringOnly of [
      'Exploring',
      'Ready',
      'Validating',
      'AI Review',
      'Approved',
      'Merge PR',
    ]) {
      expect(html).not.toContain(`>${engineeringOnly}<`);
    }
  });

  it('does not show the unreachable assistant decision branch', () => {
    const html = renderToStaticMarkup(
      <LifecycleTracker
        status="needs_human_decision"
        caseType="assistant_task"
        variant="compact"
        showLabels
      />,
    );

    // Re-adding the deleted hold edge makes this branch reachable and is the
    // only lifecycle-matrix change that makes this assertion fail.
    expect(html).not.toContain('Needs Decision — branch');
    expect(html).not.toContain('>AI Review<');
  });

  it('ends a rejected assistant task after Building rather than drawing engineering stages', () => {
    const html = renderToStaticMarkup(
      <LifecycleTracker status="rejected" caseType="assistant_task" />,
    );

    expect(html).toContain('>Open<');
    expect(html).toContain('>Building<');
    expect(html).toContain('>Rejected<');
    expect(html).not.toContain('>Exploring<');
    expect(html).not.toContain('>AI Review<');
  });

  it('ends a rejected observed case after Observing rather than drawing engineering stages', () => {
    const html = renderToStaticMarkup(
      <LifecycleTracker status="rejected" caseType="observed" />,
    );

    expect(html).toContain('>Open<');
    expect(html).toContain('>Observing<');
    expect(html).toContain('>Rejected<');
    expect(html).not.toContain('>Exploring<');
    expect(html).not.toContain('>AI Review<');
  });

  it('renders the full nine-station engineering rail once escalated (case_type no longer observed)', () => {
    // Regression guard (issue #1018 AC): the rail keys off case_type, not
    // off how the case was created — an escalated case (case_type flipped
    // away from 'observed') must render the same chrome as any other case.
    const observedHtml = renderToStaticMarkup(
      <LifecycleTracker status="in_build" caseType="observed" variant="compact" showLabels />,
    );
    const escalatedHtml = renderToStaticMarkup(
      <LifecycleTracker status="in_build" caseType="bugfix" variant="compact" showLabels />,
    );
    const engineeringDefaultHtml = renderToStaticMarkup(
      <LifecycleTracker status="in_build" variant="compact" showLabels />,
    );

    expect(observedHtml).toContain('>Observing<');
    expect(observedHtml).not.toContain('>Building<');

    for (const label of ['Open', 'Exploring', 'Ready', 'Building', 'Validating', 'AI Review', 'Approved', 'Merge PR', 'Done']) {
      expect(escalatedHtml).toContain(`>${label}<`);
    }
    expect(escalatedHtml).not.toContain('>Observing<');
    expect(escalatedHtml).toBe(engineeringDefaultHtml);
  });

  it('renders only the scoped Observed Case stations, labeled honestly (issue #1018)', () => {
    const html = renderToStaticMarkup(
      <LifecycleTracker status="in_build" caseType="observed" variant="compact" showLabels />,
    );

    expect(html).toContain('>Open<');
    // in_build reads as "Observing" for an Observed Case, not "Building".
    expect(html).toContain('>Observing<');
    expect(html).not.toContain('>Building<');
    expect(html).toContain('>Done<');
    for (const engineeringOnly of [
      'Exploring',
      'Ready',
      'Validating',
      'AI Review',
      'Approved',
      'Merge PR',
    ]) {
      expect(html).not.toContain(`>${engineeringOnly}<`);
    }
  });

  it('renders done as a quiet archived lifecycle with gray static tracks', () => {
    const html = renderToStaticMarkup(
      <LifecycleTracker status="done" variant="compact" showLabels events={events} onStageClick={() => {}} />,
    );

    expect(html).toContain('font-semibold text-gray-600 dark:text-gray-200');
    expect(html).toContain('bg-gray-300 dark:bg-gray-600');
    expect(html).not.toContain('lifecycle-station-pulse');
    expect(html).not.toContain('lifecycle-track-shimmer');
    expect(html).not.toContain('lifecycle-track-active');
  });

  it('adds the brighter active transition treatment only for an in-flight current segment', () => {
    const html = renderToStaticMarkup(
      <LifecycleTracker status="in_build" variant="compact" showLabels events={events} onStageClick={() => {}} />,
    );

    expect(html).toContain('lifecycle-station-pulse');
    expect(html).toContain('lifecycle-track-shimmer');
    expect(html).toContain('lifecycle-track-active');
  });

  it('applies the same quiet done treatment to the full horizontal tracker', () => {
    const html = renderToStaticMarkup(
      <LifecycleTracker status="done" />,
    );

    expect(html).toContain('font-semibold text-gray-600 dark:text-gray-200');
    expect(html).toContain('bg-gray-300 dark:bg-gray-600');
    expect(html).not.toContain('lifecycle-station-pulse');
    expect(html).not.toContain('lifecycle-track-shimmer');
    expect(html).not.toContain('lifecycle-track-active');
  });

  it('freezes the animation on rejected (terminal) like done', () => {
    // Regression guard: `rejected` is terminal, so the flow must stop — no
    // station pulse, no track shimmer/active glow — in both variants.
    for (const html of [
      renderToStaticMarkup(<LifecycleTracker status="rejected" />),
      renderToStaticMarkup(
        <LifecycleTracker status="rejected" variant="compact" showLabels events={events} onStageClick={() => {}} />,
      ),
    ]) {
      expect(html).not.toContain('lifecycle-station-pulse');
      expect(html).not.toContain('lifecycle-track-shimmer');
      expect(html).not.toContain('lifecycle-track-active');
    }
  });

  it('keeps rejected red rather than applying the done grey-out', () => {
    // Rejected freezes animation but is NOT muted like done: the terminal
    // node stays corp-red and the track keeps its stage hue (the red pill in
    // the UI), so the failure signal is preserved.
    const html = renderToStaticMarkup(<LifecycleTracker status="rejected" />);

    expect(html).toContain('>Rejected<');
    expect(html).toContain('text-corp-red dark:text-corp-red');
    // None of the done-only grey muting classes appear.
    expect(html).not.toContain('bg-gray-300 dark:bg-gray-600');
    expect(html).not.toContain('font-semibold text-gray-600 dark:text-gray-200');
  });
});

describe('assistant lifecycle definition', () => {
  it('derives every displayed assistant status from the scoped transition matrix', () => {
    const definition = getLifecycleDefinition('assistant_task');
    const matrixStatuses = new Set<CaseStatus>(['open']);
    const queue: CaseStatus[] = ['open'];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const transition of getTransitionsFrom(current, 'assistant_task')) {
        if (matrixStatuses.has(transition.to)) continue;
        matrixStatuses.add(transition.to);
        queue.push(transition.to);
      }
    }
    const displayedStatuses = new Set<CaseStatus>([
      ...definition.mainStages.map((stage) => stage.status),
      ...definition.branchStages.map((stage) => stage.status),
      'rejected',
    ]);

    expect(definition.mainStages.map((stage) => stage.status)).toEqual([
      'open',
      'in_build',
      'done',
    ]);
    expect(displayedStatuses).toEqual(matrixStatuses);
  });

  it('resolves assistant entry events for Building and Done', () => {
    const definition = getLifecycleDefinition('assistant_task');
    const byStatus = resolveEntryEventByStatus(definition.mainStages, [
      evt({
        event_id: 'evt_assistant_started',
        type: 'assistant_task_started',
        created_at: '2026-08-04T10:00:00Z',
      }),
      evt({
        event_id: 'evt_assistant_done',
        type: 'assistant_task_completed',
        created_at: '2026-08-04T10:00:05Z',
      }),
    ]);

    expect(byStatus.in_build?.eventId).toBe('evt_assistant_started');
    expect(byStatus.done?.eventId).toBe('evt_assistant_done');
  });
});

describe('observed lifecycle definition (issue #1018)', () => {
  it('derives the three-station rail from the scoped transition matrix, not a second hardcoded rail', () => {
    const definition = getLifecycleDefinition('observed');
    const matrixStatuses = new Set<CaseStatus>(['open']);
    const queue: CaseStatus[] = ['open'];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const transition of getTransitionsFrom(current, 'observed')) {
        if (matrixStatuses.has(transition.to)) continue;
        matrixStatuses.add(transition.to);
        queue.push(transition.to);
      }
    }
    // Unlike assistant_task, the observed matrix slice defines no transition
    // to 'rejected' at all (see status-transitions.ts) — every status the
    // matrix can reach is a displayed main-line station.
    const displayedStatuses = new Set<CaseStatus>([
      ...definition.mainStages.map((stage) => stage.status),
      ...definition.branchStages.map((stage) => stage.status),
    ]);

    expect(definition.mainStages.map((stage) => stage.status)).toEqual([
      'open',
      'in_build',
      'done',
    ]);
    expect(displayedStatuses).toEqual(matrixStatuses);
  });

  it('labels the in_build station "Observing" rather than "Building"', () => {
    const definition = getLifecycleDefinition('observed');
    const inBuildStage = definition.mainStages.find((stage) => stage.status === 'in_build');
    expect(inBuildStage?.label).toBe('Observing');
  });

  it('resolves observed entry events for Open and Observing', () => {
    const definition = getLifecycleDefinition('observed');
    const byStatus = resolveEntryEventByStatus(definition.mainStages, [
      evt({ event_id: 'evt_observed_created', type: 'case_created', created_at: '2026-08-27T11:24:55Z' }),
      evt({ event_id: 'evt_observed_started', type: 'observed_case_started', created_at: '2026-08-27T11:24:56Z' }),
    ]);

    expect(byStatus.open?.eventId).toBe('evt_observed_created');
    expect(byStatus.in_build?.eventId).toBe('evt_observed_started');
  });
});

describe('StageTooltipBody', () => {
  it('renders bold name + description + entry timestamp for past stages', () => {
    const html = renderToStaticMarkup(
      <StageTooltipBody
        label="Open"
        variant="completed"
        description="Case has been created and is awaiting an exploration run."
        gateText="Case is created."
        enteredAtIso="2026-05-01T10:00:00Z"
      />,
    );
    expect(html).toContain('font-semibold');
    expect(html).toContain('Open');
    expect(html).toContain('Case has been created');
    expect(html).toContain('Entered ');
  });

  it('renders the gate condition for future stages', () => {
    const html = renderToStaticMarkup(
      <StageTooltipBody
        label="Done"
        variant="future"
        description="Case is complete."
        gateText="PR is merged or the case is otherwise closed."
      />,
    );
    expect(html).toContain('Done');
    expect(html).toContain('Next: PR is merged');
  });

  it('renders "Active now" for the current stage', () => {
    const html = renderToStaticMarkup(
      <StageTooltipBody
        label="Building"
        variant="current"
        description="Agent is implementing the change against the plan."
        gateText="A build run begins."
      />,
    );
    expect(html).toContain('Active now');
  });

  it('renders "Skipped" when a past stage has no recorded entry event', () => {
    const html = renderToStaticMarkup(
      <StageTooltipBody
        label="Validating"
        variant="completed"
        description="Automated checks (lint, type, tests) are running on the build."
      />,
    );
    expect(html).toContain('Skipped');
  });
});
