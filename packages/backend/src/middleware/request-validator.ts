import { ValidationError } from '@arbitra/shared';
import { formatValidationIssues } from './validation-issues.js';

export function validateBody<T>(
  schema: { safeParse: (data: unknown) => { success: true; data: T } | { success: false; error: { issues: Parameters<typeof formatValidationIssues>[0] } } },
  body: unknown,
): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError('Invalid request payload', {
      issues: formatValidationIssues(parsed.error.issues),
    });
  }
  return parsed.data;
}
