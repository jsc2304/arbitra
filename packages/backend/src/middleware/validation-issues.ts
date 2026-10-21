import type { ZodIssue } from 'zod';

export interface StructuredValidationIssue {
  code: string;
  message: string;
  path: string[];
}

export function formatValidationIssues(
  issues: readonly ZodIssue[],
): StructuredValidationIssue[] {
  return issues.map((issue) => ({
    code: issue.code,
    message: issue.message,
    path: issue.path.map(String),
  }));
}
