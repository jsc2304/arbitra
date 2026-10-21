/**
 * @file helper-bot-thinking — render-shape tests.
 *
 * Node-only (no jsdom in this package), so we assert the static markup
 * shape: the right testid, accessibility wiring, and the reused
 * `animate-pulse-glow` utility (from `tailwind.config.ts`, keyframe in
 * `globals.css`). Guards against accidentally swapping the indicator
 * back to a generic spinner or regressing to the old verbose stage
 * banner.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { HelperBotThinking } from '../helper-bot-thinking';

describe('<HelperBotThinking />', () => {
  it('renders a compact three-dot pulsing indicator', () => {
    const html = renderToStaticMarkup(<HelperBotThinking />);
    expect(html).toContain('data-testid="helper-bot-thinking"');
    // Three dots, all using the reused pulse-glow utility.
    const dotMatches = html.match(/animate-pulse-glow/g) ?? [];
    expect(dotMatches.length).toBe(3);
    // Staggered delays — typing-indicator rhythm.
    expect(html).toContain('animation-delay:0s');
    expect(html).toContain('animation-delay:0.2s');
    expect(html).toContain('animation-delay:0.4s');
  });

  it('keeps the Arbitra orange accent so the bot still feels of-brand', () => {
    const html = renderToStaticMarkup(<HelperBotThinking />);
    expect(html).toContain('bg-corp-orange');
  });

  it('exposes an accessible polite live-region label for screen readers', () => {
    const html = renderToStaticMarkup(<HelperBotThinking />);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-label="Arbitra Helper is thinking"');
    // Legacy testid retained on the sr-only marker for back-compat.
    expect(html).toContain('data-testid="helper-bot-loading"');
  });

  it('passes through className for caller-controlled positioning', () => {
    const html = renderToStaticMarkup(
      <HelperBotThinking className="my-custom-pos" />,
    );
    expect(html).toContain('my-custom-pos');
  });
});
