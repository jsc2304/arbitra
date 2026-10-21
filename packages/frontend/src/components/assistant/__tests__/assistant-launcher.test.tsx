/**
 * @file One global assistant launcher and its explicit Clerk/Helper choice.
 *
 * The frontend test environment is node-only, so click transitions are not exercised here.
 * These render tests pin the production pieces the
 * launcher connects: one authenticated trigger, two explicit choices, and a
 * Clerk drawer that embeds the task surface rather than a chat transcript.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('../../../providers/auth-provider', () => ({
  useAuth: () => ({ user: { uid: 'uid_requester' } }),
}));

vi.mock('../../clerk/clerk-ask-panel', () => ({
  ClerkAskPanel: () => <div data-testid="clerk-task-surface">Clerk task surface</div>,
}));

vi.mock('../../helper-bot/helper-bot-drawer', () => ({
  HelperBotDrawer: ({ open }: { open: boolean }) =>
    open ? <div data-testid="helper-surface">Helper surface</div> : null,
}));

import {
  AssistantChoicePanel,
  AssistantLauncher,
  ClerkTaskDrawer,
} from '../assistant-launcher';

describe('AssistantLauncher', () => {
  it('renders one authenticated assistant trigger, not a Helper-only trigger', () => {
    const html = renderToStaticMarkup(<AssistantLauncher />);

    expect(html.match(/data-testid="assistant-launcher"/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Open Arbitra assistants"');
    expect(html).not.toContain('data-testid="helper-bot-launcher"');
  });
});

describe('AssistantChoicePanel', () => {
  it('makes Clerk and Helper explicit choices with their different ceremony', () => {
    const html = renderToStaticMarkup(
      <AssistantChoicePanel onChooseClerk={() => {}} onChooseHelper={() => {}} />,
    );

    expect(html).toContain('data-testid="assistant-choice-clerk"');
    expect(html).toContain('Start Clerk task');
    expect(html).toContain('recorded in a case');
    expect(html).toContain('data-testid="assistant-choice-helper"');
    expect(html).toContain('Ask Helper');
    expect(html).toContain('No case is created');
  });
});

describe('ClerkTaskDrawer', () => {
  it('contains the existing task intake and recent-task surface, not a chat UI', () => {
    const html = renderToStaticMarkup(<ClerkTaskDrawer open onClose={() => {}} />);

    expect(html).toContain('data-testid="clerk-task-surface"');
    expect(html).not.toContain('data-testid="helper-surface"');
  });
});
