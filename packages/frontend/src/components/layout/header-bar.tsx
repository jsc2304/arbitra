'use client';

import { useState, useEffect, useCallback, type ReactNode } from 'react';
import Image from 'next/image';
import { usePathname, useSearchParams } from 'next/navigation';
import { useTheme } from '../../providers/theme-provider';
import { useAuth } from '../../providers/auth-provider';
import { useLauncher } from '../../providers/launcher-provider';
import NotificationCenter from '../shared/notification-center';
import { ReviewQueueBadge } from '../shared/review-queue-badge';
import { CommandPalette } from '../shared/command-palette';
import { KeyboardShortcutsDialog } from '../shared/keyboard-shortcuts-dialog';
import { Tooltip } from '../shared/tooltip';

const NAV_ITEMS: Array<{ href: string; label: string; icon?: boolean }> = [
  // Mission Control is the landing page (#989) — first in the primary nav.
  { href: '/mission-control', label: 'Mission Control' },
  { href: '/activity', label: 'Activity' },
  { href: '/board', label: 'Cases' },
  { href: '/projects', label: 'Projects' },
  { href: '/clerk', label: 'Clerk' },
  { href: '/knowledge', label: 'Knowledge' },
];

const SECONDARY_NAV_ITEMS: Array<{ href: string; label: string; icon: ReactNode }> = [
  // Old landing page, kept reachable now that Mission Control is the
  // default (#989).
  {
    href: '/dashboard',
    label: 'Dashboard',
    icon: (
      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="m2.25 12 8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25" />
      </svg>
    ),
  },
  {
    href: '/docs',
    label: 'Docs',
    icon: (
      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
      </svg>
    ),
  },
  {
    href: '/observatory',
    label: 'Observatory',
    icon: (
      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 0 1 3 19.875v-6.75ZM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V8.625ZM16.5 4.125C16.5 3.504 17.004 3 17.625 3h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V4.125Z" />
      </svg>
    ),
  },
  {
    href: '/settings',
    label: 'Settings',
    icon: (
      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
      </svg>
    ),
  },
];

export default function HeaderBar() {
  const { theme, toggle } = useTheme();
  const { user, customAvatarUrl, signOut } = useAuth();
  const effectiveAvatarUrl = customAvatarUrl ?? user?.photoURL ?? null;
  const launcher = useLauncher();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [searchOpen, setSearchOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  function isActive(href: string): boolean {
    // Mission Control is the landing page (#989) — root path lights it up.
    if (href === '/mission-control') return pathname === '/mission-control' || pathname === '/';
    if (href === '/board') return pathname === '/board' || pathname.startsWith('/board/') || pathname.startsWith('/cases/');
    if (href === '/projects') return pathname === '/projects' || pathname.startsWith('/projects/');
    return pathname === href || pathname.startsWith(href + '/');
  }

  // Register the search opener so the launcher Search tile can trigger it
  const openSearchFn = useCallback(() => setSearchOpen(true), []);
  useEffect(() => {
    launcher.registerOpenSearch(openSearchFn);
  }, [launcher, openSearchFn]);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Global Cmd+K / Ctrl+K shortcut + "?" to open keyboard-shortcut overlay.
  // The "?" handler intentionally ignores keystrokes that originate inside a
  // text input, textarea, or contentEditable element so typing a literal "?"
  // into a form still works.
  useEffect(() => {
    function isEditableTarget(target: EventTarget | null): boolean {
      if (!(target instanceof HTMLElement)) return false;
      const tag = target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
      if (target.isContentEditable) return true;
      return false;
    }
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setSearchOpen((prev) => !prev);
        return;
      }
      // `?` requires Shift on most layouts; skip if any other modifier is
      // held (avoids hijacking browser Ctrl+Shift+/ or similar).
      if (e.key === '?' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (isEditableTarget(e.target)) return;
        e.preventDefault();
        setShortcutsOpen((prev) => !prev);
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  return (
    <div className="sticky top-0 z-50">
      <header className="bg-surface-raised border-b border-gray-200 dark:border-border-subtle px-4 md:px-6 py-3 flex items-center justify-between md:justify-end h-16">
        {/* Mobile Logo */}
        <button
          type="button"
          onClick={launcher.open}
          className="md:hidden flex items-center gap-2 rounded-md hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent transition-opacity"
        >
          <Image src="/arbitra-icon.png" alt="" className="h-8 w-auto" width={512} height={386} />
          <span className="text-xl font-extrabold text-corp-dark dark:text-white translate-y-0.5">Arbitra</span>
        </button>

        <div className="flex items-center gap-3 md:gap-4">
          {/* Search button */}
          <Tooltip label="Search (⌘K)">
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            aria-label="Search (⌘K)"
            className="flex items-center gap-2 rounded-lg border border-gray-200 dark:border-border-subtle bg-surface-base dark:bg-surface-base px-3 py-1.5 text-sm text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 hover:border-gray-300 dark:hover:border-gray-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent transition-colors"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
            </svg>
            <span className="hidden sm:inline">Search</span>
            <kbd className="hidden sm:inline-flex items-center rounded border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 px-1 py-0.5 text-[10px] leading-none font-mono text-gray-400">
              {'\u2318'}K
            </kbd>
          </button>
          </Tooltip>

          {/* Desktop-only: review queue + notifications */}
          <div className="hidden md:flex items-center gap-3">
            {user && <ReviewQueueBadge />}
            {user && <NotificationCenter />}
          </div>

          {/* Dark mode toggle */}
          <Tooltip label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}>
          <button
            type="button"
            onClick={toggle}
            aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            className="inline-flex items-center justify-center min-h-[44px] min-w-[44px] rounded-md p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-surface-base dark:hover:bg-border-subtle focus:outline-none focus-visible:ring-2 focus-visible:ring-accent transition-colors"
          >
            {theme === 'dark' ? (
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v2.25m6.364.386-1.591 1.591M21 12h-2.25m-.386 6.364-1.591-1.591M12 18.75V21m-4.773-4.227-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0Z" />
              </svg>
            ) : (
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M21.752 15.002A9.72 9.72 0 0 1 18 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 0 0 3 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 0 0 9.002-5.998Z" />
              </svg>
            )}
          </button>
          </Tooltip>

          {/* User menu */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setUserMenuOpen(!userMenuOpen)}
              aria-haspopup="menu"
              aria-expanded={userMenuOpen}
              className="flex items-center gap-2 rounded-full hover:ring-2 hover:ring-accent/20 dark:hover:ring-accent/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 transition-all"
              title={user?.email ?? 'Settings'}
            >
              {effectiveAvatarUrl ? (
                <Image src={effectiveAvatarUrl} alt="" className="h-7 w-7 rounded-full" width={28} height={28} unoptimized />
              ) : (
                <div className="h-7 w-7 rounded-full bg-corp-blue/10 dark:bg-corp-blue/20 flex items-center justify-center text-xs font-semibold text-corp-blue">
                  {(user?.displayName ?? user?.email ?? '?')[0]?.toUpperCase()}
                </div>
              )}
            </button>

            {userMenuOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setUserMenuOpen(false)} />
                <div className="absolute right-0 z-50 mt-2 w-56 rounded-lg bg-surface-raised shadow-lg ring-1 ring-black/5 dark:ring-gray-700 py-1">
                  {user && (
                    <div className="px-4 py-2 border-b border-gray-100 dark:border-border-subtle">
                      <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{user.displayName}</p>
                      <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{user.email}</p>
                    </div>
                  )}
                  <a
                    href="/settings?tab=setup"
                    className="block px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-surface-base dark:hover:bg-gray-700"
                    onClick={() => setUserMenuOpen(false)}
                  >
                    IDE Setup
                  </a>
                  {user && (
                    <div className="border-t border-gray-100 dark:border-border-subtle">
                      <button
                        onClick={() => { signOut(); setUserMenuOpen(false); }}
                        className="block w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-surface-base dark:hover:bg-gray-700"
                      >
                        Sign out
                      </button>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

          {/* Mobile hamburger button */}
          <button
            type="button"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            className="md:hidden inline-flex items-center justify-center min-h-[44px] min-w-[44px] rounded-md p-1.5 text-gray-500 dark:text-gray-400 hover:bg-surface-base dark:hover:bg-border-subtle focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            aria-label="Toggle navigation"
            aria-haspopup="menu"
            aria-expanded={mobileMenuOpen}
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              {mobileMenuOpen ? (
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
              )}
            </svg>
          </button>
        </div>
      </header>

      {/* Mobile navigation dropdown */}
      {mobileMenuOpen && (
        <>
          <div className="fixed inset-0 z-40 md:hidden" onClick={() => setMobileMenuOpen(false)} />
          <div className="absolute left-0 right-0 z-50 md:hidden border-b border-gray-200 dark:border-border-subtle bg-surface-raised shadow-lg">
            <nav className="flex flex-col px-6 py-3 gap-1">
              {NAV_ITEMS.map((item) => {
                const active = isActive(item.href);
                return (
                <a
                  key={item.href}
                  href={item.href}
                  onClick={() => setMobileMenuOpen(false)}
                  className={`flex items-center gap-2 py-2 text-sm transition-colors ${
                    active
                      ? 'text-corp-orange dark:text-corp-orange font-semibold'
                      : 'text-gray-600 dark:text-gray-300 hover:text-corp-orange dark:hover:text-corp-orange'
                  }`}
                >
                  {item.icon && (
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={active ? 2 : 1.5} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="m2.25 12 8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25" />
                    </svg>
                  )}
                  {item.label}
                </a>
                );
              })}
              <div className="my-2 border-t border-gray-200 dark:border-border-subtle" aria-hidden="true" />
              {SECONDARY_NAV_ITEMS.map((item) => {
                const active = isActive(item.href);
                return (
                  <a
                    key={item.href}
                    href={item.href}
                    onClick={() => setMobileMenuOpen(false)}
                    className={`flex items-center gap-2 py-2 text-sm transition-colors ${
                      active
                        ? 'text-corp-orange dark:text-corp-orange font-semibold'
                        : 'text-gray-600 dark:text-gray-300 hover:text-corp-orange dark:hover:text-corp-orange'
                    }`}
                  >
                    {item.icon}
                    {item.label}
                  </a>
                );
              })}
            </nav>
          </div>
        </>
      )}

      <CommandPalette open={searchOpen} onClose={() => setSearchOpen(false)} />
      <KeyboardShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
    </div>
  );
}
