import { z } from 'zod';

/**
 * Longest `prompt_text` a blueprint may store. Mirrors
 * `ARBITRA_ASSISTANT_MAX_INPUT_CHARS`'s documented default (8000,
 * `resolveAssistantIntakeLimits` in `assistant-intake-service.ts`) so a
 * blueprint cannot be saved with a prompt that its own run-now would then
 * reject at intake time under the default configuration. It is a static
 * ceiling, not a live mirror of that env var — an operator who raises the
 * runtime limit does not need to touch this schema, and `AssistantIntakeService`
 * re-enforces its OWN (possibly different) configured limit on every
 * occurrence regardless of what passed here at save time.
 */
export const MAX_TASK_BLUEPRINT_PROMPT_CHARS = 8000;

const CRON_FIELD_PATTERN = '[0-9A-Za-z*/,-]+';

/**
 * Syntactic-only 5-field cron shape (`minute hour day-of-month month
 * day-of-week`): exactly five whitespace-separated tokens drawn from cron's
 * usual character set (digits, `*`, `/`, `-`, `,`, and month/weekday name
 * abbreviations). This does NOT validate that a field's value is semantically
 * sane — e.g. `99` in the hour field, or `32` for day-of-month, both match.
 * Semantic validation (and next-run computation) arrives with `croner` in
 * slice B2 (#793); no cron evaluator exists anywhere in this codebase yet.
 * This regex exists only to keep obviously-malformed strings (wrong field
 * count, stray punctuation) out of Firestore before that lands.
 */
export const TASK_BLUEPRINT_CRON_SCHEDULE_PATTERN = new RegExp(
  `^${CRON_FIELD_PATTERN}(?:\\s+${CRON_FIELD_PATTERN}){4}$`,
);

let supportedTimeZones: ReadonlySet<string> | null = null;

/** Lazily computed and cached — `Intl.supportedValuesOf` re-allocates its array on every call. */
function getSupportedTimeZones(): ReadonlySet<string> {
  if (!supportedTimeZones) {
    supportedTimeZones = new Set(Intl.supportedValuesOf('timeZone'));
  }
  return supportedTimeZones;
}

/**
 * Whether `value` is a name the runtime's ICU data recognizes as an IANA
 * time zone.
 *
 * `'UTC'` is special-cased: Node's `Intl.supportedValuesOf('timeZone')`
 * excludes it from the canonical IANA zone list it returns (verified against
 * this runtime — `Intl.supportedValuesOf('timeZone').includes('UTC')` is
 * `false`), even though `Intl.DateTimeFormat(locale, { timeZone: 'UTC' })`
 * accepts it and resolves to it without error. Rejecting the single most
 * common scheduler timezone over an enumeration-API quirk would be a real
 * usability regression, not a meaningful safety check.
 */
export function isSupportedTimeZone(value: string): boolean {
  return value === 'UTC' || getSupportedTimeZones().has(value);
}

const cronScheduleSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(
    TASK_BLUEPRINT_CRON_SCHEDULE_PATTERN,
    'cron_schedule must be 5 whitespace-separated fields (minute hour day-of-month month day-of-week)',
  );

const timezoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine(isSupportedTimeZone, { message: 'timezone must be a recognized IANA time zone name' });

/**
 * Body accepted by `POST /api/assistant/blueprints`. `.strict()` so an
 * unexpected key (e.g. a caller-supplied `owner_user_id` or `version`) is
 * rejected rather than silently ignored — those are system-owned, resolved
 * from the session / the service, never the body.
 */
export const createTaskBlueprintSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).optional(),
    prompt_text: z.string().trim().min(1).max(MAX_TASK_BLUEPRINT_PROMPT_CHARS),
    cron_schedule: cronScheduleSchema,
    timezone: timezoneSchema,
    enabled: z.boolean().default(true),
  })
  .strict();

/**
 * Body accepted by `PATCH /api/assistant/blueprints/[blueprintId]`. Every
 * field optional (partial update), but at least one must be present — an
 * empty PATCH has nothing to bump `version` for, so it is rejected as a 400
 * rather than accepted as a silent no-op version bump.
 */
export const updateTaskBlueprintSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(2000).optional(),
    prompt_text: z.string().trim().min(1).max(MAX_TASK_BLUEPRINT_PROMPT_CHARS).optional(),
    cron_schedule: cronScheduleSchema.optional(),
    timezone: timezoneSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (Object.keys(data).length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'At least one field must be provided.',
      });
    }
  });

export type CreateTaskBlueprintPayload = z.infer<typeof createTaskBlueprintSchema>;
export type UpdateTaskBlueprintPayload = z.infer<typeof updateTaskBlueprintSchema>;
