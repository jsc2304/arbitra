import Link from 'next/link';

export interface BreadcrumbItem {
  label: string;
  href?: string;
}

interface BreadcrumbProps {
  items: BreadcrumbItem[];
  /**
   * When true, the final (leaf) segment renders as an `<h1>` styled
   * larger + bolder, so the breadcrumb doubles as the page's primary
   * heading and the card below can skip its own title. Default false
   * preserves the compact breadcrumb-only look for pages that already
   * render their own `<h1>`.
   */
  leafAsHeading?: boolean;
}

export function Breadcrumb({ items, leafAsHeading = false }: BreadcrumbProps) {
  if (items.length === 0) return null;

  const lastIndex = items.length - 1;

  return (
    <nav
      aria-label="Breadcrumb"
      className="flex flex-wrap items-baseline gap-x-1.5 gap-y-1 text-xs text-gray-500 dark:text-gray-400"
    >
      {items.map((item, index) => {
        const isLast = index === lastIndex;
        const renderAsHeading = leafAsHeading && isLast && !item.href;
        return (
          <span key={index} className="flex items-baseline gap-1.5 min-w-0">
            {index > 0 && (
              <span className="text-gray-300 dark:text-gray-600" aria-hidden="true">
                ›
              </span>
            )}
            {item.href ? (
              <Link
                href={item.href}
                className="hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
              >
                {item.label}
              </Link>
            ) : renderAsHeading ? (
              <h1 className="text-lg md:text-xl font-semibold text-gray-900 dark:text-gray-100 break-words">
                {item.label}
              </h1>
            ) : (
              <span className="text-gray-700 dark:text-gray-300">{item.label}</span>
            )}
          </span>
        );
      })}
    </nav>
  );
}
