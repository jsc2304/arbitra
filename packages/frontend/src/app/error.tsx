'use client';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[50vh] gap-4">
      <h2 className="text-xl font-semibold text-red-600 dark:text-red-400">Something went wrong</h2>
      <p className="text-gray-600 dark:text-gray-400">{error.message}</p>
      <button
        onClick={reset}
        className="px-4 py-2 bg-accent-700 text-white rounded-lg hover:bg-accent-800"
      >
        Try again
      </button>
    </div>
  );
}
