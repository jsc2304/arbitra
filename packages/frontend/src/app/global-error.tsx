'use client';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html>
      <body className="flex flex-col items-center justify-center min-h-screen gap-4 bg-surface-base dark:bg-surface-base">
        <h2 className="text-xl font-semibold text-red-600 dark:text-red-400">Something went wrong</h2>
        <p className="text-gray-600 dark:text-gray-400">{error.message}</p>
        <button
          onClick={reset}
          className="px-4 py-2 bg-blue-600 dark:bg-blue-500 text-white rounded-lg hover:bg-blue-700 dark:hover:bg-blue-600"
        >
          Try again
        </button>
      </body>
    </html>
  );
}
