import type { KnowledgeStatus } from '@arbitra/shared';

export const statusColors: Record<KnowledgeStatus, string> = {
  suggested: 'bg-corp-yellow/20 dark:bg-corp-yellow/20 text-corp-dark dark:text-corp-yellow-bright',
  verified: 'bg-corp-blue/10 dark:bg-corp-blue/20 text-corp-dark dark:text-corp-blue',
  canonical: 'bg-corp-green/10 dark:bg-corp-green/20 text-corp-dark dark:text-corp-green',
  deprecated: 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400',
  superseded: 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400',
};

export const typeColors: Record<string, string> = {
  precedent: 'bg-secondary-50 dark:bg-secondary-950/50 text-secondary-700 dark:text-secondary-400',
  pattern: 'bg-corp-green/10 dark:bg-corp-green/20 text-corp-dark dark:text-corp-green',
  anti_pattern: 'bg-corp-red/10 dark:bg-corp-red/20 text-corp-dark dark:text-corp-red',
  mock_template: 'bg-corp-teal/10 dark:bg-corp-teal/20 text-corp-dark dark:text-corp-teal-bright',
  implementation_note: 'bg-corp-blue/10 dark:bg-corp-blue/20 text-corp-dark dark:text-corp-blue',
  review_guideline: 'bg-secondary-100 dark:bg-secondary-950/50 text-secondary-700 dark:text-secondary-300',
  architecture_decision: 'bg-corp-yellow/20 dark:bg-corp-yellow/20 text-corp-dark dark:text-corp-yellow-bright',
  exception_policy: 'bg-corp-orange/10 dark:bg-corp-orange/20 text-corp-dark dark:text-corp-orange',
};
