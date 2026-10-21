export function csvToArray(value: string | undefined): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  const items = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  return items;
}

export function pickDefined(
  source: Record<string, unknown>,
  fields: readonly string[]
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const field of fields) {
    if (source[field] !== undefined) {
      result[field] = source[field];
    }
  }

  return result;
}
