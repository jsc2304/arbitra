import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import useSWR from 'swr';
import type { Case } from '@arbitra/shared';
import {
  AssistantThreadPanel,
  assistantThreadSwrKey,
} from '../assistant-thread-panel';

const auth = { user: { uid: 'usr_requester' } as { uid: string } | null };
vi.mock('swr', () => ({ default: vi.fn() }));
vi.mock('../../../providers/auth-provider', () => ({ useAuth: () => auth }));
vi.mock('../../../lib/api-client', () => ({ api: { assistant: { getThread: vi.fn() } } }));

const mockedUseSWR = useSWR as unknown as ReturnType<typeof vi.fn>;

function assistantCase(): Case {
  return {
    case_id: 'case_child',
    title: 'Which one is urgent?',
    description: 'Which one is urgent?',
    source_type: 'manual',
    source_ref: '',
    project_id: 'proj_clerk',
    repository_id: 'repo_clerk',
    owner_user_id: 'usr_requester',
    status: 'in_build',
    validation_track: 'direct',
    risk_level: 'low',
    priority: 'normal',
    case_type: 'assistant_task',
    assistant_context: {
      channel: 'web',
      conversation_visibility: 'direct',
      requester_user_id: 'usr_requester',
      risk_level: 'low',
      policy_version: 'v1',
      prompt_version: 'v1',
    },
    active_rule_set_refs: [],
    knowledge_context_refs: [],
    decision_ready: false,
    created_at: '2026-08-05T08:00:00.000Z',
    updated_at: '2026-08-05T08:00:00.000Z',
    deleted_at: null,
    deleted_by: null,
  };
}

beforeEach(() => {
  auth.user = { uid: 'usr_requester' };
  mockedUseSWR.mockReturnValue({
    data: {
      root_case_id: 'case_root',
      turns: [
        {
          case_id: 'case_root',
          title: 'What changed?',
          request: 'What changed?',
          answer_preview: 'Three cases changed.',
          status: 'done',
          created_at: '2026-08-05T07:00:00.000Z',
          updated_at: '2026-08-05T07:01:00.000Z',
          depth: 0,
        },
        {
          case_id: 'case_child',
          title: 'Which one is urgent?',
          request: 'Which one is urgent?',
          status: 'in_build',
          created_at: '2026-08-05T08:00:00.000Z',
          updated_at: '2026-08-05T08:00:00.000Z',
          depth: 1,
          parent_case_id: 'case_root',
        },
      ],
    },
    error: undefined,
    mutate: vi.fn(),
  });
});

describe('AssistantThreadPanel', () => {
  it('keys private thread data by case and signed-in user', () => {
    expect(assistantThreadSwrKey('case_1', 'usr_1')).toEqual([
      'assistant-thread',
      'case_1',
      'usr_1',
    ]);
    expect(assistantThreadSwrKey('case_1', undefined)).toBeNull();
  });

  it('renders the chronological request/result turns and links the preceding Case', () => {
    const html = renderToStaticMarkup(<AssistantThreadPanel caseData={assistantCase()} />);

    expect(html).toContain('2 turns');
    expect(html.indexOf('What changed?')).toBeLessThan(html.indexOf('Which one is urgent?'));
    expect(html).toContain('Three cases changed.');
    expect(html).toContain('/cases/case_root');
    expect(html).toContain('Current');
  });

  it('does not fetch or render for an admin or other non-requester', () => {
    auth.user = { uid: 'usr_admin' };
    const html = renderToStaticMarkup(<AssistantThreadPanel caseData={assistantCase()} />);

    expect(html).toBe('');
    expect(mockedUseSWR).toHaveBeenLastCalledWith(null, expect.any(Function), expect.any(Object));
  });
});
