/**
 * @file clerk-ask-panel — the recent-tasks list and whose cache it reads.
 *
 * The list carries one account's request titles and case ids, so its SWR key is
 * scoped by uid: sign-out neither reloads the app nor clears SWR's cache, and an
 * unscoped key would show A's private requests to B in the same tab until a
 * background revalidation replaced them.
 *
 * Node-only render (renderToStaticMarkup, no jsdom), with `swr` replaced by a fake
 * that dispatches on the FULL key — an unscoped key resolves to no data, so the
 * list renders empty and the scoping cannot be dropped with the test still green.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import useSWR from 'swr';
import { ClerkAskPanel, assistantTasksSwrKey } from '../clerk-ask-panel';

vi.mock('swr', () => ({ default: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

vi.mock('../../../lib/api-client', () => ({
  api: {
    assistant: {
      listTasks: vi.fn(),
      createTask: vi.fn(),
      provisionClerkCore: vi.fn(),
    },
  },
}));

vi.mock('../../../providers/auth-provider', () => ({
  useAuth: () => ({ user: { uid: 'uid_a' } }),
}));

const mockedUseSWR = useSWR as unknown as ReturnType<typeof vi.fn>;

const TASKS = {
  tasks: [
    {
      case_id: 'case_mild_coast',
      title: 'Which cases exist in the project Payments API?',
      status: 'done',
      created_at: '2026-08-01T10:00:00.000Z',
      updated_at: '2026-08-01T10:00:14.000Z',
    },
  ],
};

let keysAsked: unknown[];

beforeEach(() => {
  keysAsked = [];
  mockedUseSWR.mockImplementation((key: unknown) => {
    keysAsked.push(key);
    const scoped = Array.isArray(key)
      && key.length === 2
      && key[0] === 'assistant-tasks'
      && key[1] === 'uid_a';
    return { data: scoped ? TASKS : undefined, error: undefined, isLoading: false, mutate: vi.fn() };
  });
});

describe('ClerkAskPanel recent tasks', () => {
  it('reads the list under a key scoped to the signed-in user', () => {
    const html = renderToStaticMarkup(<ClerkAskPanel />);

    expect(keysAsked).toContainEqual(['assistant-tasks', 'uid_a']);
    // The scoped key is the one that resolves, so the titles really came from it.
    expect(html).toContain('Which cases exist in the project Payments API?');
    expect(html).toContain('/cases/case_mild_coast');
  });
});

describe('assistantTasksSwrKey', () => {
  it('scopes the list to the signed-in user and waits for one', () => {
    expect(assistantTasksSwrKey('uid_a')).toEqual(['assistant-tasks', 'uid_a']);
    expect(assistantTasksSwrKey(undefined)).toBeNull();
  });

  it('folds a limit into the key as a distinct 3-tuple, not the same key with a different fetch', () => {
    // #858: this panel and ClerkScheduledPanel both read GET /api/assistant/tasks,
    // at different limits. If the limit were only a fetcher argument (not part
    // of the SWR key), both panels would collide on the same 2-tuple cache
    // entry and whichever fetched second would overwrite the other's cached
    // list with a differently-sized one — cache bleed, not dedup, on every tab
    // switch. Reverting the `limit ? [...3] : [...2]` branch back to always
    // returning the 2-tuple makes this assertion fail.
    expect(assistantTasksSwrKey('uid_a', 50)).toEqual(['assistant-tasks', 'uid_a', 50]);
    expect(assistantTasksSwrKey('uid_a', 50)).not.toEqual(assistantTasksSwrKey('uid_a'));
  });
});

describe('ClerkAskPanel thread grouping', () => {
  it('collapses a follow-up under its root, with the follow-up title hidden until expanded', () => {
    mockedUseSWR.mockImplementation((key: unknown) => {
      const scoped = Array.isArray(key) && key[0] === 'assistant-tasks' && key[1] === 'uid_a';
      return {
        data: scoped
          ? {
              tasks: [
                {
                  case_id: 'case_root',
                  title: 'Which cases exist in the project Payments API?',
                  status: 'done',
                  created_at: '2026-08-01T09:00:00.000Z',
                  updated_at: '2026-08-01T09:00:14.000Z',
                },
                {
                  case_id: 'case_followup',
                  title: 'And which of those are still open?',
                  status: 'done',
                  created_at: '2026-08-01T10:00:00.000Z',
                  updated_at: '2026-08-01T10:00:20.000Z',
                  assistant_thread: { root_case_id: 'case_root' },
                },
              ],
            }
          : undefined,
        error: undefined,
        isLoading: false,
        mutate: vi.fn(),
      };
    });

    const html = renderToStaticMarkup(<ClerkAskPanel />);

    // Root renders as a normal row; the follow-up count is the affordance,
    // not the follow-up's own title.
    expect(html).toContain('Which cases exist in the project Payments API?');
    expect(html).toContain('1 follow-up');
    expect(html).toContain('aria-expanded="false"');
    // Collapsed by default — the follow-up's title is not in the markup at all.
    expect(html).not.toContain('And which of those are still open?');
    expect(html).not.toContain('/cases/case_followup');
  });

  it('renders a case without a thread link exactly as before grouping', () => {
    mockedUseSWR.mockImplementation((key: unknown) => {
      const scoped = Array.isArray(key) && key[0] === 'assistant-tasks' && key[1] === 'uid_a';
      return { data: scoped ? TASKS : undefined, error: undefined, isLoading: false, mutate: vi.fn() };
    });

    const html = renderToStaticMarkup(<ClerkAskPanel />);

    expect(html).toContain('Which cases exist in the project Payments API?');
    expect(html).toContain('/cases/case_mild_coast');
    expect(html).not.toContain('follow-up');
  });
});
