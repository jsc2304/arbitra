'use client';

import { useEffect, useState } from 'react';
import { Badge } from '../shared/badge';
import {
  detectEnvironment,
  ENVIRONMENT_BADGE,
  type AppEnvironment,
} from '../../lib/app-environment';

/**
 * Environment badge rendered beside the Arbitra wordmark in the sidebar so
 * users instantly see which environment they are in (the point is noticing
 * you're NOT on prod).
 *
 * Detection (`lib/app-environment.ts`): localhost gives LOCAL, otherwise the
 * build-time `NEXT_PUBLIC_ARBITRA_ENV` (`prod` or `dev`) decides.
 * SSR safety: the hostname only exists in the browser, so we gate on mount —
 * server render and first client render both emit nothing, then the badge
 * appears after hydration. No hydration mismatch by construction.
 *
 * Without a configured label, non-local hosts render nothing (better no badge than a wrong one).
 */
export function EnvironmentBadge() {
  const [env, setEnv] = useState<AppEnvironment | null>(null);

  useEffect(() => {
    setEnv(detectEnvironment(window.location.hostname));
  }, []);

  if (!env) return null;

  const { label, colorClassName } = ENVIRONMENT_BADGE[env];

  return (
    <Badge
      size="xs"
      tone="soft"
      colorClassName={colorClassName}
      className="uppercase tracking-wide shrink-0"
      aria-label={`Environment: ${label}`}
    >
      {label}
    </Badge>
  );
}
