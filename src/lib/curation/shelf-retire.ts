// Retiring a shelf that was never a subject — the `calculus-for-machine-learning` triage.
//
// ⚠️ READ THIS BEFORE REUSING THE MODULE: the instrument here is PROVENANCE, not k-NN,
// and that is a deliberate departure from every other filing decision in this plan.
//
// The k-NN guardrail CANNOT adjudicate a large mis-filed shelf, because such a shelf is
// its own neighbourhood. Measured on cfml 2026-07-27: 117 of its 132 rows are children of
// five containers, and 67 of those are one Khan container ("Limits and continuity |
// Calculus 1 | Math | Khan Academy") that is unambiguously plain calculus. Asked where
// those rows belong, k-NN answers:
//
//   "Limits and continuity | Calculus 1"  n=67  -> (tie)=27  calculus=26  cfml=14
//   "Linear Algebra"                      n=21  -> cfml=14   linear-algebra=6
//
// The 21 Linear Algebra rows name cfml as their own plurality. Of course they do — they
// are each other's nearest neighbours. The instrument reports "this row sits near other
// cfml rows", which is true and useless. **A shelf that starts wrong and grows big becomes
// self-justifying**, which is the failure mode of the guardrail's self-widening property.
// It is also why T4a contested 82 of these rows but could propose a home for only 51.
//
// So the decision comes from what the container demonstrably IS — its title, its source,
// its sibling structure — which is an operator judgement, hence `origin: review` (the T4c
// precedent, where the `differentiation` fold was likewise a human closing out a plan item
// rather than a classifier verdict).
//
// Corroboration that cfml is not a subject: the program plan pass already ships a
// scoped-topic reconciler whose canonical EXAMPLE is `"calculus-for-machine-learning" is a
// scope of "calculus"` (src/lib/agents/program/plan.ts), folding such proposals into the
// parent topic. That policy has applied to new proposals since F7; this module applies the
// same verdict to the library that predates it.

export type ShelfRow = {
  id: string;
  title: string;
  // Current primary topic. Only rows still on the retiring shelf are moved.
  topic: string;
  // Null for a top-level row. Used to walk up to the container that owns the decision.
  parentId: string | null;
  // Current doubt flag on the primary membership. See `contested` on ShelfMove.
  contested: boolean;
  // Origin of the current primary membership. `review` inside a slate subtree marks a row
  // THIS operation already moved, which is what makes the pass re-runnable: a second run
  // recognizes its own writes instead of reading them as somebody else's settled filing.
  origin: string;
};

// container resource id -> the topic its subtree actually belongs to.
export type Slate = Map<string, string>;

export type ShelfMove = {
  id: string;
  title: string;
  from: string;
  to: string;
  // Which container's verdict this row inherits, or null when it was decided by the
  // top-level fallback. Carried into the audit record so a move is explainable.
  viaContainer: string | null;
  // ⚠️ THE CONTESTED RULE, and it turns on WHO decided:
  //
  //   decided by a container slate entry -> CLEARED. The operator naming what the
  //     container is IS the review. T4a contested these rows for exactly one reason —
  //     the primary (cfml) disagreed with the neighbourhood — and moving them off it
  //     answers that. This is the T4c pattern: T4a detected and recorded the hypothesis,
  //     the operator confirms it. Leaving them contested would keep 77 rows in a queue
  //     whose question has been answered, which is how a review backlog becomes noise.
  //
  //   decided by the FALLBACK -> PRESERVED. A top-level row folded to the scope parent
  //     got a policy default, not a judgement: nobody looked at it. Those rows are
  //     exactly what the review drain is for, so their doubt must survive.
  //
  // A row that was never contested is never newly contested either way — this pass does
  // not manufacture doubt.
  contested: boolean;
  // True when a container verdict (not the fallback) decided this row. Drives the rule
  // above and is worth reporting: it is the count of doubts the operator actually closed.
  operatorDecided: boolean;
};

export type ShelfPlan = {
  // Rows whose primary topic changes.
  moves: ShelfMove[];
  // Rows already on their target from an earlier run of THIS pass whose `contested` flag
  // still needs the rule above applied. Keeps the driver re-runnable: the topic move and
  // the doubt resolution are separate writes, and a crash between them must be
  // recoverable by re-running the same command.
  settles: ShelfMove[];
  // Rows on the shelf that resolve to the topic they already hold — nothing to do.
  noop: ShelfRow[];
  // Rows in a container's subtree that are NOT on the retiring shelf. They were filed
  // elsewhere by an earlier pass (T4b split `eigenvalues-and-eigenvectors`,
  // `systems-of-linear-equations` and `convex-optimization` out of these very containers)
  // and MUST be left alone: inheriting the container's verdict would undo settled work.
  untouched: ShelfRow[];
};

// Walks up the parent chain to the container that owns this row's verdict. Returns the
// container id, or null when the row is top-level or its chain leaves the shelf.
function containerOf(row: ShelfRow, byId: Map<string, ShelfRow>, slate: Slate): string | null {
  let cursor: ShelfRow | undefined = row;
  const seen = new Set<string>();
  while (cursor) {
    if (slate.has(cursor.id)) return cursor.id;
    // Cycle guard: a malformed parent chain must not hang the pass.
    if (seen.has(cursor.id)) return null;
    seen.add(cursor.id);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  return null;
}

// `rows` is the full subtree population (every descendant of every slate container, plus
// every row still on `retiring`), so the plan can distinguish "not on the shelf" from
// "not in scope". `fallback` files top-level shelf rows the slate does not cover.
export function planShelfRetirement(
  rows: ShelfRow[],
  slate: Slate,
  retiring: string,
  fallback: string,
): ShelfPlan {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const moves: ShelfMove[] = [];
  const settles: ShelfMove[] = [];
  const noop: ShelfRow[] = [];
  const untouched: ShelfRow[] = [];

  for (const row of rows) {
    const container = containerOf(row, byId, slate);
    const to = container ? slate.get(container)! : fallback;
    const operatorDecided = container !== null;
    const decide = (): ShelfMove => ({
      id: row.id,
      title: row.title,
      from: row.topic,
      to,
      // A container is decided by its own slate entry, not "via" itself.
      viaContainer: container && container !== row.id ? container : null,
      contested: operatorDecided ? false : row.contested,
      operatorDecided,
    });

    if (row.topic !== retiring) {
      // Off the shelf already. Two very different cases, and conflating them is how an
      // earlier pass's work gets clobbered:
      //   - `origin: review` on its target => THIS pass moved it (a re-run, or a crash
      //     between the move and the settle). Eligible for the contested rule.
      //   - anything else => a different pass filed it (T4b split
      //     `eigenvalues-and-eigenvectors` / `systems-of-linear-equations` /
      //     `convex-optimization` out of these very containers). Leave it entirely alone.
      const ours = row.origin === 'review' && row.topic === to;
      if (ours && row.contested && operatorDecided) settles.push(decide());
      else untouched.push(row);
      continue;
    }
    if (to === row.topic) {
      noop.push(row);
      continue;
    }
    moves.push(decide());
  }
  return { moves, settles, noop, untouched };
}

// Summary for the driver's report and the audit record: how many rows land on each topic.
export function summarizeMoves(moves: ShelfMove[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of moves) out.set(m.to, (out.get(m.to) ?? 0) + 1);
  return out;
}
