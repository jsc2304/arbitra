/**
 * Provider options for every `generateObject` call. OpenAI's strict structured
 * outputs (the AI SDK 6 default) reject schemas with optional properties,
 * which the review, rule and report schemas use; non-strict JSON schema mode
 * accepts them and the zod schema still validates the result. Other providers
 * ignore the `openai` key.
 */
export const STRUCTURED_OUTPUT_PROVIDER_OPTIONS = { openai: { strictJsonSchema: false } };
