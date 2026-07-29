// The contested-membership review drain — grouping and prioritization (read side).
//
// T1–T4e left one gap the plan states plainly: nothing converts "this `calculus` row is
// really `precalculus`" into a RETRIEVABLE membership without a human. The reclassifier
// never refiles (As-built T4a item 5), so a disagreement lands as a contested secondary,
// which T1's retrieval predicate excludes by design. T4b's quorum refile is the only
// shipped mechanism that ever produced retrievable cross-topic reach, and it fires only
// on unvouchable shelves. So the queue only grows. This module is the read half of the
// drain that empties it: it decides what a reviewer is shown and in what order.
//
// ⚠️ THE INSTRUMENT THAT CREATED THIS QUEUE CANNOT DRAIN IT. Every row here is one k-NN
// already ruled on; re-running it just reproduces the doubt. Worse, the cfml retirement
// measured k-NN as actively CIRCULAR on the cases most in need of review — a large
// mis-filed shelf is its own neighbourhood and vouches for itself (see the header of
// shelf-retire.ts). That is why the queue is grouped by CONTAINER and why the caller
// gathers provenance (container title/topic, sibling filings, source) alongside the
// embedding evidence: provenance is the independent signal, and the rubric leans on it
// exactly where the neighbourhood is self-referential.

// One contested membership, joined to enough of its resource to be grouped and ranked.
export type DrainRow = {
  membershipId: string;
  resourceId: string;
  title: string;
  // The contested membership's topic. For a primary this is also `Resource.topic`.
  topic: string;
  // False for a contested SECONDARY. The two are different bugs and the rubric treats
  // them differently: a contested primary stays retrievable, so it is a labelling doubt;
  // a contested secondary is excluded from retrieval entirely, so it is a reachability
  // bug. Both are drained here — there are only 11 secondaries — but tagged.
  isPrimary: boolean;
  // Measured k-NN purity for this membership. Post-T4e every membership in the library
  // carries a real one, which is what makes it usable as the fallback sort key below.
  relevance: number;
  origin: string;
  // Null for a top-level row. Walked to find the container whose verdict can settle it.
  parentId: string | null;
  // Own-centroid similarity minus the best rival's, from `centroidMargins`. NULL is
  // common and load-bearing — see `queuePriority`.
  margin: number | null;
};

// A container's worth of queue. `rootId` is the top of the shared parent chain — which
// for a row with no parent is the row itself, so a loose row forms a group of one and a
// contested CONTAINER groups together with its contested children rather than splitting
// off into a separate bucket. Measured 2026-07-27: 5 of the top-level contested rows are
// themselves containers whose children are also queued, and those must present as one
// decision, not two.
export type DrainGroup = {
  rootId: string;
  rows: DrainRow[];
  // The group's own priority: its most-urgent row. Keeps a container intact in the
  // ordering without letting a big group of settled-looking rows outrank a single
  // badly-filed one.
  priority: readonly [number, number];
};

// Walks to the ROOT of the parent chain — the top-level container that owns this row's
// provenance. Copied from `containerOf` in shelf-retire.ts (cycle guard included) rather
// than shared: that function walks up to a member of a caller-supplied slate, which is
// the shape D2's verdict attribution needs but not this one. Here there is no slate yet
// — the grouping is what LETS a reviewer issue a container verdict — so the walk target
// is simply the top of the chain. A shared helper for twelve lines with two different
// stop conditions would be worse than the duplication.
//
// Returns null for a top-level row (nothing above it), and stops at a missing parent so a
// subtree whose root is outside the loaded set groups under the highest row we do have.
export type ParentLink = { parentId: string | null };

export function rootContainerOf(
  row: Pick<DrainRow, 'resourceId' | 'parentId'>,
  byId: Map<string, ParentLink>,
): string | null {
  if (!row.parentId) return null;
  let cursor = row.parentId;
  const seen = new Set<string>([row.resourceId]);
  for (;;) {
    // A malformed parent chain must not hang the pass.
    if (seen.has(cursor)) return cursor;
    seen.add(cursor);
    const parent = byId.get(cursor);
    if (!parent?.parentId) return cursor;
    cursor = parent.parentId;
  }
}

// ⚠️ THE MARGIN ALONE IS NOT A USABLE SORT KEY, and this is the block's one real
// measurement. The plan demotes the centroid margin to exactly one job — review-priority
// ranking, lowest first (As-built T4a item 6, confirmed T4e item 4). But `centroidMargins`
// only reports a margin when BOTH the own topic and the best rival clear
// MIN_CENTROID_MEMBERS = 20, and measured 2026-07-27 that leaves **34 of 131 contested
// primaries (26%) with a null margin** — every row on the six thin shelves:
//
//   differential-equations 10/10, multivariable-calculus 10/10, number-theory 9/9,
//   convex-optimization 2/2, systems-of-linear-equations 2/2, eigenvalues 1/1
//
// Those are precisely T4e's sub-0.60-purity shelves — the rows most likely to be genuinely
// mis-filed. Sorting on the margin alone parks all of them in one undifferentiated block
// at the end of the queue, so the signal is missing exactly where it is most wanted.
//
// The fix is a fallback, NOT a lower MIN_CENTROID_MEMBERS: a centroid over 14 vectors is
// a mean of too few to threshold on, which is the whole reason for the constant. Instead
// fall back to the membership's own measured `relevance` — post-T4e every membership
// carries one (the §1 stretch re-score, 777/777 measured), and it answers a closely
// related question: low purity means the neighbourhood already disagrees with the shelf.
//
// Tier 0 keeps margin-bearing rows ahead of relevance-ranked ones rather than interleaving
// them: the two scales are not comparable (a margin is a difference of cosines, a purity
// is a fraction of k), and pretending otherwise would invent an ordering the data does not
// support. Within a tier, lower is more urgent.
export function queuePriority(row: DrainRow): readonly [number, number] {
  return row.margin !== null ? [0, row.margin] : [1, row.relevance];
}

function comparePriority(a: readonly [number, number], b: readonly [number, number]): number {
  return a[0] - b[0] || a[1] - b[1];
}

// Groups the queue by root container and orders both the groups and the rows inside them.
// `parents` supplies the chain for ancestors that are not themselves in the queue (a
// container is often uncontested while its children are contested).
//
// Ties break on id everywhere so a re-run of the same queue presents in the same order —
// a reviewer working a batch across two sessions should not see it reshuffle.
export function groupQueue(
  rows: DrainRow[],
  parents: Map<string, ParentLink>,
): DrainGroup[] {
  const byId = new Map(parents);
  for (const r of rows) if (!byId.has(r.resourceId)) byId.set(r.resourceId, { parentId: r.parentId });

  const groups = new Map<string, DrainRow[]>();
  for (const row of rows) {
    // A top-level row keys on ITSELF, not on a shared null bucket — otherwise a contested
    // container and its contested children land in different groups (see DrainGroup).
    const key = rootContainerOf(row, byId) ?? row.resourceId;
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }

  return [...groups.entries()]
    .map(([rootId, groupRows]) => {
      const sorted = [...groupRows].sort(
        (a, b) =>
          comparePriority(queuePriority(a), queuePriority(b)) ||
          a.resourceId.localeCompare(b.resourceId),
      );
      return { rootId, rows: sorted, priority: queuePriority(sorted[0]) };
    })
    .sort(
      (a, b) => comparePriority(a.priority, b.priority) || a.rootId.localeCompare(b.rootId),
    );
}

// How the OTHER rows in a container are filed — the provenance evidence that breaks k-NN's
// circularity. A container whose 40 uncontested children are all `linear-algebra` says
// something about its 11 contested ones that their own neighbourhood cannot, because the
// neighbourhood is largely those same siblings.
export function filingHistogram(topics: string[]): Array<{ topic: string; n: number }> {
  const counts = new Map<string, number>();
  for (const t of topics) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts.entries()]
    .map(([topic, n]) => ({ topic, n }))
    .sort((a, b) => b.n - a.n || a.topic.localeCompare(b.topic));
}

// ── verdict planning (D2, the write side) ────────────────────────────────────
//
// Verdicts are DATA, not a source literal. The cfml retirement carried its five container
// decisions in a committed script, which is right for a one-off; this queue REGENERATES —
// every discovery batch that hits an unvouchable pool or a k-NN tie writes another
// contested row (T2b As-built item 2, T3 item 5) — so baking decisions into code would
// mean editing and committing source to drain a batch. A verdict file keeps the driver's
// real advantage (the whole slate reviewable in a dry run before anything executes)
// without that cost.
//
// ⚠️ NO VERDICT HERE MAY TOUCH `Resource.status`. Filing doubt and quality are orthogonal
// axes (the plan's Uncertainty decision), and these rows already passed human quality
// review — 113 of 131 are `active`, some attached to live Paths. The verbs below write
// `ResourceTopic` and nothing else.

export type VerdictKind = 'confirm' | 'refile' | 'add' | 'skip';

// Exactly one of `membershipId` (row-level) / `containerId` (container-level).
//
// A CONTAINER verdict must name `applyTo`: the held topic it acts on. It never covers a
// subtree wholesale. Measured 2026-07-27, `Khan Academy: Cryptography` holds 17 contested
// rows across `cryptography` (8), `data-structures-algorithms` (7) and
// `discrete-mathematics` (2) — and a Khan cryptography course genuinely does teach modular
// arithmetic and algorithms, so a blanket "this container is cryptography" would refile
// rows nobody looked at. That is the fallback-vs-container distinction cfml item 3 had to
// introduce after the fact; requiring `applyTo` makes it impossible to get wrong. It also
// preserves shelf-retire's `untouched` discipline: a verdict can never reach a row an
// earlier pass settled on a different topic.
export type Verdict = {
  verdict: VerdictKind;
  membershipId?: string;
  containerId?: string;
  applyTo?: string;
  // Destination topic. Required for `refile` / `add`, meaningless for `confirm` / `skip`.
  topic?: string;
  // Refile only. True deletes the vacated membership; false retains it as an UNCONTESTED
  // secondary. Retention with the contested flag left ON is the one option that is always
  // wrong: it would be invisible to retrieval AND permanently queued, re-litigating a
  // decided row. Note a retained refile to a topic the resource does not already hold nets
  // +1 membership, so it counts against MAX_MEMBERSHIPS exactly as an `add` does.
  //
  // ⚠️ THE DEFAULT DEPENDS ON WHAT IS BEING VACATED — see `defaultDropVacated`. Omitting
  // this field is the common case, so the default has to be the safe reading for both
  // kinds of queue row, and they are opposites.
  dropVacated?: boolean;
  note?: string;
};

export type PlannedWrite = {
  membershipId: string;
  resourceId: string;
  title: string;
  verdict: VerdictKind;
  heldTopic: string;
  targetTopic: string | null;
  dropVacated: boolean;
  // Which container verdict decided this row, or null when it was decided row-by-row.
  // Every verdict in this pass is an operator judgement — unlike the cfml retirement there
  // is no policy fallback — so this is provenance for the audit record, not an input to
  // whether doubt clears. Only `skip` preserves doubt here.
  viaContainer: string | null;
  note?: string;
};

export type DrainPlan = {
  writes: PlannedWrite[];
  skipped: PlannedWrite[];
  // Queue rows no verdict covered. Reported so a batch can't silently under-deliver.
  unresolved: DrainRow[];
  errors: string[];
};

// ⚠️ RETAINING A VACATED SECONDARY WOULD INVERT THE REVIEWER'S VERDICT, which is why this
// is not a plain `?? false`.
//
// For a contested PRIMARY, retention is right and is T4b's rule: the row was retrievable
// under the vacated topic before the verdict, that shelf is still a place (it may hold live
// Paths — retention is what kept probability-and-statistics' pool whole through its split),
// and clearing the doubt is all the verdict asked for.
//
// For a contested SECONDARY the same write means the opposite. T1's retrieval predicate
// EXCLUDES contested secondaries, so that membership was invisible; settling it uncontested
// does not preserve reach, it GRANTS reach — to the very topic the reviewer just judged
// wrong. "This row is really linear-algebra" would publish it to `calculus` on the way out.
// So a secondary's vacated membership is dropped by default (T4c's rule for a topic that
// never was a place), and an operator who does want to keep it must say so explicitly.
//
// Promotion of a contested secondary (`refile` onto the topic it already holds) vacates
// nothing and never reaches this — the caller skips the vacated branch when held == target.
export function defaultDropVacated(row: Pick<DrainRow, 'isPrimary'>): boolean {
  return !row.isPrimary;
}

function isInSubtree(
  resourceId: string,
  containerId: string,
  parents: Map<string, ParentLink>,
): boolean {
  let cursor: string | null = resourceId;
  const seen = new Set<string>();
  while (cursor) {
    if (cursor === containerId) return true;
    if (seen.has(cursor)) return false;
    seen.add(cursor);
    cursor = parents.get(cursor)?.parentId ?? null;
  }
  return false;
}

// Resolves verdicts against the queue. Pure: every failure is an entry in `errors` rather
// than a throw, so one malformed line cannot hide the other twenty from the dry run.
export function planVerdicts(
  rows: DrainRow[],
  verdicts: Verdict[],
  parents: Map<string, ParentLink>,
  // EVERY topic each resource holds (all memberships, not just the contested ones on the
  // queue). Topics, not counts: the cap arithmetic depends on whether a destination is
  // already held — an `add` of a held topic is a duplicate, and a refile onto a held
  // secondary nets no new membership while a refile to a fresh topic that RETAINS the
  // vacated one nets +1.
  heldTopics: Map<string, string[]>,
  maxMemberships: number,
): DrainPlan {
  const writes: PlannedWrite[] = [];
  const skipped: PlannedWrite[] = [];
  const errors: string[] = [];
  const byMembership = new Map(rows.map((r) => [r.membershipId, r]));
  // The queue's own rows are not necessarily in `parents` (that map carries the ancestor
  // chain, which is loaded for containers that are themselves uncontested). Without this
  // merge the subtree walk starts at a resource it cannot look up and every container
  // verdict silently matches nothing — same merge groupQueue does.
  const links = new Map(parents);
  for (const r of rows) if (!links.has(r.resourceId)) links.set(r.resourceId, { parentId: r.parentId });
  // Which verdict claimed each membership, so a row covered twice is a reported conflict
  // rather than two writes racing in file order.
  const claimed = new Map<string, number>();
  // ⚠️ A WORKING COPY, updated as membership-changing verdicts are planned — the caller's
  // map is a snapshot taken before any of them. A resource can hold TWO contested
  // memberships (5 do on the live queue), so a file with a cap-consuming verdict for each
  // read the same starting state and both cleared a cap they jointly breached. Projecting
  // as we go makes the cap hold across the whole file, not just per verdict. Seeded lazily
  // from `heldTopics`, floored with each queue row's own topic so an under-supplied map
  // cannot make a row's held topic look free.
  const projectedHeld = new Map<string, Set<string>>();
  const heldOf = (resourceId: string): Set<string> => {
    let held = projectedHeld.get(resourceId);
    if (!held) {
      held = new Set(heldTopics.get(resourceId) ?? []);
      projectedHeld.set(resourceId, held);
    }
    return held;
  };
  for (const r of rows) heldOf(r.resourceId).add(r.topic);

  verdicts.forEach((v, i) => {
    const label = `verdict[${i}] (${v.verdict})`;
    const hasRow = Boolean(v.membershipId);
    const hasContainer = Boolean(v.containerId);
    if (hasRow === hasContainer) {
      errors.push(`${label}: needs exactly one of membershipId / containerId`);
      return;
    }
    if ((v.verdict === 'refile' || v.verdict === 'add') && !v.topic) {
      errors.push(`${label}: '${v.verdict}' requires a destination topic`);
      return;
    }
    if (hasContainer && !v.applyTo) {
      errors.push(`${label}: a container verdict requires applyTo (the held topic it acts on)`);
      return;
    }

    let matched: DrainRow[];
    if (hasRow) {
      const row = byMembership.get(v.membershipId!);
      if (!row) {
        errors.push(`${label}: membership ${v.membershipId} is not in the queue`);
        return;
      }
      matched = [row];
    } else {
      matched = rows.filter(
        (r) => r.topic === v.applyTo && isInSubtree(r.resourceId, v.containerId!, links),
      );
      if (matched.length === 0) {
        // A typo'd applyTo that silently does nothing is worse than a loud failure — it
        // reads as "handled" in the report while the rows stay queued forever.
        errors.push(
          `${label}: container ${v.containerId} has no contested '${v.applyTo}' rows in the queue`,
        );
        return;
      }
    }

    for (const row of matched) {
      const prior = claimed.get(row.membershipId);
      if (prior !== undefined) {
        errors.push(
          `${label}: membership ${row.membershipId} already claimed by verdict[${prior}]`,
        );
        continue;
      }
      // A refile onto the topic a PRIMARY already holds is a no-op dressed as a decision;
      // on a contested SECONDARY the same instruction means "promote this to primary",
      // which is exactly what the drain exists to make possible.
      if (v.verdict === 'refile' && row.isPrimary && v.topic === row.topic) {
        errors.push(`${label}: ${row.resourceId} is already primary on '${v.topic}'`);
        continue;
      }
      const dropVacated = v.dropVacated ?? defaultDropVacated(row);
      if (v.verdict === 'add') {
        const held = heldOf(row.resourceId);
        if (held.has(v.topic!)) {
          errors.push(`${label}: ${row.resourceId} already holds '${v.topic}'`);
          continue;
        }
        if (held.size >= maxMemberships) {
          errors.push(
            `${label}: ${row.resourceId} is at the membership cap (${held.size}/${maxMemberships})`,
          );
          continue;
        }
        // Claimed below, so the next cap-consuming verdict for this resource sees the
        // slot as spent.
        held.add(v.topic!);
      }
      if (v.verdict === 'refile') {
        // A refile is not always cap-neutral. Onto a topic the resource already holds
        // (promotion, or adopting an existing secondary as primary) it upserts in place;
        // to a FRESH topic it creates a membership, and when the vacated one is RETAINED
        // nothing is freed in exchange — net +1, the same consumption an `add` pays for.
        const held = heldOf(row.resourceId);
        if (!held.has(v.topic!) && !dropVacated && held.size >= maxMemberships) {
          errors.push(
            `${label}: refiling ${row.resourceId} to '${v.topic}' while retaining ` +
              `'${row.topic}' would breach the membership cap ` +
              `(${held.size}/${maxMemberships}) — set dropVacated: true or drop another membership first`,
          );
          continue;
        }
        held.add(v.topic!);
        if (dropVacated && v.topic !== row.topic) held.delete(row.topic);
      }
      claimed.set(row.membershipId, i);
      const planned: PlannedWrite = {
        membershipId: row.membershipId,
        resourceId: row.resourceId,
        title: row.title,
        verdict: v.verdict,
        heldTopic: row.topic,
        targetTopic: v.topic ?? null,
        dropVacated,
        viaContainer: hasContainer ? v.containerId! : null,
        ...(v.note ? { note: v.note } : {}),
      };
      if (v.verdict === 'skip') skipped.push(planned);
      else writes.push(planned);
    }
  });

  return {
    writes,
    skipped,
    unresolved: rows.filter((r) => !claimed.has(r.membershipId)),
    errors,
  };
}
