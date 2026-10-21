'use client';

import { useState, useEffect } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useTheme } from '../../providers/theme-provider';
import Card from '../../components/shared/card';
import SectionHeader from '../../components/shared/section-header';
import { TokensPanel } from '../../components/settings/tokens-panel';
import { ChatNotificationsPanel } from '../../components/settings/chat-notifications-panel';
import { AiModelsPanel } from '../../components/settings/ai-models-panel';
import { PromptsPanel } from '../../components/settings/prompts-panel';
import { SetupPanel } from '../../components/settings/setup-panel';
import { UsersPanel } from '../../components/settings/users-panel';
import { ProfilePanel } from '../../components/settings/profile-panel';
import { type BoardViewMode, BOARD_VIEW_STORAGE_KEY } from '../../lib/board-preferences';

type SettingsTab = 'profile' | 'setup' | 'general' | 'users' | 'tokens' | 'ai-models' | 'prompts';

const VALID_TABS: SettingsTab[] = ['profile', 'setup', 'general', 'users', 'tokens', 'ai-models', 'prompts'];

type TabGroup = { label: string; tabs: { key: SettingsTab; label: string }[] };

const TAB_GROUPS: TabGroup[] = [
  {
    label: 'Workspace',
    tabs: [
      { key: 'profile', label: 'Profile' },
      { key: 'general', label: 'General' },
      { key: 'users', label: 'Users' },
      { key: 'tokens', label: 'Connections' },
      { key: 'setup', label: 'IDE Agent' },
    ],
  },
  {
    label: 'AI',
    tabs: [
      { key: 'ai-models', label: 'AI Models' },
      { key: 'prompts', label: 'Prompts' },
    ],
  },
];

function useBoardDefault(): [BoardViewMode, (v: BoardViewMode) => void] {
  const [value, setValue] = useState<BoardViewMode>('list');
  useEffect(() => {
    const stored = localStorage.getItem(BOARD_VIEW_STORAGE_KEY);
    if (stored === 'board' || stored === 'list' || stored === 'lifecycle') setValue(stored);
  }, []);
  const set = (v: BoardViewMode) => {
    setValue(v);
    localStorage.setItem(BOARD_VIEW_STORAGE_KEY, v);
  };
  return [value, set];
}

export default function SettingsPage() {
  const { preference, setPreference } = useTheme();
  const searchParams = useSearchParams();
  const router = useRouter();
  const tabParam = searchParams.get('tab');

  // Redirect ?tab=projects to the dedicated /projects page
  useEffect(() => {
    if (tabParam === 'projects') {
      router.replace('/projects');
    }
  }, [tabParam, router]);

  const initialTab = tabParam && VALID_TABS.includes(tabParam as SettingsTab) ? (tabParam as SettingsTab) : 'general';
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);
  const [boardDefault, setBoardDefault] = useBoardDefault();

  return (
    <div className="max-w-7xl mx-auto px-4 md:px-6 py-8">
      <h1 className="text-2xl font-extrabold text-gray-900 dark:text-gray-100 mb-1">Settings</h1>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
        Configure your Arbitra experience and manage projects.
      </p>

      {/* Tabs with group dividers. Tabs use `pb-3` for the underline track;
          the group-label divider mirrors the same bottom padding so "AI"
          aligns with the tab text baseline rather than floating above it. */}
      <div className="border-b border-gray-200 dark:border-border-subtle mb-6">
        <nav className="flex items-end gap-6">
          {TAB_GROUPS.map((group, groupIdx) => (
            <div key={group.label} className="flex items-end gap-6">
              {groupIdx > 0 && (
                <div className="flex items-center gap-2 -ml-1 pb-3">
                  <div className="h-4 w-px bg-gray-200 dark:bg-gray-700" aria-hidden="true" />
                  <span className="text-[10px] font-medium uppercase tracking-wider text-gray-400 dark:text-gray-500 select-none leading-none">
                    {group.label}
                  </span>
                </div>
              )}
              {group.tabs.map((tab) => (
                <button
                  key={tab.key}
                  onClick={() => setActiveTab(tab.key)}
                  className={`pb-3 text-sm font-medium border-b-2 transition-colors ${
                    activeTab === tab.key
                      ? 'border-accent text-accent-700 dark:text-accent-300'
                      : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:border-gray-300 dark:hover:border-gray-600'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          ))}
        </nav>
      </div>

      {/* Tab Content */}
      {activeTab === 'general' && (
        <div className="max-w-3xl">
          {/* Appearance */}
          <section className="mb-8">
            <SectionHeader eyebrow title="Appearance" className="mb-3" />
            <Card padding="none" className="divide-y divide-gray-100 dark:divide-gray-800">
              <div className="px-4 py-4 flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100">Theme</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Choose between light and dark mode, or follow your system preference.</p>
                </div>
                <select
                  value={preference}
                  onChange={(e) => setPreference(e.target.value as 'light' | 'dark' | 'system')}
                  className="rounded-md border border-gray-300 dark:border-gray-600 bg-surface-raised px-3 py-1.5 text-sm text-gray-700 dark:text-gray-200"
                >
                  <option value="light">Light</option>
                  <option value="dark">Dark</option>
                  <option value="system">System</option>
                </select>
              </div>
              {/* Language selector — hidden until v1.1 */}
            </Card>
          </section>

          {/* Notification preferences — hidden until v1.1 */}

          {/* Default Board Preferences */}
          <section className="mb-8">
            <SectionHeader eyebrow title="Board Defaults" className="mb-3" />
            <Card padding="none" className="divide-y divide-gray-100 dark:divide-gray-800">
              <div className="px-4 py-4 flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100">Default View</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Choose your preferred default view when opening the case board.</p>
                </div>
                <select
                  value={boardDefault}
                  onChange={(e) => setBoardDefault(e.target.value as BoardViewMode)}
                  className="rounded-md border border-gray-300 dark:border-gray-600 bg-surface-raised px-3 py-1.5 text-sm text-gray-700 dark:text-gray-200"
                >
                  <option value="list">List View</option>
                  <option value="board">Board View</option>
                  <option value="lifecycle">Lifecycle View</option>
                </select>
              </div>
            </Card>
          </section>

          {/* Roadmap placeholder — honest "coming soon" copy with the
              upcoming items itemised, so the empty area on the General tab
              signals intent rather than abandonment. */}
          <section className="mb-8">
            <SectionHeader eyebrow title="Coming soon" className="mb-3" />
            <Card padding="none" className="divide-y divide-gray-100 dark:divide-gray-800">
              {[
                { label: 'Language', description: 'UI language selection (English, German)' },
                { label: 'Notification preferences', description: 'Email and in-app delivery per event type' },
                { label: 'Workspace branding', description: 'Logo and accent color overrides' },
              ].map((item) => (
                <div
                  key={item.label}
                  className="px-4 py-3 flex items-center justify-between opacity-60"
                >
                  <div>
                    <p className="text-sm font-medium text-gray-700 dark:text-gray-300">{item.label}</p>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{item.description}</p>
                  </div>
                  <span className="text-[10px] font-medium uppercase tracking-wider text-gray-400 dark:text-gray-500 border border-gray-200 dark:border-gray-700 rounded px-1.5 py-0.5">
                    v1.1
                  </span>
                </div>
              ))}
            </Card>
          </section>
        </div>
      )}

      {activeTab === 'profile' && <ProfilePanel />}
      {activeTab === 'setup' && <SetupPanel />}
      {activeTab === 'users' && <UsersPanel />}
      {activeTab === 'tokens' && (
        <>
          <TokensPanel />
          <ChatNotificationsPanel />
        </>
      )}
      {activeTab === 'ai-models' && <AiModelsPanel />}
      {activeTab === 'prompts' && <PromptsPanel />}
    </div>
  );
}
