// Phase 2.6 (learn UI): the progress-persistence seam.
//
// The course context depends ONLY on the ProgressStore interface, never on where
// progress actually lives. Today that's localStorage (anonymous learners). In
// Phase 3, once Supabase auth + the Progress table land, the swap is intentionally
// small and self-contained:
//
//   1. Implement `DbProgressStore` (below interface) — `load()` reads the user's
//      Progress rows for this track; `setComplete()` upserts/deletes one row. Both
//      are already async, so the context needs zero changes.
//   2. In `createProgressStore`, return the DB store when a session userId exists,
//      else the local store. That's the only branching point.
//   3. On first sign-in, call `migrateLocalToDb(trackId)` once to flush any
//      anonymous localStorage progress into the Progress table, then clear it. The
//      stub is here so the call site is obvious when auth arrives.
//
// Keeping the single-lesson `setComplete(lessonId, complete)` shape (rather than
// "save the whole set") is deliberate: it maps 1:1 onto a DB upsert/delete of one
// Progress row, so the DB implementation stays trivial.

export interface ProgressStore {
  /** Load the set of completed lessonIds for this track. */
  load(): Promise<Set<string>>;
  /** Mark a single lesson complete/incomplete and persist it. */
  setComplete(lessonId: string, complete: boolean): Promise<void>;
}

const storageKey = (trackId: string) => `learn:progress:${trackId}`;

// Anonymous, client-only persistence. Read/parse failures degrade to "no progress"
// rather than throwing — progress is non-critical and rebuilds from interaction.
class LocalProgressStore implements ProgressStore {
  constructor(private readonly trackId: string) {}

  async load(): Promise<Set<string>> {
    try {
      const raw = localStorage.getItem(storageKey(this.trackId));
      return raw ? new Set<string>(JSON.parse(raw) as string[]) : new Set<string>();
    } catch {
      return new Set<string>();
    }
  }

  async setComplete(lessonId: string, complete: boolean): Promise<void> {
    try {
      const current = await this.load();
      if (complete) current.add(lessonId);
      else current.delete(lessonId);
      localStorage.setItem(storageKey(this.trackId), JSON.stringify([...current]));
    } catch {
      // Best-effort; storage may be unavailable (private mode, quota).
    }
  }
}

// The single place that decides where progress lives. Phase 3: branch on session.
export function createProgressStore(trackId: string): ProgressStore {
  return new LocalProgressStore(trackId);
}

// Phase 3 hook (intentionally unimplemented): flush anonymous localStorage progress
// into the DB on first sign-in, then clear local so the DB becomes the source of
// truth. Wired at the auth callback when DbProgressStore exists.
export async function migrateLocalToDb(trackId: string): Promise<void> {
  void trackId; // no-op until Phase 3 auth + Progress table land
}
