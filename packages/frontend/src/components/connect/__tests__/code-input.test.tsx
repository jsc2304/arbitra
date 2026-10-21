/**
 * @file `<CodeInput>` — normalization helper + rendered structure tests.
 *
 * The frontend test setup is intentionally node-only (`renderToStaticMarkup`)
 * — no jsdom, no `fireEvent`. Behaviour that requires real DOM events
 * (typing → state update → submit) is covered indirectly by exhaustively
 * testing the pure `normalizeUserCode` + `USER_CODE_REGEX` contract that the
 * component depends on.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CodeInput, normalizeUserCode, USER_CODE_REGEX } from '../code-input';

describe('normalizeUserCode', () => {
  it('passes through a clean 8-letter code with a hyphen', () => {
    expect(normalizeUserCode('WDJB-MJHT')).toBe('WDJB-MJHT');
  });

  it('uppercases lowercase input', () => {
    expect(normalizeUserCode('wdjb-mjht')).toBe('WDJB-MJHT');
  });

  it('auto-hyphens 8 contiguous letters', () => {
    expect(normalizeUserCode('WDJBMJHT')).toBe('WDJB-MJHT');
  });

  it('strips disallowed characters before re-normalizing', () => {
    // 'A', 'E', 'I', 'O', 'U' are vowels and disallowed; '0'/'1' are confusable digits.
    expect(normalizeUserCode('WAEDJBMOJHTU')).toBe('WDJB-MJHT');
    expect(normalizeUserCode('WD1JB-MJ0HT')).toBe('WDJB-MJHT');
  });

  it('handles paste-with-existing-hyphen (collapses then re-inserts)', () => {
    expect(normalizeUserCode('W-D-J-B-M-J-H-T')).toBe('WDJB-MJHT');
  });

  it('handles paste-with-spaces', () => {
    expect(normalizeUserCode('WDJB MJHT')).toBe('WDJB-MJHT');
    expect(normalizeUserCode('  WDJB  MJHT  ')).toBe('WDJB-MJHT');
  });

  it('truncates to 8 valid letters max (no overflow past XXXX-XXXX)', () => {
    expect(normalizeUserCode('WDJBMJHTQQQQQ')).toBe('WDJB-MJHT');
  });

  it('returns partial output without a hyphen below 5 letters', () => {
    expect(normalizeUserCode('')).toBe('');
    expect(normalizeUserCode('W')).toBe('W');
    expect(normalizeUserCode('WDJB')).toBe('WDJB');
  });

  it('inserts the hyphen as soon as the 5th valid letter is typed', () => {
    expect(normalizeUserCode('WDJBM')).toBe('WDJB-M');
  });

  it('drops a trailing typed-hyphen on its own', () => {
    expect(normalizeUserCode('WDJB-')).toBe('WDJB');
  });
});

describe('USER_CODE_REGEX', () => {
  it('matches a valid code', () => {
    expect(USER_CODE_REGEX.test('WDJB-MJHT')).toBe(true);
  });

  it('rejects a vowel-containing code', () => {
    expect(USER_CODE_REGEX.test('AAAA-MJHT')).toBe(false);
  });

  it('rejects a partial code', () => {
    expect(USER_CODE_REGEX.test('WDJB-MJH')).toBe(false);
  });

  it('rejects a code missing the hyphen', () => {
    expect(USER_CODE_REGEX.test('WDJBMJHT')).toBe(false);
  });

  it('rejects a lowercase code', () => {
    expect(USER_CODE_REGEX.test('wdjb-mjht')).toBe(false);
  });
});

describe('<CodeInput> render', () => {
  it('renders an input with maxLength enforcing XXXX-XXXX (9 chars)', () => {
    const html = renderToStaticMarkup(<CodeInput onSubmit={() => {}} />);
    expect(html).toContain('maxLength="9"');
    expect(html).toContain('placeholder="XXXX-XXXX"');
  });

  it('shows the helper text about letters-only', () => {
    const html = renderToStaticMarkup(<CodeInput onSubmit={() => {}} />);
    expect(html).toContain('no vowels');
  });

  it('renders error message when provided', () => {
    const html = renderToStaticMarkup(<CodeInput onSubmit={() => {}} errorMessage="Code expired" />);
    expect(html).toContain('Code expired');
    expect(html).toContain('role="alert"');
  });

  it('disables the submit button initially (no value)', () => {
    const html = renderToStaticMarkup(<CodeInput onSubmit={() => {}} />);
    // The button has both `disabled` and styling that mirrors disabled state.
    expect(html).toContain('disabled=""');
  });

  it('pre-fills via defaultValue and enables submit when valid', () => {
    const html = renderToStaticMarkup(
      <CodeInput onSubmit={() => {}} defaultValue="WDJB-MJHT" />,
    );
    expect(html).toContain('value="WDJB-MJHT"');
    // Valid value → submit button rendered without `disabled=""`.
    expect(html).not.toContain('disabled=""');
  });
});
