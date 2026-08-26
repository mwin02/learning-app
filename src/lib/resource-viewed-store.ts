// Lesson View v3: which core resources the learner has ticked off inside one
// lesson. Deliberately localStorage-only, and deliberately NOT part of
// progress-store: lesson completion is the durable, DB-backed record of
// progress, while this is a within-lesson checklist for multi-core lessons —
// "which of these three have I worked through". Promoting it to the DB would
// need its own table, API route and migration; until a learner asks for it to
// follow them across devices, the cheap tier is the honest one.
//
// Same degrade-to-empty posture as LocalProgressStore: storage may be
// unavailable (private mode, quota) and a lost tick is not worth a throw.

const storageKey = (lessonId: string) => `learn:viewed:${lessonId}`;

// Async like ProgressStore.load(), even though localStorage is synchronous: the
// callers hydrate in an effect, and an awaited read keeps that a subscription to
// an external system rather than a synchronous setState cascade.
export async function loadViewed(lessonId: string): Promise<Set<string>> {
  try {
    const raw = localStorage.getItem(storageKey(lessonId));
    return raw ? new Set<string>(JSON.parse(raw) as string[]) : new Set<string>();
  } catch {
    return new Set<string>();
  }
}

export function saveViewed(lessonId: string, viewed: Set<string>): void {
  try {
    localStorage.setItem(storageKey(lessonId), JSON.stringify([...viewed]));
  } catch {
    // Best-effort; the UI already updated from React state.
  }
}
