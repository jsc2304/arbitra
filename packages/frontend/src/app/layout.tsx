import { Suspense } from 'react';
import type { Metadata, Viewport } from 'next';
import { Mulish } from 'next/font/google';
import './globals.css';

const mulish = Mulish({
  subsets: ['latin'],
  variable: '--font-mulish',
  display: 'swap',
});
import { AuthProvider } from '../providers/auth-provider';
import { NotificationProvider } from '../providers/notification-provider';
import { ToastProvider } from '../providers/toast-provider';
import { ThemeProvider } from '../providers/theme-provider';
import { LauncherProvider } from '../providers/launcher-provider';
import { AuthGate } from '../components/auth/auth-gate';
import HeaderBar from '../components/layout/header-bar';
import { Sidebar } from '../components/layout/sidebar';
import { AppFooter } from '../components/layout/app-footer';
import { LauncherMount } from '../components/launcher/launcher-mount';
import { AssistantLauncher } from '../components/assistant/assistant-launcher';
import { ToastContainer } from '../components/shared/toast-container';

export const metadata: Metadata = {
  title: 'Arbitra | The Agent Management System',
  description: 'AI-native Engineering Control Plane',
  manifest: '/manifest.json',
};

// Without an explicit viewport export Next.js still ships a default
// `width=device-width, initial-scale=1` meta tag, but iOS Safari does not
// reliably honor that default on every OS version — an explicit export is
// what's actually documented to work. `maximumScale`/`userScalable` are
// deliberately left unset: locking either would disable the user's manual
// pinch-zoom, which must keep working (this fix only removes the unwanted
// auto-zoom-on-focus, not zoom itself).
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={mulish.variable} suppressHydrationWarning>
      <head>
        <link rel="icon" href="/favicon.ico" sizes="32x32" />
        <link rel="apple-touch-icon" href="/icon-192.png" />
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                try {
                  var theme = localStorage.getItem('arbitra-theme');
                  var isDark = theme === 'dark' || (theme !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
                  if (isDark) document.documentElement.classList.add('dark');
                } catch(e) {}
              })();
            `,
          }}
        />
      </head>
      <body className="bg-surface-base text-gray-900 dark:text-gray-100 antialiased">
        <AuthProvider>
          <NotificationProvider>
            <ToastProvider>
              <ThemeProvider>
                <LauncherProvider>
                  <a
                    href="#main"
                    className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-md focus:bg-surface-raised focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-gray-900 focus:shadow-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent dark:focus:text-gray-100"
                  >
                    Skip to main content
                  </a>
                  <div className="min-h-screen flex">
                    <Sidebar />
                    <div className="flex-1 flex flex-col min-w-0">
                      <Suspense>
                        <HeaderBar />
                      </Suspense>
                      <main id="main" className="flex-1">
                        <AuthGate>{children}</AuthGate>
                      </main>
                      <AppFooter />
                    </div>
                    <LauncherMount />
                  </div>
                  <AssistantLauncher />
                  <ToastContainer />
                </LauncherProvider>
              </ThemeProvider>
            </ToastProvider>
          </NotificationProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
