// Phase 2.6 (learn UI): the progress-persistence seam. Phase 3f: DB-backed.
//
// The course context depends ONLY on the ProgressStore interface, never on where
// progress actually lives. `createProgressStore` is the single branching point:
// signed-in viewers get `DbProgressStore` (the /api/progress/[trackId] route →
// Progress table), everyone else — anonymous pre-3d visitors and the DEV_AUTH
// dev bypass, whose sessions have no userId — keeps `LocalProgressStore`
// (localStorage). On the first signed-in load of a track, any leftover anonymous
// localStorage progress is flushed into the DB (`migrateLocalToDb`), then
// cleared, so the DB becomes the single source of truth.
//
// Keeping the single-lesson `setComplete(lessonId, complete)` shape (rather than
// "save the whole set") is deliberate: it maps 1:1 onto a DB upsert/delete of one
// Progress row. All failures degrade to "no progress" / lost write, never a
// throw — progress is non-critical and the UI already updated optimistically.

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

// Signed-in persistence via /api/progress/[trackId] (Phase 3f). Same
// degrade-to-empty error posture as the local store.
class DbProgressStore implements ProgressStore {
  constructor(private readonly trackId: string) {}

  async load(): Promise<Set<string>> {
    // Flush any anonymous local progress BEFORE reading, so a first signed-in
    // load already reflects it. Best-effort; failure keeps the local data.
    await migrateLocalToDb(this.trackId);
    try {
      const res = await fetch(`/api/progress/${this.trackId}`);
      if (!res.ok) return new Set<string>();
      const data = (await res.json()) as { lessonIds: string[] };
      return new Set<string>(data.lessonIds);
    } catch {
      return new Set<string>();
    }
  }

  async setComplete(lessonId: string, complete: boolean): Promise<void> {
    try {
      await fetch(`/api/progress/${this.trackId}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lessonId, complete }),
      });
    } catch {
      // Best-effort: the optimistic UI already updated; a lost write simply
      // resurfaces as un-checked on the next load.
    }
  }
}

// The single place that decides where progress lives. `signedIn` comes from the
// server (the learn layout knows the viewer); the dev bypass's userId-less
// admin viewer counts as NOT signed in — the API would 401 it anyway.
export function createProgressStore(trackId: string, signedIn = false): ProgressStore {
  return signedIn ? new DbProgressStore(trackId) : new LocalProgressStore(trackId);
}

// Flush anonymous localStorage progress into the DB (bulk POST), then clear the
// local key — but ONLY on a confirmed 2xx, so a failed push (offline, 401)
// keeps localStorage intact for a later retry instead of dropping progress.
export async function migrateLocalToDb(trackId: string): Promise<void> {
  let lessonIds: string[];
  try {
    const raw = localStorage.getItem(storageKey(trackId));
    lessonIds = raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return;
  }
  if (lessonIds.length === 0) return;
  try {
    const res = await fetch(`/api/progress/${trackId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lessonIds }),
    });
    if (res.ok) localStorage.removeItem(storageKey(trackId));
  } catch {
    // Keep local data; the next signed-in load retries.
  }
}
