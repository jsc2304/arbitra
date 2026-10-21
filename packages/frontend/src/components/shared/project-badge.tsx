/**
 * Small low-weight pill for surfacing a project label inside dense feeds
 * (activity stream, cluster rows). Outline variant on purpose: keeps visual
 * weight below severity / decision / track badges so it never competes with
 * the meaningful signal in the row.
 *
 * Two flavors:
 *   - `as="button"` — clickable, fires the `onClick` callback. Used when the
 *     consumer wires a project filter.
 *   - `as="link"`   — navigation to /projects/:id. Used when no filter
 *     callback is wired.
 *   - default span  — non-interactive (e.g. inside another <button>).
 *
 * Structure follows the shared <Badge> spec (#658): `rounded-full`, the `xs`
 * size scale (this killed the old `text-[10px]`), and the neutral `outline`
 * tone (ring, not `border`). The non-interactive span renders <Badge>
 * directly; the button/link forms can't (they need a real interactive
 * element + hover affordance), so they mirror the exact same structural
 * tokens via BADGE_STRUCTURE below — kept in lockstep with Badge's
 * xs+outline output.
 */
import Link from 'next/link';
import { Badge } from './badge';

interface ProjectBadgeBaseProps {
  label: string;
  className?: string;
}

interface ProjectBadgeButtonProps extends ProjectBadgeBaseProps {
  as: 'button';
  onClick: () => void;
  title?: string;
}

interface ProjectBadgeLinkProps extends ProjectBadgeBaseProps {
  as: 'link';
  href: string;
  title?: string;
}

interface ProjectBadgeSpanProps extends ProjectBadgeBaseProps {
  as?: 'span';
}

type ProjectBadgeProps =
  | ProjectBadgeButtonProps
  | ProjectBadgeLinkProps
  | ProjectBadgeSpanProps;

// Mirrors <Badge size="xs" tone="outline"> structure for the interactive
// (button/link) forms, plus the project-specific neutral colour + surface.
// xs = `px-2 py-0.5 text-xs` (replaces the old `text-[10px]`); outline =
// `ring-1 ring-inset ring-gray-200`.
const BADGE_STRUCTURE =
  'inline-flex items-center gap-1.5 rounded-full font-medium whitespace-nowrap px-2 py-0.5 text-xs ring-1 ring-inset';
const PROJECT_COLOR =
  'ring-gray-200 bg-surface-base text-gray-600 dark:ring-border-subtle dark:bg-surface-base/40 dark:text-gray-300';
const INTERACTIVE_BASE = `${BADGE_STRUCTURE} ${PROJECT_COLOR}`;

export function ProjectBadge(props: ProjectBadgeProps) {
  if (props.as === 'button') {
    return (
      <button
        type="button"
        onClick={(e) => {
          // Keep the badge usable even when a parent row-level handler is
          // listening: stop propagation so clicking the pill only fires the
          // project filter, not the row's expand/collapse.
          e.stopPropagation();
          props.onClick();
        }}
        className={`${INTERACTIVE_BASE} hover:ring-accent/40 hover:text-accent transition-colors cursor-pointer${props.className ? ` ${props.className}` : ''}`}
        title={props.title}
        data-testid="project-badge"
      >
        {props.label}
      </button>
    );
  }

  if (props.as === 'link') {
    return (
      <Link
        href={props.href}
        onClick={(e) => e.stopPropagation()}
        className={`${INTERACTIVE_BASE} hover:ring-accent/40 hover:text-accent transition-colors${props.className ? ` ${props.className}` : ''}`}
        title={props.title}
        data-testid="project-badge"
      >
        {props.label}
      </Link>
    );
  }

  return (
    <Badge
      size="xs"
      tone="outline"
      colorClassName={PROJECT_COLOR}
      className={props.className}
      data-testid="project-badge"
    >
      {props.label}
    </Badge>
  );
}
