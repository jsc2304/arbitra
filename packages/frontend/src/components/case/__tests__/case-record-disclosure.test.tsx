/**
 * @file case-record-disclosure — collapsed by default, unmounts its children
 * while collapsed.
 *
 * Node-only render (renderToStaticMarkup, no jsdom, no clicks available):
 * only the default (collapsed) state is assertable here. Expanding it is a
 * click and is left to manual verification.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CaseRecordDisclosure } from '../case-record-disclosure';

describe('CaseRecordDisclosure', () => {
  it('renders the toggle collapsed and does not mount its children', () => {
    const html = renderToStaticMarkup(
      <CaseRecordDisclosure>
        <div>governance content</div>
      </CaseRecordDisclosure>,
    );

    expect(html).toContain('Record');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('governance content');
  });
});
