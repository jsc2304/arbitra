/**
 * @file new-events-pill — visibility + label.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NewEventsPill } from '../new-events-pill';

describe('<NewEventsPill>', () => {
  it('renders nothing when count is 0', () => {
    expect(
      renderToStaticMarkup(<NewEventsPill count={0} onClick={() => {}} />),
    ).toBe('');
  });

  it('renders nothing for negative counts (defensive)', () => {
    expect(
      renderToStaticMarkup(<NewEventsPill count={-1} onClick={() => {}} />),
    ).toBe('');
  });

  it('uses singular copy for count=1', () => {
    const html = renderToStaticMarkup(
      <NewEventsPill count={1} onClick={() => {}} />,
    );
    expect(html).toContain('1 new event');
    expect(html).not.toContain('1 new events');
  });

  it('uses plural copy for count > 1', () => {
    const html = renderToStaticMarkup(
      <NewEventsPill count={4} onClick={() => {}} />,
    );
    expect(html).toContain('4 new events');
  });
});
