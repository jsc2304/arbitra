import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentPresence, Run } from '@arbitra/shared';
import { AgentPresencePill } from '../agent-presence-indicator';

function makePresence(overrides: Partial<AgentPresence> = {}): AgentPresence {
  return {
    presence_id: 'case_1__usr_1',
    case_id: 'case_1',
    actor_user_id: 'usr_1',
    actor_display: 'Agent One',
    source: 'ide_agent',
    first_seen_at: '2026-04-27T10:00:00.000Z',
    last_seen_at: '2026-04-27T10:00:30.000Z',
    ...overrides,
  };
}

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    run_id: 'run_1',
    case_id: 'case_1',
    run_type: 'review_run',
    trigger_source: 'system:pipeline',
    status: 'running',
    input_refs: [],
    output_refs: [],
    created_at: '2026-04-27T10:00:00.000Z',
    updated_at: '2026-04-27T10:00:00.000Z',
    ...overrides,
  };
}

describe('AgentPresencePill', () => {
  it('renders active run count and first run type', () => {
    const html = renderToStaticMarkup(
      <AgentPresencePill
        activeRunsByCase={{
          case_1: [makeRun()],
          case_2: [makeRun({ run_id: 'run_2', case_id: 'case_2', run_type: 'build_run' })],
        }}
      />,
    );

    expect(html).toContain('2 active runs');
    expect(html).toContain('2 cases');
    expect(html).toContain('AI Review');
    expect(html).toContain('href="/activity"');
  });

  it('renders an idle state without active runs', () => {
    const html = renderToStaticMarkup(<AgentPresencePill activeRunsByCase={{}} />);

    expect(html).toContain('Agents idle');
    expect(html).toContain('No processing right now');
  });

  it('lights up on presence rows alone when no runs are active', () => {
    const html = renderToStaticMarkup(
      <AgentPresencePill
        activeRunsByCase={{}}
        presenceByCase={{
          case_1: [makePresence()],
          case_2: [makePresence({ presence_id: 'case_2__usr_1', case_id: 'case_2' })],
        }}
      />,
    );

    expect(html).toContain('2 agents active');
    expect(html).toContain('2 cases');
    expect(html).toContain('IDE agent');
    expect(html).not.toContain('Agents idle');
  });

  it('collapses to an accessible activity light', () => {
    const html = renderToStaticMarkup(
      <AgentPresencePill
        collapsed
        activeRunsByCase={{ case_1: [makeRun()] }}
      />,
    );

    expect(html).toContain('aria-label="1 active run across 1 case"');
    expect(html).not.toContain('AI Review');
  });
});
