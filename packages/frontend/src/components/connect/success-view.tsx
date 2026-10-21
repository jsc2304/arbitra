'use client';

/**
 * `<SuccessView>` — post-confirm "you can close this tab" view.
 *
 * Spec: `docs/specs/device-flow-and-per-tool-tokens.md` §F.1 final state.
 *
 * The actual token is minted by the MCP client's next poll of
 * `/api/auth/connect/token` — by the time we render this view, the device-code
 * doc is `approved` and the polling loop in the IDE will pick it up within the
 * `interval` seconds the server returned at init time (default 5s).
 */
import Link from 'next/link';

interface SuccessViewProps {
  projectName: string;
}

export function SuccessView({ projectName }: SuccessViewProps) {
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-green-100 dark:bg-green-950">
        <svg className="h-8 w-8 text-green-600 dark:text-green-400" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" aria-hidden>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75 10.5 18.75 19.5 5.25" />
        </svg>
      </div>
      <h1 className="mt-6 text-2xl font-extrabold text-gray-900 dark:text-gray-100">Connected</h1>
      <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
        Your tool will continue automatically. You can close this tab.
      </p>
      <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
        Project: <strong className="text-gray-700 dark:text-gray-300">{projectName}</strong>
      </p>
      <Link
        href="/"
        className="mt-8 inline-flex items-center rounded-md bg-accent-700 px-4 py-2 text-sm font-medium text-white hover:bg-accent-800"
      >
        Open Arbitra dashboard
      </Link>
    </div>
  );
}
