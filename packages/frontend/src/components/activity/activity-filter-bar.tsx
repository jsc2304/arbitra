'use client';

/**
 * <ActivityFilterBar> — consolidated filter bar.
 *
 * Single bar replacing the previous two rows (chip strip + dropdowns):
 *
 *   [Signal | Raw]   What ▾   Who ▾   Where ▾   When ▾   [chips]   [Clear]
 *
 * Multi-select dropdowns with counts. Active selections render below as
 * removable chips. URL state is owned by the parent; this component is a pure
 * controlled view over a `MultiActivityFilter`.
 */

import { useEffect, useId, useRef, useState } from 'react';
import {
  ACTOR_TOKEN_AGENTS,
  DEFAULT_MULTI_FILTER,
  countByKind,
  isMultiFilterPristine,
  type ActivityActorToken,
  type ActivityKind,
  type ActivityMode,
  type ActivitySinceWindow,
  type MultiActivityFilter,
} from '../../lib/activity-feed-presentation';
import type { ActivityEntry } from '@arbitra/shared';
import { actorDisplayName } from '../../lib/actor-display';

interface ActivityFilterBarProps {
  filter: MultiActivityFilter;
  onChange: (next: MultiActivityFilter) => void;
  /** Visible feed entries (post-server-filter, pre-multi-filter) for count badges. */
  entries: ActivityEntry[];
  /** All accessible projects for the Where dropdown. */
  projectOptions: Array<{ id: string; name: string }>;
  /** All `client_name` values seen in the visible window for the Who dropdown. */
  clientOptions: string[];
}

const KIND_LABELS: Record<ActivityKind, string> = {
  lifecycle: 'Lifecycle',
  finding: 'Findings',
  decision: 'Decisions',
  evidence: 'Evidence',
  comment: 'Comments',
  system: 'System',
};

const KIND_ORDER: ActivityKind[] = [
  'lifecycle',
  'finding',
  'decision',
  'evidence',
  'comment',
  'system',
];

const SINCE_OPTIONS: Array<{ value: ActivitySinceWindow; label: string }> = [
  { value: '1h', label: '1 hour' },
  { value: '24h', label: '24 hours' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: 'all', label: 'All time' },
];

const SINCE_SHORT_LABEL: Record<ActivitySinceWindow, string> = {
  '1h': '1h',
  '24h': '24h',
  '7d': '7d',
  '30d': '30d',
  all: 'All',
};

export function ActivityFilterBar({
  filter,
  onChange,
  entries,
  projectOptions,
  clientOptions,
}: ActivityFilterBarProps) {
  const counts = countByKind(entries);

  const setMode = (mode: ActivityMode) => onChange({ ...filter, mode });
  const toggleKind = (kind: ActivityKind) => {
    const next = filter.kinds.includes(kind)
      ? filter.kinds.filter((k) => k !== kind)
      : [...filter.kinds, kind];
    onChange({ ...filter, kinds: next });
  };
  const toggleActor = (token: ActivityActorToken) => {
    const next = filter.actors.includes(token)
      ? filter.actors.filter((a) => a !== token)
      : [...filter.actors, token];
    onChange({ ...filter, actors: next });
  };
  const toggleProject = (id: string) => {
    const next = filter.projects.includes(id)
      ? filter.projects.filter((p) => p !== id)
      : [...filter.projects, id];
    onChange({ ...filter, projects: next });
  };
  const setSince = (since: ActivitySinceWindow) => onChange({ ...filter, since });
  const clearAll = () => onChange({ ...DEFAULT_MULTI_FILTER });

  const removeKind = (kind: ActivityKind) =>
    onChange({ ...filter, kinds: filter.kinds.filter((k) => k !== kind) });
  const removeActor = (token: ActivityActorToken) =>
    onChange({ ...filter, actors: filter.actors.filter((a) => a !== token) });
  const removeProject = (id: string) =>
    onChange({ ...filter, projects: filter.projects.filter((p) => p !== id) });

  const projectNameById = new Map(projectOptions.map((p) => [p.id, p.name]));
  const actorLabel = (token: ActivityActorToken): string => {
    if (token === ACTOR_TOKEN_AGENTS) return 'Agents';
    return actorDisplayName(undefined, { client_name: token }).label;
  };

  // Always include the active actor / project even if not in the source list,
  // so a hard-reload landing on a deep filter still has reachable menu items.
  const clientsForMenu = (() => {
    const set = new Set<string>(clientOptions);
    for (const a of filter.actors) if (a !== ACTOR_TOKEN_AGENTS) set.add(a);
    return [...set].sort();
  })();
  const projectsForMenu = (() => {
    const ids = new Set(projectOptions.map((p) => p.id));
    const out = [...projectOptions];
    for (const id of filter.projects) {
      if (!ids.has(id)) out.push({ id, name: id });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  })();

  return (
    <div data-testid="activity-filter-bar">
      <div className="flex flex-wrap items-center gap-2">
        <ModeToggle mode={filter.mode} onChange={setMode} />

        <DropdownMenu
          label="What"
          summary={kindDropdownSummary(filter.kinds, counts)}
          ariaLabel="Filter by event kind"
        >
          {KIND_ORDER.map((kind) => (
            <CheckboxRow
              key={kind}
              checked={filter.kinds.includes(kind)}
              onChange={() => toggleKind(kind)}
              label={KIND_LABELS[kind]}
              count={counts[kind]}
            />
          ))}
        </DropdownMenu>

        <DropdownMenu
          label="Who"
          summary={
            filter.actors.length === 0
              ? 'All actors'
              : `${filter.actors.length} selected`
          }
          ariaLabel="Filter by actor"
        >
          <CheckboxRow
            checked={filter.actors.includes(ACTOR_TOKEN_AGENTS)}
            onChange={() => toggleActor(ACTOR_TOKEN_AGENTS)}
            label="Agents only"
          />
          {clientsForMenu.length > 0 && (
            <>
              <div className="my-1 border-t border-gray-100 dark:border-border-subtle" />
              {clientsForMenu.map((c) => (
                <CheckboxRow
                  key={c}
                  checked={filter.actors.includes(c)}
                  onChange={() => toggleActor(c)}
                  label={actorDisplayName(undefined, { client_name: c }).label}
                />
              ))}
            </>
          )}
        </DropdownMenu>

        <DropdownMenu
          label="Where"
          summary={
            filter.projects.length === 0
              ? 'All projects'
              : `${filter.projects.length} selected`
          }
          ariaLabel="Filter by project"
        >
          {projectsForMenu.length === 0 ? (
            <p className="px-2 py-1 text-xs text-gray-500 dark:text-gray-400">
              No projects available
            </p>
          ) : (
            projectsForMenu.map((p) => (
              <CheckboxRow
                key={p.id}
                checked={filter.projects.includes(p.id)}
                onChange={() => toggleProject(p.id)}
                label={p.name}
              />
            ))
          )}
        </DropdownMenu>

        <DropdownMenu
          label="When"
          summary={SINCE_SHORT_LABEL[filter.since]}
          ariaLabel="Filter by time window"
        >
          {SINCE_OPTIONS.map((opt) => (
            <RadioRow
              key={opt.value}
              checked={filter.since === opt.value}
              onChange={() => setSince(opt.value)}
              label={opt.label}
            />
          ))}
        </DropdownMenu>
      </div>

      {!isMultiFilterPristine(filter) && (
        <div
          data-testid="activity-filter-chips"
          className="mt-3 flex flex-wrap items-center gap-2"
        >
          {filter.mode !== DEFAULT_MULTI_FILTER.mode && (
            <ChipPill
              label={`Mode: ${filter.mode === 'signal' ? 'Signal' : 'Raw'}`}
              onRemove={() => setMode(DEFAULT_MULTI_FILTER.mode)}
            />
          )}
          {filter.since !== DEFAULT_MULTI_FILTER.since && (
            <ChipPill
              label={`When: ${SINCE_SHORT_LABEL[filter.since]}`}
              onRemove={() => setSince(DEFAULT_MULTI_FILTER.since)}
            />
          )}
          {filter.kinds.map((k) => (
            <ChipPill
              key={`kind-${k}`}
              label={`What: ${KIND_LABELS[k]}`}
              onRemove={() => removeKind(k)}
            />
          ))}
          {filter.actors.map((a) => (
            <ChipPill
              key={`actor-${a}`}
              label={`Who: ${actorLabel(a)}`}
              onRemove={() => removeActor(a)}
            />
          ))}
          {filter.projects.map((p) => (
            <ChipPill
              key={`project-${p}`}
              label={`Where: ${projectNameById.get(p) ?? p}`}
              onRemove={() => removeProject(p)}
            />
          ))}
          <button
            type="button"
            onClick={clearAll}
            data-testid="activity-filter-clear-all"
            className="text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
          >
            Clear all
          </button>
        </div>
      )}
    </div>
  );
}

function ModeToggle({ mode, onChange }: { mode: ActivityMode; onChange: (m: ActivityMode) => void }) {
  return (
    <div
      role="group"
      aria-label="Activity mode"
      className="inline-flex items-center rounded-md border border-gray-200 dark:border-border-subtle p-0.5"
    >
      {(['signal', 'raw'] as ActivityMode[]).map((value) => {
        const active = mode === value;
        return (
          <button
            key={value}
            type="button"
            onClick={() => onChange(value)}
            data-testid={`activity-mode-${value}`}
            className={`px-2.5 py-1 text-xs rounded transition-colors ${
              active
                ? 'bg-accent-700 text-white'
                : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
            }`}
            aria-pressed={active}
          >
            {value === 'signal' ? 'Signal' : 'Raw'}
          </button>
        );
      })}
    </div>
  );
}

function kindDropdownSummary(
  selectedKinds: ActivityKind[],
  counts: Record<ActivityKind, number>,
): string {
  if (selectedKinds.length === 0) {
    const sum = Object.values(counts).reduce((a, b) => a + b, 0);
    return `All (${sum})`;
  }
  if (selectedKinds.length === 1) {
    const k = selectedKinds[0]!;
    return `${KIND_LABELS[k]} (${counts[k]})`;
  }
  return `${selectedKinds.length} selected`;
}

function DropdownMenu({
  label,
  summary,
  ariaLabel,
  children,
}: {
  label: string;
  summary: string;
  ariaLabel: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        aria-label={ariaLabel}
        className="inline-flex items-center gap-1 rounded-md border border-gray-200 bg-surface-base px-2 py-1 text-xs text-gray-700 hover:text-gray-900 dark:border-border-subtle dark:bg-surface-base/40 dark:text-gray-300 dark:hover:text-gray-100"
      >
        <span className="font-medium">{label}</span>
        <span className="text-gray-500 dark:text-gray-400">{summary}</span>
        <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div
          id={id}
          role="menu"
          className="absolute left-0 z-20 mt-1 min-w-[14rem] max-h-72 overflow-auto rounded-md border border-gray-200 bg-surface-raised p-1 shadow-lg dark:border-border-subtle"
        >
          {children}
        </div>
      )}
    </div>
  );
}

function CheckboxRow({
  checked,
  onChange,
  label,
  count,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
  count?: number;
}) {
  return (
    <label className="flex items-center justify-between gap-3 rounded px-2 py-1 text-xs text-gray-700 hover:bg-surface-base dark:text-gray-200 dark:hover:bg-border-subtle/40 cursor-pointer">
      <span className="inline-flex items-center gap-2">
        <input
          type="checkbox"
          checked={checked}
          onChange={onChange}
          className="h-3.5 w-3.5 rounded border-gray-300 text-accent focus:ring-accent"
        />
        <span>{label}</span>
      </span>
      {typeof count === 'number' && (
        <span className="text-[10px] text-gray-500 dark:text-gray-400">{count}</span>
      )}
    </label>
  );
}

function RadioRow({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <label className="flex items-center gap-2 rounded px-2 py-1 text-xs text-gray-700 hover:bg-surface-base dark:text-gray-200 dark:hover:bg-border-subtle/40 cursor-pointer">
      <input
        type="radio"
        checked={checked}
        onChange={onChange}
        className="h-3.5 w-3.5 border-gray-300 text-accent focus:ring-accent"
      />
      <span>{label}</span>
    </label>
  );
}

function ChipPill({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-gray-200 bg-surface-base px-2 py-1 text-xs text-gray-600 dark:border-border-subtle dark:bg-surface-base/40 dark:text-gray-300">
      {label}
      <button
        type="button"
        onClick={onRemove}
        className="text-gray-400 hover:text-gray-700 dark:text-gray-500 dark:hover:text-gray-200"
        aria-label={`Remove filter ${label}`}
      >
        <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 6 6 18" />
          <path d="m6 6 12 12" />
        </svg>
      </button>
    </span>
  );
}
