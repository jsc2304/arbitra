/**
 * Filter-preset persistence for the Board.
 *
 * Triage views replaced the built-in presets in PR 2.3. Custom localStorage
 * presets are still supported but the built-in ones ("My Cases", "Review
 * Queue", "Needs Decision") were removed in favor of role-aware triage views.
 * Users need to re-save any custom preset names they want to keep — existing
 * localStorage entries under `arbitra:filter-presets` are preserved and will
 * continue to round-trip through `loadCustomPresets` / `saveCustomPreset` /
 * `deleteCustomPreset`.
 */

import type { BoardFilters } from '../components/board/filter-bar';

export interface FilterPreset {
  id: string;
  name: string;
  filters: BoardFilters;
  /**
   * @deprecated Built-in presets were removed in PR 2.3; this flag only lives
   * on to keep the shape stable for any caller still discriminating. New
   * presets created through `saveCustomPreset` leave it unset.
   */
  builtin?: boolean;
}

const STORAGE_KEY = 'arbitra:filter-presets';

/**
 * Resolve placeholder values in preset filters.
 *
 * Historically built-in presets used `__CURRENT_USER__` as a placeholder for
 * the acting user's ID. Kept exported for backwards compatibility with any
 * custom preset that was ever saved with the placeholder in place.
 */
export function resolvePresetFilters(
  filters: BoardFilters,
  currentUserId: string,
): BoardFilters {
  const resolved = { ...filters };
  if (resolved.owner_user_id === '__CURRENT_USER__') {
    resolved.owner_user_id = currentUserId;
  }
  return resolved;
}

/** Load user's custom presets from localStorage. */
export function loadCustomPresets(): FilterPreset[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

/** Save a new custom preset. Returns the updated list. */
export function saveCustomPreset(name: string, filters: BoardFilters): FilterPreset[] {
  const presets = loadCustomPresets();
  const preset: FilterPreset = {
    id: `preset_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name,
    filters,
  };
  presets.push(preset);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
  return presets;
}

/** Delete a custom preset by ID. Returns the updated list. */
export function deleteCustomPreset(id: string): FilterPreset[] {
  const presets = loadCustomPresets().filter((p) => p.id !== id);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
  return presets;
}

/** Check if a preset's filters match the current active filters. */
export function isPresetActive(
  presetFilters: BoardFilters,
  activeFilters: BoardFilters,
  currentUserId: string,
): boolean {
  const resolved = resolvePresetFilters(presetFilters, currentUserId);
  const filterKeys: (keyof BoardFilters)[] = [
    'status',
    'risk_level',
    'validation_track',
    'priority',
    'owner_user_id',
    'project_id',
  ];
  return filterKeys.every((k) => (resolved[k] ?? '') === (activeFilters[k] ?? ''));
}
