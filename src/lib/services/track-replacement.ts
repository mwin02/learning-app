// Reports R8: resolving a learner's OLD course URL after a rebuild repointed the slot.
//
// Built Tracks are immutable, so a rebuild produces a NEW Track and
// maybeAssembleProgram repoints ProgramPath.trackId at it. The learner's own
// /programs/P/oldTrack URL — reachable by reload, bookmark, or the back button —
// then fails the plan-membership check and 404s the course they were mid-way
// through. The join back is CourseRequest.replacesTrackId (R5): a fulfilled rebuild
// request records exactly which Track its Track replaced.
//
// Pure so the walk is testable without a DB; the caller supplies the program's
// rebuild edges and its current membership set.

export type RebuildEdge = {
  // The Track this rebuild replaced.
  replacesTrackId: string;
  // The Track it produced.
  trackId: string;
};

// A slot can be rebuilt repeatedly (A→B→C), and a learner's bookmark can name any
// link in the chain, so this walks forward until it reaches a Track the plan
// currently points at.
//
// EVERY successor of a Track is followed, not just the newest one: a Track can have
// two fulfilled rebuilds (A→B, A→C) with only ONE of them owning the slot, because
// the assembler refuses to repoint while any sibling request of the program is still
// building. Following the newest edge alone dead-ends on C and 404s a learner whose
// course is sitting right there at B. Breadth-first, newest edge of each Track first,
// so the winner is preferred where several successors are members.
//
// Cap and visited-set are belt and braces: the edges come from rows a worker wrote,
// and a cycle there would otherwise hang a page render.
const MAX_NODES = 50;

export function resolveReplacementTrack(
  oldTrackId: string,
  edges: RebuildEdge[],
  isMember: (trackId: string) => boolean,
): string | null {
  // Callers pass edges oldest-first; unshift puts each Track's newest successor at
  // the head of its list, which is the one the assembler would have repointed to.
  const successors = new Map<string, string[]>();
  for (const edge of edges) {
    const known = successors.get(edge.replacesTrackId);
    if (known) known.unshift(edge.trackId);
    else successors.set(edge.replacesTrackId, [edge.trackId]);
  }

  const seen = new Set<string>([oldTrackId]);
  const frontier: string[] = [oldTrackId];
  for (let i = 0; i < frontier.length && i < MAX_NODES; i++) {
    const current = frontier[i];
    for (const next of successors.get(current) ?? []) {
      if (seen.has(next)) continue;
      if (isMember(next)) return next;
      seen.add(next);
      frontier.push(next);
    }
  }
  return null;
}
