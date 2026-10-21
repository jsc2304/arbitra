import { ARBITRA_BUILD, ARBITRA_STAGE_LABEL } from '@arbitra/shared';

/**
 * App-wide footer. Surfaces the release label and CalVer build. The build
 * links to /api/version (raw JSON).
 */
export function AppFooter() {
  return (
    <footer className="border-t border-gray-200 dark:border-border-subtle py-3 px-4 text-center">
      <p className="text-xs text-gray-400 dark:text-gray-500">
        <span className="font-medium text-gray-500 dark:text-gray-400">{ARBITRA_STAGE_LABEL}</span>
        {' · '}
        <a
          href="/api/version"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-gray-600 dark:hover:text-gray-300 underline-offset-2 hover:underline"
        >
          {ARBITRA_BUILD}
        </a>
      </p>
    </footer>
  );
}
