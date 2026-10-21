import { defineConfig } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';

// eslint-config-next 16 pulls in eslint-plugin-react-hooks v7, whose
// `recommended` set adds the React Compiler rules. The Next 14 config only
// enabled rules-of-hooks + exhaustive-deps; keep that rule set unchanged.
const reactCompilerRules = [
  'static-components',
  'use-memo',
  'preserve-manual-memoization',
  'incompatible-library',
  'immutability',
  'globals',
  'refs',
  'set-state-in-effect',
  'error-boundaries',
  'purity',
  'set-state-in-render',
  'unsupported-syntax',
  'config',
  'gating',
];

export default defineConfig([
  ...nextVitals,
  { rules: Object.fromEntries(reactCompilerRules.map((r) => [`react-hooks/${r}`, 'off'])) },
]);
