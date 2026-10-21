'use client';

import { useEffect, useState } from 'react';
import type { CaseStatus, RiskLevel, ValidationTrack, Priority, Project, User } from '@arbitra/shared';
import { useAuth } from '../../providers/auth-provider';
import { api } from '../../lib/api-client';
import {
  loadCustomPresets,
  saveCustomPreset,
  deleteCustomPreset,
  resolvePresetFilters,
  isPresetActive,
  type FilterPreset,
} from '../../lib/filter-presets';

export interface BoardFilters {
  status?: CaseStatus;
  risk_level?: RiskLevel;
  validation_track?: ValidationTrack;
  priority?: Priority;
  owner_user_id?: string;
  project_id?: string;
  showArchived?: boolean;
  pendingGate?: boolean;
}

interface FilterBarProps {
  filters: BoardFilters;
  onChange: (filters: BoardFilters) => void;
  archivedCount?: number;
}

const ALL_STATUSES: CaseStatus[] = [
  'open',
  'exploration',
  'ready_for_build',
  'in_build',
  'in_validation',
  'in_review',
  'needs_human_decision',
  'verification_pending',
  'approved',
  'pending_merge',
  'done',
  'rejected',
];

const STATUS_LABELS: Record<CaseStatus, string> = {
  open:                 'Open',
  exploration:          'Exploring',
  ready_for_build:      'Ready',
  in_build:             'Building',
  in_validation:        'Validating',
  in_review:            'AI Review',
  needs_human_decision: 'Decide',
  verification_pending: 'Verify',
  approved:             'Approved',
  pending_merge:        'Merge PR',
  done:                 'Done',
  rejected:             'Rejected',
};

const ALL_RISK_LEVELS: RiskLevel[] = ['low', 'medium', 'high', 'critical'];
const ALL_TRACKS: ValidationTrack[] = ['direct', 'manual'];
const ALL_PRIORITIES: Priority[] = ['low', 'normal', 'high', 'urgent'];

const selectClasses =
  'rounded-md border border-gray-300 dark:border-border-default bg-input-bg px-3 py-1.5 text-sm text-gray-700 dark:text-gray-200 shadow-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent';

const DEMO_USER_ID = 'usr_dev';

export function FilterBar({ filters, onChange, archivedCount = 0 }: FilterBarProps) {
  const { user } = useAuth();
  const currentUserId = user?.uid ?? DEMO_USER_ID;
  const hasActiveFilters = Object.entries(filters).some(([k, v]) => k !== 'showArchived' && k !== 'pendingGate' && Boolean(v)) || !!filters.pendingGate;

  const [projects, setProjects] = useState<Project[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [customPresets, setCustomPresets] = useState<FilterPreset[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [presetName, setPresetName] = useState('');

  useEffect(() => {
    api.projects.list().then(({ projects: p }) => setProjects(p)).catch(() => {});
    api.users.list().then(({ users: u }) => setUsers(u)).catch(() => {});
    setCustomPresets(loadCustomPresets());
  }, []);

  function update(patch: Partial<BoardFilters>) {
    onChange({ ...filters, ...patch });
  }

  function applyPreset(preset: FilterPreset) {
    const resolved = resolvePresetFilters(preset.filters, currentUserId);
    onChange({ ...resolved, showArchived: filters.showArchived });
  }

  function handleSave() {
    const trimmed = presetName.trim();
    if (!trimmed) return;
    const { showArchived: _, ...filtersToSave } = filters;
    const updated = saveCustomPreset(trimmed, filtersToSave);
    setCustomPresets(updated);
    setPresetName('');
    setIsSaving(false);
  }

  function handleDelete(id: string) {
    const updated = deleteCustomPreset(id);
    setCustomPresets(updated);
  }

  const allPresets = customPresets;

  return (
    <div className="space-y-2">
      {/* Preset pills */}
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">Presets</label>

        {allPresets.map((preset) => {
          const active = isPresetActive(preset.filters, filters, currentUserId);
          return (
            <span key={preset.id} className="inline-flex items-center">
              <button
                type="button"
                className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  active
                    ? 'bg-accent-700 text-white'
                    : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700'
                }`}
                onClick={() => {
                  if (active) {
                    onChange({ showArchived: filters.showArchived });
                  } else {
                    applyPreset(preset);
                  }
                }}
              >
                {preset.name}
              </button>
              {!preset.builtin && (
                <button
                  type="button"
                  className="ml-0.5 rounded-full p-0.5 text-gray-400 hover:text-red-500 dark:text-gray-500 dark:hover:text-red-400 transition-colors"
                  onClick={() => handleDelete(preset.id)}
                  title={`Delete preset "${preset.name}"`}
                >
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </span>
          );
        })}

        {/* Save preset inline */}
        {hasActiveFilters && !isSaving && (
          <button
            type="button"
            className="rounded-full border border-dashed border-gray-300 dark:border-gray-600 px-3 py-1 text-xs font-medium text-gray-500 dark:text-gray-400 hover:border-accent hover:text-accent-700 dark:hover:border-accent-300 dark:hover:text-accent-300 transition-colors"
            onClick={() => setIsSaving(true)}
          >
            + Save Preset
          </button>
        )}

        {isSaving && (
          <span className="inline-flex items-center gap-1.5">
            <input
              type="text"
              autoFocus
              className="rounded-md border border-gray-300 dark:border-border-default bg-input-bg px-2 py-1 text-xs text-gray-700 dark:text-gray-200 shadow-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent w-36"
              placeholder="Preset name..."
              value={presetName}
              onChange={(e) => setPresetName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSave();
                if (e.key === 'Escape') { setIsSaving(false); setPresetName(''); }
              }}
            />
            <button
              type="button"
              className="rounded-md bg-accent-700 px-2 py-1 text-xs font-medium text-white hover:bg-accent-800 transition-colors disabled:bg-gray-300 disabled:text-gray-500 dark:disabled:bg-gray-800 dark:disabled:text-gray-500"
              disabled={!presetName.trim()}
              onClick={handleSave}
            >
              Save
            </button>
            <button
              type="button"
              className="rounded-md px-2 py-1 text-xs font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
              onClick={() => { setIsSaving(false); setPresetName(''); }}
            >
              Cancel
            </button>
          </span>
        )}
      </div>

      {/* Filter dropdowns */}
      <div className="flex flex-wrap items-center gap-3 rounded-lg bg-surface-raised p-3 shadow-sm border border-gray-200 dark:border-border-subtle">
        <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">Filters</label>

        <select
          className={selectClasses}
          value={filters.project_id ?? ''}
          onChange={(e) => update({ project_id: e.target.value || undefined })}
        >
          <option value="">All Projects</option>
          {projects.map((p) => (
            <option key={p.project_id} value={p.project_id}>
              {p.name}
            </option>
          ))}
        </select>

        <select
          className={selectClasses}
          value={filters.status ?? ''}
          onChange={(e) => update({ status: (e.target.value || undefined) as CaseStatus | undefined })}
        >
          <option value="">All Statuses</option>
          {ALL_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABELS[s]}
            </option>
          ))}
        </select>

        <select
          className={selectClasses}
          value={filters.risk_level ?? ''}
          onChange={(e) => update({ risk_level: (e.target.value || undefined) as RiskLevel | undefined })}
        >
          <option value="">All Risk Levels</option>
          {ALL_RISK_LEVELS.map((r) => (
            <option key={r} value={r} className="capitalize">
              {r.charAt(0).toUpperCase() + r.slice(1)}
            </option>
          ))}
        </select>

        <select
          className={selectClasses}
          value={filters.validation_track ?? ''}
          onChange={(e) => update({ validation_track: (e.target.value || undefined) as ValidationTrack | undefined })}
        >
          <option value="">All Tracks</option>
          {ALL_TRACKS.map((t) => (
            <option key={t} value={t}>
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </option>
          ))}
        </select>

        <select
          className={selectClasses}
          value={filters.priority ?? ''}
          onChange={(e) => update({ priority: (e.target.value || undefined) as Priority | undefined })}
        >
          <option value="">All Priorities</option>
          {ALL_PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {p.charAt(0).toUpperCase() + p.slice(1)}
            </option>
          ))}
        </select>

        <select
          className={selectClasses}
          value={filters.owner_user_id ?? ''}
          onChange={(e) => update({ owner_user_id: e.target.value || undefined })}
        >
          <option value="">All Owners</option>
          {users.map((u) => (
            <option key={u.user_id} value={u.user_id}>
              {u.display_name}
            </option>
          ))}
        </select>

        <div className="flex items-center gap-2 ml-auto">
          <button
            type="button"
            className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
              filters.pendingGate
                ? 'bg-amber-600 dark:bg-amber-500 text-white'
                : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700'
            }`}
            onClick={() => update({ pendingGate: !filters.pendingGate })}
            title={filters.pendingGate ? 'Show all cases' : 'Show only cases awaiting gate confirmation'}
          >
            <span className="inline-flex items-center gap-1">
              <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z" />
              </svg>
              Pending Gate
            </span>
          </button>

          <button
            type="button"
            className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
              filters.showArchived
                ? 'bg-gray-600 dark:bg-gray-500 text-white'
                : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700'
            }`}
            onClick={() => update({ showArchived: !filters.showArchived })}
            title={filters.showArchived ? 'Hide archived cases' : `Show ${archivedCount} archived cases`}
          >
            {filters.showArchived ? 'Hide' : 'Show'} archived
            {archivedCount > 0 && !filters.showArchived && (
              <span className="ml-1 inline-flex items-center justify-center rounded-full bg-gray-500 dark:bg-gray-600 text-white px-1.5 py-0.5 text-[10px] font-bold min-w-[1.25rem]">
                {archivedCount}
              </span>
            )}
          </button>

          {hasActiveFilters && (
            <button
              type="button"
              className="rounded-md bg-secondary-50 dark:bg-secondary-950/40 px-2.5 py-1.5 text-xs font-medium text-secondary-600 dark:text-secondary-400 hover:bg-secondary-100 dark:hover:bg-secondary-950/60 transition-colors"
              onClick={() => onChange({})}
            >
              Clear All
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
