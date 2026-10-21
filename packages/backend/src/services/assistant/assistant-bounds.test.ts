import { describe, it, expect, afterEach } from 'vitest';
import {
  applyInjectedContextBounds,
  resolveAssistantBounds,
} from './assistant-bounds.js';

/**
 * The two new bounds #832 slice A adds — `maxInjectedContextEntries`
 * (default five) and `maxInjectedContextChars` (default eight thousand) —
 * and the pure function that applies both to a fetched candidate list.
 */

const ENV_ENTRIES = 'ARBITRA_ASSISTANT_MAX_INJECTED_CONTEXT_ENTRIES';
const ENV_CHARS = 'ARBITRA_ASSISTANT_MAX_INJECTED_CONTEXT_CHARS';

afterEach(() => {
  delete process.env[ENV_ENTRIES];
  delete process.env[ENV_CHARS];
});

describe('resolveAssistantBounds — injected-context bounds', () => {
  it('defaults to five entries and eight thousand characters', () => {
    const bounds = resolveAssistantBounds();
    expect(bounds.maxInjectedContextEntries).toBe(5);
    expect(bounds.maxInjectedContextChars).toBe(8_000);
  });

  it('honours env overrides for both bounds', () => {
    // Reverted line: dropping the `ARBITRA_ASSISTANT_MAX_INJECTED_CONTEXT_ENTRIES`
    // readPositiveInt call in `resolveAssistantBounds` makes this fail — the
    // resolved value falls back to the default of five instead of two.
    process.env[ENV_ENTRIES] = '2';
    process.env[ENV_CHARS] = '40';
    const bounds = resolveAssistantBounds();
    expect(bounds.maxInjectedContextEntries).toBe(2);
    expect(bounds.maxInjectedContextChars).toBe(40);
  });

  it('falls back to the default on a non-positive or malformed override, same as every other bound', () => {
    process.env[ENV_ENTRIES] = '0';
    process.env[ENV_CHARS] = 'not-a-number';
    const bounds = resolveAssistantBounds();
    expect(bounds.maxInjectedContextEntries).toBe(5);
    expect(bounds.maxInjectedContextChars).toBe(8_000);
  });
});

describe('applyInjectedContextBounds', () => {
  const entry = (id: string, title: string, body: string) => ({
    knowledge_id: id,
    title,
    body,
  });

  it('keeps every entry when neither bound is reached', () => {
    const entries = [entry('ka_1', 'A', 'short'), entry('ka_2', 'B', 'also short')];
    const kept = applyInjectedContextBounds(entries, {
      maxInjectedContextEntries: 5,
      maxInjectedContextChars: 8_000,
    });
    expect(kept).toEqual(entries);
  });

  it('drops entries beyond the count cap, deterministically by input order', () => {
    // Reverted line: removing the `kept.length >= bounds.maxInjectedContextEntries`
    // break in `applyInjectedContextBounds` makes this fail — all three entries
    // would be kept instead of the first two.
    const entries = [
      entry('ka_1', 'First', 'x'),
      entry('ka_2', 'Second', 'x'),
      entry('ka_3', 'Third', 'x'),
    ];
    const kept = applyInjectedContextBounds(entries, {
      maxInjectedContextEntries: 2,
      maxInjectedContextChars: 8_000,
    });
    expect(kept.map((e) => e.knowledge_id)).toEqual(['ka_1', 'ka_2']);
  });

  it('drops entries beyond the char cap, stopping at the first entry that would overflow it', () => {
    // Reverted line: removing the `chars + entryChars > bounds.maxInjectedContextChars`
    // check makes this fail — the third entry would be kept even though the
    // running total already exceeds the cap after the second.
    const entries = [
      entry('ka_1', 'AAAAA', 'x'.repeat(10)), // title+body = 15 chars
      entry('ka_2', 'BBBBB', 'x'.repeat(10)), // + 15 = 30
      entry('ka_3', 'CCCCC', 'x'.repeat(10)), // would bring it to 45
    ];
    const kept = applyInjectedContextBounds(entries, {
      maxInjectedContextEntries: 5,
      maxInjectedContextChars: 30,
    });
    expect(kept.map((e) => e.knowledge_id)).toEqual(['ka_1', 'ka_2']);
  });

  it('never lets a later, smaller entry jump ahead of an earlier, excluded one', () => {
    const entries = [
      entry('ka_big', 'Big', 'x'.repeat(100)), // exceeds the cap alone
      entry('ka_small', 'Small', 'y'), // would easily fit
    ];
    const kept = applyInjectedContextBounds(entries, {
      maxInjectedContextEntries: 5,
      maxInjectedContextChars: 50,
    });
    expect(kept).toEqual([]);
  });
});
