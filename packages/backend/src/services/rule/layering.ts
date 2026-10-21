import type { Rule } from '@arbitra/shared';

/**
 * Resolves rule layering: project > global.
 * If a project rule has the same category and name as a global rule, the project rule wins.
 */
export function resolveRuleLayers(rules: Rule[]): Rule[] {
  const globalRules = rules.filter((r) => r.scope.layer === 'global');
  const projectRules = rules.filter((r) => r.scope.layer === 'project');

  // Build a set of "override keys" from project rules
  const projectKeys = new Set(
    projectRules.map((r) => `${r.category}::${r.name}`),
  );

  // Global rules that aren't overridden by project rules
  const effectiveGlobal = globalRules.filter(
    (r) => !projectKeys.has(`${r.category}::${r.name}`),
  );

  return [...projectRules, ...effectiveGlobal];
}
