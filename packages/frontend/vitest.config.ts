import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  // Force the automatic JSX runtime so `.test.tsx` files don't need a
  // top-level `import React`. Matches the Next.js frontend build which uses
  // the automatic runtime via `"jsx": "preserve"` + the Next SWC transform.
  esbuild: {
    jsx: 'automatic',
  },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
