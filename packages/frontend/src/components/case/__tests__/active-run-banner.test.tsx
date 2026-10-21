import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Run } from '@arbitra/shared';
import { ActiveRunBanner } from '../active-run-banner';

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    run_id: 'run_1',
    case_id: 'case_1',
    run_type: 'review_run',
    trigger_source: 'system:pipeline',
    status: 'running',
    started_at: '2026-04-27T10:00:00.000Z',
    input_refs: [],
    output_refs: [],
    summary: 'Reviewing pull request diff',
    created_at: '2026-04-27T10:00:00.000Z',
    updated_at: '2026-04-27T10:00:00.000Z',
    ...overrides,
  };
}

describe('ActiveRunBanner', () => {
  it('renders the active run and links to the Runs tab', () => {
    const html = renderToStaticMarkup(
      <ActiveRunBanner
        caseId="case_1"
        runs={[makeRun()]}
        now={new Date('2026-04-27T10:01:05.000Z')}
      />,
    );

    expect(html).toContain('AI Review running');
    expect(html).toContain('Active for 1m 5s');
    expect(html).toContain('Reviewing pull request diff');
    expect(html).toContain('href="/cases/case_1?tab=runs"');
  });

  it('renders nothing when no run is active', () => {
    const html = renderToStaticMarkup(
      <ActiveRunBanner
        caseId="case_1"
        runs={[makeRun({ status: 'completed', finished_at: '2026-04-27T10:00:30.000Z' })]}
      />,
    );

    expect(html).toBe('');
  });

  it('summarizes additional active runs', () => {
    const html = renderToStaticMarkup(
      <ActiveRunBanner
        caseId="case_1"
        runs={[
          makeRun(),
          makeRun({ run_id: 'run_2', status: 'pending', run_type: 'rule_run' }),
        ]}
        now={new Date('2026-04-27T10:00:10.000Z')}
      />,
    );

    expect(html).toContain('AI Review running +1 more');
  });
});
