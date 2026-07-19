'use client';

// Shared client hook behind the inspector's edit buttons (2.5d-7). A thin wrapper
// over POST /api/playground/map-edit: it owns no map logic — it sends one action
// body, surfaces the API's error, and on success refreshes the server-rendered
// inspector so the mutated concept/resource (and any recomputed readiness) re-renders.
// Mirrors the decomposition-review ReviewActions pattern, factored into a hook so
// the concept-level and resource-level button rows don't duplicate the fetch.

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

export function useMapEdit() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Returns true on success (so a caller can close an inline editor only then).
  async function run(body: Record<string, unknown>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/playground/map-edit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data: { error?: string } = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? `HTTP ${res.status}`);
        return false;
      }
      startTransition(() => router.refresh());
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  return { run, busy, error, pending, setError };
}
