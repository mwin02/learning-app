'use client';

// Phase 3e: poll-by-refresh while a build is in flight. Server components render
// live status (force-dynamic); this just re-requests them on an interval so the
// user watches a `planning/building` Program become `ready` without manual
// reloads. Renders nothing; mount it only when something is actually building.

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export function AutoRefresh({ intervalMs = 5000 }: { intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(id);
  }, [router, intervalMs]);
  return null;
}
