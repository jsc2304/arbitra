import type { ActorMetadata } from '@arbitra/shared';
import { actorDisplayName } from '../../lib/actor-display';

/**
 * Small muted chip rendered next to an author name when the action was taken
 * by an IDE agent and client/model metadata was captured authoritatively on
 * the API call. Renders nothing when no metadata is present, so existing rows
 * are unaffected.
 *
 * Renders the canonical client display name from `actorDisplayName` (e.g.
 * `Code Intelligence`, `Claude Code`) rather than the raw `client_name` +
 * version. Version and model are surfaced as a `title` tooltip so users can
 * still inspect them without the chip cluttering the row.
 */
export function ActorSignature({ meta }: { meta?: ActorMetadata }) {
  if (!meta || (!meta.client_name && !meta.model)) return null;

  // Derive the canonical display label from the shared helper so feed rows,
  // case-timeline actor badges, comment headers, and evidence detail stay
  // consistent. When only `model` is present (no client_name), fall back to
  // showing the model name so we still surface something meaningful.
  const display = actorDisplayName(undefined, meta);
  const label = meta.client_name ? display.label : meta.model!;

  // Tooltip carries the raw signature: `client_name version · model`. Keeping
  // the model visible somewhere is important for agent leaderboards/audit.
  const tooltipParts: string[] = [];
  if (display.secondary) tooltipParts.push(display.secondary);
  if (meta.model) tooltipParts.push(meta.model);
  const tooltip = tooltipParts.join(' · ');

  return (
    <span
      className="text-xs text-gray-500 dark:text-gray-400"
      {...(tooltip ? { title: tooltip } : {})}
    >
      {label}
    </span>
  );
}
