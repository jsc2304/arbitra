'use client';

/**
 * `<CodeInput>` — 8-char user-code entry box for the `/connect` page.
 *
 * Behaviour (`docs/specs/device-flow-and-per-tool-tokens.md` §F.1):
 *   - Restricts input to the unambiguous RFC 8628 §6.1 alphabet
 *     (`BCDFGHJKLMNPQRSTVWXZ` — no vowels, no confusable digits).
 *   - Uppercases as the user types.
 *   - Auto-inserts a hyphen between the two 4-character groups.
 *   - Accepts pastes that already contain a hyphen (or spaces) and re-normalizes.
 *   - Submits via Enter or the explicit button; calls `onSubmit` once the
 *     value matches the strict `XXXX-XXXX` format.
 *
 * Pure presentational — the parent (`<ConnectFlow>`) handles routing.
 */
import { useState, type FormEvent, type ChangeEvent } from 'react';

/** RFC 8628 §6.1 unambiguous alphabet — keep in sync with `_helpers.ts`. */
export const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
const ALLOWED = new Set(USER_CODE_ALPHABET.split(''));

/** Strict regex used to gate the submit button. */
export const USER_CODE_REGEX = /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/;

/**
 * Normalize a raw user input into the canonical `XXXX-XXXX` form.
 *
 * Strips everything that isn't in the unambiguous alphabet, uppercases,
 * truncates to 8 letters, and inserts a hyphen between positions 4 and 5.
 * Exported so the test file can lock its semantics directly.
 */
export function normalizeUserCode(input: string): string {
  const upper = input.toUpperCase();
  let letters = '';
  for (const ch of upper) {
    if (ALLOWED.has(ch)) letters += ch;
    if (letters.length >= 8) break;
  }
  if (letters.length <= 4) return letters;
  return `${letters.slice(0, 4)}-${letters.slice(4)}`;
}

interface CodeInputProps {
  onSubmit: (code: string) => void;
  /** Initial value, used on mount only (eg. pre-fill from a stale URL). */
  defaultValue?: string;
  /** Show this string under the input — invalid-code or rate-limit message. */
  errorMessage?: string;
}

export function CodeInput({ onSubmit, defaultValue = '', errorMessage }: CodeInputProps) {
  const [value, setValue] = useState(() => normalizeUserCode(defaultValue));

  const isValid = USER_CODE_REGEX.test(value);

  function handleChange(e: ChangeEvent<HTMLInputElement>) {
    setValue(normalizeUserCode(e.target.value));
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!isValid) return;
    onSubmit(value);
  }

  return (
    <form onSubmit={handleSubmit} className="w-full max-w-sm" data-testid="code-input-form">
      <label htmlFor="connect-code-input" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
        Enter the code from your tool
      </label>
      <input
        id="connect-code-input"
        type="text"
        inputMode="text"
        autoComplete="one-time-code"
        spellCheck={false}
        autoCapitalize="characters"
        autoCorrect="off"
        value={value}
        onChange={handleChange}
        placeholder="XXXX-XXXX"
        // 9 = 4 + 1 hyphen + 4
        maxLength={9}
        className="w-full rounded-lg border border-gray-300 dark:border-border-default bg-input-bg px-4 py-3 text-center text-2xl font-mono tracking-[0.3em] uppercase text-gray-900 dark:text-gray-100 focus:border-accent focus:ring-1 focus:ring-accent"
        aria-invalid={!isValid && value.length > 0}
        data-testid="code-input"
      />
      {errorMessage && (
        <p className="mt-2 text-xs text-red-600 dark:text-red-400" role="alert">{errorMessage}</p>
      )}
      <button
        type="submit"
        disabled={!isValid}
        className="mt-4 w-full rounded-md bg-accent-700 px-4 py-2 text-sm font-medium text-white hover:bg-accent-800 disabled:bg-gray-300 disabled:text-gray-500 dark:disabled:bg-gray-800 transition-colors"
        data-testid="code-input-submit"
      >
        Continue
      </button>
      <p className="mt-3 text-xs text-gray-500 dark:text-gray-400 text-center">
        Codes use letters only — no vowels, no digits.
      </p>
    </form>
  );
}
