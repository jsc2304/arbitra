/**
 * Branded 404 page.
 *
 * Vanilla Next.js 404 leaks unbranded chrome on any unknown route. This page matches the empty-state
 * tone used elsewhere in the app (centered, light text, semantic surface
 * tokens) and provides a clear CTA back to the board.
 */
import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-6 px-4 text-center">
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-gray-400 dark:text-gray-500">
        404
      </p>
      <h1 className="text-2xl font-extrabold text-gray-900 dark:text-gray-50">
        Page not found
      </h1>
      <p className="max-w-md text-sm text-gray-600 dark:text-gray-300">
        The page you were looking for does not exist or has moved. Head back to
        the board to pick up where you left off.
      </p>
      <div className="flex items-center gap-3">
        <Link
          href="/board"
          className="inline-flex items-center rounded-lg bg-accent-700 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-accent-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          Back to board
        </Link>
        <Link
          href="/"
          className="inline-flex items-center rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:border-gray-300 hover:text-gray-900 dark:border-border-subtle dark:text-gray-200 dark:hover:border-gray-600 dark:hover:text-gray-50"
        >
          Dashboard
        </Link>
      </div>
    </div>
  );
}
