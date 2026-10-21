'use client';

import { useEffect, useState } from 'react';
import { api } from '../lib/api-client';

type ProjectMap = Record<string, string>; // project_id → name

// Module-level cache shared across all hook instances
const cache: ProjectMap = {};
let fetched = false;
let fetchPromise: Promise<void> | null = null;

export function useProjectMap(): ProjectMap {
  const [map, setMap] = useState<ProjectMap>({ ...cache });

  useEffect(() => {
    if (fetched) {
      setMap({ ...cache });
      return;
    }

    if (!fetchPromise) {
      fetchPromise = api.projects.list().then(({ projects }) => {
        for (const p of projects) {
          cache[p.project_id] = p.name;
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
