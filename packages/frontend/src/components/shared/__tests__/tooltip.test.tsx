/**
 * @file Tooltip primitive — structural smoke tests + pure-logic unit tests.
 *
 * Locks the public surface:
 *   - returns the trigger element wrapped by an `inline-flex` span
 *   - renders nothing extra when `label` is empty/undefined
 *   - does NOT inject `aria-describedby` (the trigger's
 *     existing aria-label remains the single SR source — no double announce)
 *
 * The hover/focus open-delay behaviour is timer- and DOM-event-driven and would
 * require fake timers + a jsdom layout engine; this frontend suite is
 * deliberately node-only (no jsdom, no `@testing-library`, no `fireEvent`), so
 * full interaction testing is intentionally deferred to the spec's manual QA
 * checklist. Instead, the open/close/dismiss *decision* logic is extracted into
 * pure exported helpers and unit-tested directly here — mirroring the
 * established `canConfirmDelete` idiom — so the branch behaviour
 * (touch-suppress, focus-visible-only open, Escape dismiss, empty-label
 * no-op) is locked without a DOM.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  DEFAULT_CLOSE_DELAY,
  DEFAULT_OPEN_DELAY,
  isDismissKey,
  isLabelEmpty,
  isTouchPointer,
  shouldOpenOnFocus,
  shouldOpenOnPointerEnter,
  Tooltip,
} from '../tooltip';

describe('Tooltip', () => {
  it('renders the trigger inside an inline-flex wrapper span', () => {
    const html = renderToStaticMarkup(
      <Tooltip label="Lifecycle view">
        <button type="button" aria-label="Lifecycle view">x</button>
      </Tooltip>,
    );
    expect(html).toContain('<span class="inline-flex"');
    expect(html).toContain('<button');
    expect(html).toContain('aria-label="Lifecycle view"');
  });

  it('renders the trigger as-is when label is empty (tooltip is a no-op)', () => {
    const html = renderToStaticMarkup(
      <Tooltip label="">
        <button type="button" aria-label="x">x</button>
      </Tooltip>,
    );
    // Empty label: returns the child untouched, so no <span class="inline-flex"> wrapper.
    expect(html).not.toContain('<span class="inline-flex"');
    expect(html).toContain('<button');
  });

  it('does not add aria-describedby (avoids SR double-announce of aria-label)', () => {
    const html = renderToStaticMarkup(
      <Tooltip label="Notifications">
        <button type="button" aria-label="Notifications">x</button>
      </Tooltip>,
    );
    expect(html).not.toContain('aria-describedby');
  });

  it('the bubble is portal-only — initial SSR markup contains no role="tooltip"', () => {
    // The bubble is rendered via createPortal only after a hover/focus opens
    // it; SSR + closed state must not emit it. This guards against a future
    // refactor that would inline the bubble into the trigger and clip it.
    const html = renderToStaticMarkup(
      <Tooltip label="Notifications">
        <button type="button" aria-label="Notifications">x</button>
      </Tooltip>,
    );
    expect(html).not.toContain('role="tooltip"');
  });
});

describe('Tooltip open/close decision helpers (pure, node-only)', () => {
  it('exposes stable default delays (300 ms open / 100 ms close)', () => {
    expect(DEFAULT_OPEN_DELAY).toBe(300);
    expect(DEFAULT_CLOSE_DELAY).toBe(100);
  });

  describe('isTouchPointer', () => {
    it('is true only for the touch pointer type', () => {
      expect(isTouchPointer('touch')).toBe(true);
    });

    it('is false for mouse / pen / missing pointer type', () => {
      expect(isTouchPointer('mouse')).toBe(false);
      expect(isTouchPointer('pen')).toBe(false);
      expect(isTouchPointer('')).toBe(false);
      expect(isTouchPointer(undefined)).toBe(false);
    });
  });

  describe('shouldOpenOnPointerEnter', () => {
    it('opens for non-touch pointers (mouse/pen)', () => {
      expect(shouldOpenOnPointerEnter('mouse')).toBe(true);
      expect(shouldOpenOnPointerEnter('pen')).toBe(true);
    });

    it('does NOT open for touch taps (no sticky bubble)', () => {
      expect(shouldOpenOnPointerEnter('touch')).toBe(false);
    });
  });

  describe('shouldOpenOnFocus', () => {
    it('opens only when focus is keyboard-originated (:focus-visible)', () => {
      expect(shouldOpenOnFocus(true)).toBe(true);
    });

    it('does NOT open on focus that follows a mouse/touch click', () => {
      expect(shouldOpenOnFocus(false)).toBe(false);
    });
  });

  describe('isDismissKey', () => {
    it('treats Escape as the dismiss key', () => {
      expect(isDismissKey('Escape')).toBe(true);
    });

    it('ignores every other key', () => {
      expect(isDismissKey('Enter')).toBe(false);
      expect(isDismissKey('Tab')).toBe(false);
      expect(isDismissKey('escape')).toBe(false); // case-sensitive — matches KeyboardEvent.key
      expect(isDismissKey(' ')).toBe(false);
    });
  });

  describe('isLabelEmpty', () => {
    it('treats null / undefined / empty / whitespace-only labels as empty (tooltip disabled)', () => {
      expect(isLabelEmpty(null)).toBe(true);
      expect(isLabelEmpty(undefined)).toBe(true);
      expect(isLabelEmpty('')).toBe(true);
      expect(isLabelEmpty('   ')).toBe(true);
    });

    it('treats any non-blank string or rendered node as a real label', () => {
      expect(isLabelEmpty('Lifecycle view')).toBe(false);
      expect(isLabelEmpty(0)).toBe(false);
      expect(isLabelEmpty(<span>x</span>)).toBe(false);
    });
  });
});
