import { describe, it, expect } from 'vitest';
import { extractFirestoreCreateIndexUrl } from '../utils/firestore-index-url.js';

describe('extractFirestoreCreateIndexUrl', () => {
  const url =
    'https://console.firebase.google.com/project/demo-arbitra/firestore/indexes?create_composite=Ck9wcm9qZWN0cy9kZW1vLWFyYml0cmEvZGF0YWJhc2VzLw';

  it('extracts the URL from a realistic FAILED_PRECONDITION message', () => {
    const message = `9 FAILED_PRECONDITION: The query requires an index. You can create it here: ${url}`;
    expect(extractFirestoreCreateIndexUrl(message)).toBe(url);
  });

  it('extracts a URL at the very end of the string (no trailing char)', () => {
    expect(extractFirestoreCreateIndexUrl(`error: ${url}`)).toBe(url);
  });

  it('stops at a whitespace boundary', () => {
    expect(extractFirestoreCreateIndexUrl(`${url} and then more text`)).toBe(url);
  });

  it('stops at a newline boundary', () => {
    expect(extractFirestoreCreateIndexUrl(`line one\n${url}\nline three`)).toBe(url);
  });

  it('stops before a closing parenthesis', () => {
    expect(extractFirestoreCreateIndexUrl(`(see ${url})`)).toBe(url);
  });

  it('stops before a wrapping backtick', () => {
    expect(extractFirestoreCreateIndexUrl(`run \`${url}\` to fix`)).toBe(url);
  });

  it('stops before a wrapping double quote', () => {
    expect(extractFirestoreCreateIndexUrl(`{"url": "${url}"}`)).toBe(url);
  });

  it('stops before a wrapping single quote', () => {
    expect(extractFirestoreCreateIndexUrl(`link: '${url}'`)).toBe(url);
  });

  it('returns the first URL when multiple create-index URLs are present', () => {
    const secondUrl =
      'https://console.firebase.google.com/project/other-proj/firestore/indexes?create_composite=DIFFERENT_TOKEN';
    const message = `first: ${url} second: ${secondUrl}`;
    expect(extractFirestoreCreateIndexUrl(message)).toBe(url);
  });

  it('returns null when there is no URL at all', () => {
    expect(extractFirestoreCreateIndexUrl('permission denied')).toBeNull();
  });

  it('returns null for a console.firebase.google.com URL without create_composite=', () => {
    const plainUrl = 'https://console.firebase.google.com/project/demo-arbitra/firestore/data';
    expect(extractFirestoreCreateIndexUrl(`see ${plainUrl}`)).toBeNull();
  });

  it('returns null for a non-console URL that happens to contain create_composite=', () => {
    const impostor = 'https://example.com/firestore/indexes?create_composite=xyz';
    expect(extractFirestoreCreateIndexUrl(`see ${impostor}`)).toBeNull();
  });

  it('returns null for empty, null, or undefined input', () => {
    expect(extractFirestoreCreateIndexUrl('')).toBeNull();
    expect(extractFirestoreCreateIndexUrl(null)).toBeNull();
    expect(extractFirestoreCreateIndexUrl(undefined)).toBeNull();
  });
});
