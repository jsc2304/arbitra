'use client';

import { useEffect, useState } from 'react';
import { api } from '../lib/api-client';

type RepoInfo = { name: string; url: string };
type RepoMap = Record<string, RepoInfo>;

// Module-level cache shared across all hook instances
const cache: RepoMap = {};
let fetched = false;
let fetchPromise: Promise<void> | null = null;

export function useRepositoryMap(): RepoMap {
  const [map, setMap] = useState<RepoMap>({ ...cache });

  useEffect(() => {
    if (fetched) {
      setMap({ ...cache });
      return;
    }

    if (!fetchPromise) {
      fetchPromise = api.projects.list().then(async ({ projects }) => {
        const results = await Promise.all(
          projects.map(p => api.projects.repositories(p.project_id).catch(() => ({ repositories: [] })))
        );
        for (const { repositories } of results) {
          for (const r of repositories) {
            const info = { name: r.name, url: r.url };
            cache[r.repository_id] = info;
            // Also index by owner/repo slug (e.g. "org/repo") so cases with
            // slug-format repository_id also resolve to the friendly name
            if (r.url) {
              const slug = r.url.replace(/^https?:\/\/github\.com\//, '').replace(/\/$/, '');
              if (slug.includes('/')) cache[slug] = info;
            }
            // And by name for simple name-based lookups
            if (r.name) cache[r.name] = info;
          }
        }
        fetched = true;
      }).catch(() => {
        fetchPromise = null;
      });
    }

    let cancelled = false;
    fetchPromise.then(() => {
      if (!cancelled) setMap({ ...cache });
    });

    return () => { cancelled = true; };
  }, []);

  return map;
}
