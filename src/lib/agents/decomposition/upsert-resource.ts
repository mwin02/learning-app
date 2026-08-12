// Phase 2.5b — shared Resource upsert (parent + decomposed children).
//
// Extracted from web-fallback.ts so discovery and the seed-backfill script
// (2.5b-4) write resources through one path (ROADMAP 2.5b decision #6). Given a
// resource and the result of decompose(), it persists the parent with the
// right decompositionStatus and, when a router produced children, the whole
// child tree (a container can nest containers) — parent + descendants in a
// single transaction. Embeddings are written after commit (they reference the
// freshly-created ids), and only for pickable atomic leaves.
//
// Children inherit sourceId / trustScore / language from the parent; only the
// parent's source is resolved. Child concepts are already per-child (derived +
// canonicalized by the router, decision A) by the time they reach here. Their
// TOPIC is not inherited — Q4 files each child on its own content through the
// same guardrail the parent went through (see fileChildren below).

import { prisma } from '@/lib/db';
import { log, logWarn } from '@/lib/log';
import { safeEmbedBatch, safeEmbedResource, storeEmbedding } from '@/lib/ai/embeddings';
import { setPrimaryTopic, addCollisionMembership } from '@/lib/curation/resource-topics';
import {
  knnNeighbourTopics,
  topicPools,
  MAX_MEMBERSHIPS,
  type FilingDecision,
} from '@/lib/curation/topic-knn';
import {
  classifyDiscoveryTopics,
  decideFilingWithParentPrior,
  type TopicProposal,
} from '@/lib/agents/tools/classify-topic';
import { listCanonicals } from '@/lib/agents/topic-registry';
import { safeClassifyAndPersist } from '@/lib/curation/embeddability';
import { computeTrustScore } from '@/lib/curation/trust-score';
import { classifyNonTeaching } from '@/lib/curation/non-teaching';
import { youtubeEngagementSignal } from '@/lib/curation/youtube-signal';
import { normalizeResourceUrl } from './normalize-url';
import { crediblePageTitle } from './page-title';
import { checkDuration, containerDuration, type DurationClaim } from './duration-rules';
import type {
  PrismaClient,
  ResourceType,
  Difficulty,
  DecompositionStatus,
  DurationSource,
  ResourceStatus,
} from '@prisma/client';
import type { DecompositionResult, ChildInput } from './decompose';

export type UpsertResourceInput = {
  url: string;
  title: string;
  type: string;
  difficulty: string;
  // Q2: null when the discovery model declined to estimate. `durationSource` states
  // what kind of number it is; both are re-checked here before they are persisted.
  durationMin: number | null;
  durationSource: DurationSource;
  summary: string;
  prerequisiteConcepts: string[];
  conceptsTaught: string[];
  // Phase 2.5h: present when this resource was sourced via the YouTube Data API
  // prong. Drives channel-level Source resolution (by channelId, not hostname),
  // persists the raw engagement signals, and feeds the engagement EvidenceSignal
  // into the trustScore seam. Absent for grounded-search / seed resources.
  youtube?: { channelId: string; viewCount: number; likeCount: number | null };
};

// `atomicIds` are the newly-created pickable (atomic) resource ids — an atomic
// parent, or a decomposed container's atomic children. The retrieval session
// uses them as a discovery allowlist so agent-triggered fallback finds stay
// visible to search even on an above-gate topic (where search is active-only).
// Empty on 'skipped' and on an inserted-but-unpickable container (pending /
// human_review parent with no atomic children).
//
// `resourceId` / `decompositionStatus` identify the PARENT row the input URL
// resolved to — the freshly-created row on 'inserted', the existing row on a
// dedup 'skipped' (so provenance can record a rediscovery of a parked
// container). Null when there is no addressable row (transaction failure).
//
// T3: 'membership_added' is a dedup hit whose requested topic CLEARED the collision
// guardrail and became a `ResourceTopic` membership — no row inserted, but the row is now
// reachable from a topic it wasn't reachable from before. It exists so the discovery
// counters can stop reporting that as a plain 'skipped'.
export type UpsertOutcome = {
  outcome: 'inserted' | 'skipped' | 'membership_added';
  atomicIds: string[];
  resourceId: string | null;
  decompositionStatus: DecompositionStatus | null;
};

type TxClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

// Rows queued for post-commit per-resource work (embed + 2.5j embeddability probe)
// once the transaction commits. `url` feeds the embeddability classifier.
//
// ⚠️ This list is ALSO the pickable-atomic id set — `atomicIds` (the retrieval session's
// discovery allowlist) is derived from it below. Never push a container onto it, even
// though containers are now embedded (T2a): membership here means "pickable", not
// "embedded". `embedded: true` marks a row whose vector was already written pre-insert,
// so the post-commit loop skips the redundant embed call but still runs the
// embeddability probe.
type EmbedTask = {
  id: string;
  url: string;
  title: string;
  summary: string;
  conceptsTaught: string[];
  embedded?: boolean;
};

export async function upsertResource(
  topic: string,
  resource: UpsertResourceInput,
  decomposition: DecompositionResult,
  // Topic filing T2a: the parent's embedding, computed by the caller BEFORE the insert
  // (persistDiscovered) from the same title + summary + conceptsTaught the post-commit
  // embed would use. Written inside the transaction, so the row arrives embedded and the
  // T2b filing guardrail has its input at filing time instead of after commit. Optional:
  // callers without a vector (seed/verify paths) keep today's post-commit behaviour.
  embedding?: number[] | null,
  // Topic filing T2b: where this resource is FILED — one primary (mirrored to
  // Resource.topic through the setPrimaryTopic seam) plus any guarded secondaries, as
  // decided by decideFiling against the embedding above. Omitted by callers that gather
  // no evidence (the seed/verify paths), which then get today's semantics: a single
  // `discovery` membership under `topic`, which is precisely what that origin means.
  filing?: FilingDecision,
): Promise<UpsertOutcome> {
  // F8: dedup on the canonical URL — strip tracking params / fragment / trailing slash /
  // host case so a trivially-different URL for the same page collapses onto one row.
  const url = normalizeResourceUrl(resource.url);
  const existing = await prisma.resource.findUnique({
    where: { url },
    select: { id: true, topic: true, decompositionStatus: true },
  });
  if (existing) {
    // T3: a cross-topic collision is no longer a dead end. The rediscovering topic may
    // JOIN the existing row — but only by clearing the same guardrail a fresh filing
    // does, measured against the existing row's own embedding. Gated on `filing` because
    // that is what marks an evidence-gathering caller: the seed/verify paths supply no
    // filing and keep the pre-T3 log-and-skip exactly.
    if (existing.topic !== topic) {
      const added = filing ? await addCollisionMembership(existing.id, topic) : null;
      console.log('[upsert-resource] cross-topic URL collision', {
        url,
        existingTopic: existing.topic,
        requestedTopic: topic,
        membershipAdded: Boolean(added),
        relevance: added ? Number(added.relevance.toFixed(2)) : null,
        contested: added?.contested ?? null,
      });
      if (added) {
        return {
          // Nothing was INSERTED — the row already existed — but nothing was skipped
          // either: the requested topic can now retrieve it. `atomicIds` stays empty; it
          // means "newly created pickable ids", and this row may well be a parked
          // container. (Attaching it to the demanding concept is rung 0's job.)
          outcome: 'membership_added',
          atomicIds: [],
          resourceId: existing.id,
          decompositionStatus: existing.decompositionStatus,
        };
      }
    }
    return {
      outcome: 'skipped',
      atomicIds: [],
      resourceId: existing.id,
      decompositionStatus: existing.decompositionStatus,
    };
  }

  // YouTube videos resolve their Source by channelId (hostname can't tell channels
  // apart); everything else by URL host. Then compose trustScore through the single
  // seam: a YouTube video carries an engagement EvidenceSignal so its trust reflects
  // its own reception; other resources have no signal and rest on the source prior.
  const source = resource.youtube
    ? await resolveYouTubeSource(resource.youtube.channelId)
    : await resolveSource(url);
  const engagement = resource.youtube ? youtubeEngagementSignal(resource.youtube) : null;
  const sourceTrust = computeTrustScore({
    base: source.trustScore,
    signals: engagement ? [engagement] : [],
  });
  const taken = new Set<string>();
  const embedTasks: EmbedTask[] = [];
  let parentId: string | null = null;

  // Q2: a container that was actually exploded takes its duration from its children
  // (a floor over the ones we know), since the discovery estimate was a guess about
  // an index page. Everything else is the vetted discovery claim.
  const childSum = containerDuration(decomposition.children);
  const parentDuration =
    decomposition.status === 'decomposed' && childSum.durationMin != null
      ? childSum
      : vettedDuration(
          {
            type: resource.type,
            durationMin: resource.durationMin,
            durationSource: resource.durationSource,
            decompositionStatus: decomposition.status,
            childCount: decomposition.children.length,
          },
          url,
        );

  const decision = filing ?? defaultFiling(topic);
  // Q4: classify the children on their own content before the transaction opens (network
  // calls; and the guardrail's evidence must predate the first insert). Gated on `filing`
  // for the same reason every other evidence step here is: it is what marks an
  // evidence-gathering caller, and the seed/verify paths that supply none keep today's
  // cost and today's semantics.
  const childFilings =
    filing && decomposition.children.length > 0
      ? await fileChildren(decomposition.children, decision.primary.topic)
      : new Map<string, ChildFiling>();

  try {
    await prisma.$transaction(async (tx) => {
      const parentSlug = await uniqueSlug(tx, resource.title, url, taken);
      const parent = await tx.resource.create({
        data: {
          slug: parentSlug,
          topic,
          title: resource.title,
          url,
          type: resource.type as ResourceType,
          ...parentDuration,
          summary: resource.summary,
          difficulty: resource.difficulty as Difficulty,
          prerequisiteConcepts: resource.prerequisiteConcepts,
          conceptsTaught: resource.conceptsTaught,
          // Phase 2.5h: raw engagement signals (null for non-YouTube), so trustScore
          // is recomputable when stats grow stale or our own votes land.
          viewCount: resource.youtube?.viewCount ?? null,
          likeCount: resource.youtube?.likeCount ?? null,
          youtubeChannelId: resource.youtube?.channelId ?? null,
          origin: 'agent',
          status: 'pending_review',
          trustScore: sourceTrust,
          sourceId: source.id,
          decompositionStatus: decomposition.status,
        },
        select: { id: true },
      });
      parentId = parent.id;

      // T2b: file the row. Post-T1 retrieval is an EXISTS over "ResourceTopic", so a row
      // with no membership is unreachable no matter what Resource.topic says — the
      // memberships ARE the filing, and they are written in the same transaction as the
      // row so that can never come apart.
      await writeMemberships(tx, parent.id, decision);

      // T2a: the parent is embedded whatever its decompositionStatus, container
      // included. The old atomic-only gate read "embedding an unpickable container
      // wastes a call" — true while an embedding only bought PICKABILITY, false now
      // that it also buys FILING EVIDENCE. Containers were the blind spot: the
      // motivating defect (a 45-leaf Khan unit filed under discrete-mathematics) is a
      // container mis-filing, and its children inherit the topic, multiplying one
      // mistake by 45. Retrieval stays container-free via the decompositionStatus
      // predicate in searchResources, not via embedding presence.
      // ⚠️ Must stay AFTER the membership write: setPrimaryTopic updates Resource.topic
      // through the Prisma client, which bumps @updatedAt — and storeEmbedding stamps
      // GREATEST("updatedAt", now()), so embedding last is what keeps the row from
      // looking stale to embedMissing() the moment it is created.
      if (embedding) await storeEmbedding(parent.id, embedding, tx);
      // ...but only an ATOMIC parent joins embedTasks, which is the pickable set that
      // becomes `atomicIds` (see the type comment). Already-embedded rows still need
      // their embeddability probe, hence the flag rather than an early exit.
      if (decomposition.status === 'atomic') {
        embedTasks.push({
          id: parent.id,
          url,
          title: resource.title,
          summary: resource.summary,
          conceptsTaught: resource.conceptsTaught,
          embedded: Boolean(embedding),
        });
      }

      for (const child of decomposition.children) {
        await createChild(tx, {
          topic: decision.primary.topic,
          filing: decision,
          childFilings,
          parentId: parent.id,
          sourceId: source.id,
          trustScore: sourceTrust,
          // Discovery's parent is an unvetted agent find (pending_review above),
          // so its children inherit that gate.
          childStatus: 'pending_review',
          child,
          taken,
          embedTasks,
        });
      }
    // T2b: raised off Prisma's 5s default, the same trade decomposeExisting already
    // makes. Filing added ~4 round-trips per row (setPrimaryTopic locks the Resource,
    // clears other primaries, upserts the membership, writes the mirror) on top of the
    // insert, so the motivating 45-leaf Khan container now spends ~5x the statements
    // inside this transaction. Blowing the budget is silent in the worst way: the catch
    // below turns a P2028 into `outcome: 'skipped'`, so the whole decomposition would
    // vanish with one log line. 60s is well clear of the observed shape while still
    // bounding a hung connection.
    }, { maxWait: 10_000, timeout: 60_000 });
  } catch (err) {
    console.log('[upsert-resource] transaction failed', {
      url,
      error: (err as Error).message,
    });
    return { outcome: 'skipped', atomicIds: [], resourceId: null, decompositionStatus: null };
  }

  // Best-effort embeds, post-commit: a failure logs but leaves the row in place
  // for the next backfill (embeddedAt < updatedAt). embedTasks are exactly the
  // atomic (pickable) ids created above. Phase 2.5j: classify embeddability over
  // the same pickable set (only resources that reach a Lesson need a deliveryMode);
  // also best-effort, retried by the backfill on `embedCheckedAt IS NULL`.
  for (const t of embedTasks) {
    // Skipped for a parent whose vector was written pre-insert (T2a) — same text, same
    // model, so re-embedding it would only spend the call twice.
    if (!t.embedded) {
      await safeEmbedResource(t.id, {
        title: t.title,
        summary: t.summary,
        conceptsTaught: t.conceptsTaught,
      });
    }
    await safeClassifyAndPersist(t.id, t.url);
  }

  return {
    outcome: 'inserted',
    atomicIds: embedTasks.map((t) => t.id),
    resourceId: parentId,
    decompositionStatus: decomposition.status,
  };
}

// Apply a decomposition to an ALREADY-EXISTING resource (the seed-backfill case,
// 2.5b-4) — the parent row already exists, unlike the discovery path which
// creates it. Updates the parent's decompositionStatus and, for a 'decomposed'
// result, creates the children (and their nested descendants) through the same
// createChild path (slug, source/trust inheritance, URL-collision skip,
// post-commit embed). `childrenCreated` counts every row created across the
// subtree. Idempotent on re-run: nodes whose URL already exists are skipped.
export async function decomposeExisting(
  resourceId: string,
  decomposition: DecompositionResult,
  // keepFragments: preserve child URL fragments (`<page>#<anchor>`) — the manual
  // anchor-children route for one-page books. Only the decompose_manual API path
  // sets it (after validateAnchorChildren); automated routes keep the F8 collapse.
  opts: { keepFragments?: boolean } = {},
): Promise<{ status: DecompositionResult['status']; childrenCreated: number }> {
  const existing = await prisma.resource.findUnique({
    where: { id: resourceId },
    select: {
      url: true,
      topic: true,
      sourceId: true,
      trustScore: true,
      title: true,
      summary: true,
      conceptsTaught: true,
      status: true,
    },
  });
  if (!existing) throw new Error(`decomposeExisting: resource ${resourceId} not found`);

  const taken = new Set<string>();
  const embedTasks: EmbedTask[] = [];
  let childrenCreated = 0;

  // A router that fetched the page can correct a title discovery invented from the
  // demanding concept rather than the page (page-title.ts). Doing it here is what
  // makes the review queue self-healing: requeue a mis-titled container and the
  // re-decomposition fixes its title, filing evidence and vector along the way.
  const correctedTitle = crediblePageTitle(decomposition.pageTitle, existing.title, existing.url);

  // A corrected title MUST land together with its re-embed: title is a third of the
  // embedded text (lib/ai/embeddings), so a title write without the matching vector
  // leaves the row mis-routed in pgvector — and crediblePageTitle will never re-propose
  // it, because the stored title now matches the page. Recovery would then hang on the
  // periodic embedMissing() backfill (`embeddedAt < updatedAt`). So embed BEFORE the
  // transaction (a network call — it must not run inside it) and store the vector IN the
  // same tx as the title, mirroring the discovery path's enlisted-client write (T2a
  // above). If the embed can't be produced, DEFER the correction rather than commit a
  // title that misdescribes the vector — the next re-decomposition re-proposes it.
  let correctedVec: number[] | null = null;
  if (correctedTitle) {
    [correctedVec] = await safeEmbedBatch([
      { title: correctedTitle, summary: existing.summary, conceptsTaught: existing.conceptsTaught },
    ]);
    log(
      correctedVec
        ? 'upsert-resource.title-corrected'
        : 'upsert-resource.title-correction-deferred',
      { resourceId, stored: existing.title, page: correctedTitle },
    );
  }
  const appliedTitle = correctedVec ? correctedTitle : null;
  const title = appliedTitle ?? existing.title;

  // Q4: same per-child filing the discovery path does. This path carries no FilingDecision
  // to inherit — pre-Q4 its children were stamped with the parent's topic as a plain
  // `discovery` membership — so it is the path that produced most of the library's
  // unclassified children (seed backfill, and every re-decomposition out of the review
  // queue). The parent's topic is still the prior and still the fallback.
  const childFilings =
    decomposition.children.length > 0
      ? await fileChildren(decomposition.children, existing.topic)
      : new Map<string, ChildFiling>();

  await prisma.$transaction(async (tx) => {
    await tx.resource.update({
      where: { id: resourceId },
      data: {
        decompositionStatus: decomposition.status,
        ...(appliedTitle ? { title: appliedTitle } : {}),
      },
    });
    // The corrected title's vector commits in the same tx (see above). storeEmbedding
    // stamps embeddedAt = GREATEST(updatedAt, now()), so the row this update just
    // touched isn't flagged stale the instant it's written.
    if (appliedTitle && correctedVec) await storeEmbedding(resourceId, correctedVec, tx);
    // A reroute to 'atomic' (e.g. doc-TOC single_lesson/reference_index) makes
    // the parent itself pickable — embed it, or searchResources under-ranks it.
    // A 'decomposed' parent stays an unpickable container (children only), but a
    // corrected title still re-embeds it: that vector is its filing evidence and its
    // pgvector routing. `embedded` mirrors the discovery path — skip the redundant
    // post-commit embed (the vector is already written) but still run the
    // embeddability probe.
    if (decomposition.status === 'atomic' || appliedTitle) {
      embedTasks.push({
        id: resourceId,
        url: existing.url,
        title,
        summary: existing.summary,
        conceptsTaught: existing.conceptsTaught,
        embedded: Boolean(appliedTitle),
      });
    }
    for (const child of decomposition.children) {
      childrenCreated += await createChild(tx, {
        topic: existing.topic,
        childFilings,
        parentId: resourceId,
        sourceId: existing.sourceId,
        trustScore: existing.trustScore,
        // Children inherit the parent's review status: decomposing an `active`
        // (curated seed, or already-approved) container yields `active`,
        // pickable children — they're sub-units of vetted content, not new
        // discovery. This is the durable fix for the seed-decomposition bug that
        // left 1,584 atomic children stuck `pending_review` under active seed
        // containers (the floor never saw them; the pending queue never showed
        // the active parent).
        childStatus: existing.status,
        child,
        taken,
        embedTasks,
        keepFragments: opts.keepFragments,
      });
    }
    // Raise the interactive-transaction timeout well above Prisma's 5s default:
    // a manual (or forced) decomposition is un-gated, so a large SPA course can
    // create 100+ children, and each child is a few round-trips to a remote DB.
    // This is a rare admin curation op, so holding the connection ~tens of
    // seconds for an atomic all-or-nothing insert is the right trade.
  }, { maxWait: 10_000, timeout: 120_000 });

  for (const t of embedTasks) {
    // Skip the embed for a task whose vector was already written in the tx (a corrected
    // parent title, or a pre-embedded child) — same text, same model. Still probe
    // embeddability, which is a property of the URL, not the embedded text.
    if (!t.embedded) {
      await safeEmbedResource(t.id, { title: t.title, summary: t.summary, conceptsTaught: t.conceptsTaught });
    }
    await safeClassifyAndPersist(t.id, t.url);
  }

  return { status: decomposition.status, childrenCreated };
}

// ── curation-review decisions (2.5b-6) ───────────────────────────────────────
//
// Applied by the decomposition-review API to a row currently queued for review.
// Both guard on the current decompositionStatus being review-queued
// (human_review | pending) via a conditional updateMany — so a concurrent caller
// can't clobber a row that already left the queue. `applied: false` means the
// row wasn't in a review-queued state (already decided, or wrong id).

const REVIEW_QUEUED: DecompositionStatus[] = ['human_review', 'pending'];

// Accept a container whole, as a single pickable atomic unit. Unlike the
// discovery path, a queued container was never embedded (an unpickable container
// isn't worth an embed call) — so once it becomes pickable we embed it now, or
// searchResources would under-rank it.
export async function markAtomic(resourceId: string): Promise<{ applied: boolean }> {
  const { count } = await prisma.resource.updateMany({
    where: { id: resourceId, decompositionStatus: { in: REVIEW_QUEUED } },
    data: { decompositionStatus: 'atomic' },
  });
  if (count === 0) return { applied: false };

  const row = await prisma.resource.findUnique({
    where: { id: resourceId },
    select: { url: true, title: true, summary: true, conceptsTaught: true },
  });
  if (row) {
    await safeEmbedResource(resourceId, {
      title: row.title,
      summary: row.summary,
      conceptsTaught: row.conceptsTaught,
    });
    await safeClassifyAndPersist(resourceId, row.url);
  }
  return { applied: true };
}

// Reject a container: keep it as an unpickable record that has left the queue
// (not crawled, not embedded).
export async function markUnsupported(resourceId: string): Promise<{ applied: boolean }> {
  const { count } = await prisma.resource.updateMany({
    where: { id: resourceId, decompositionStatus: { in: REVIEW_QUEUED } },
    data: { decompositionStatus: 'unsupported' },
  });
  return { applied: count > 0 };
}

// Create one child of a decomposed container and, recursively, its whole subtree
// (the doc-TOC router can nest a container inside a container). Returns the count
// of rows actually created in this subtree. Only atomic leaves are queued for
// embedding (intermediate containers aren't pickable, so embedding them wastes a
// call) — appended to the shared `embedTasks` so the caller embeds post-commit.
//
// Skips a node — and its subtree — if the child URL already exists as a
// standalone resource: a video/page can appear both as a seeded single and
// inside a container; we keep the first and don't dupe.
async function createChild(
  tx: TxClient,
  args: {
    topic: string;
    // The parent's filing. Q4 demoted it to the LAST resort: it is used only for a child
    // `fileChildren` produced no entry for at all. The pre-Q4 argument for inheriting it
    // — "a container's children are by construction the same subject as the container" —
    // is what P3 measured and disproved: it was true often enough to sound right and
    // wrong often enough that every dumping-ground shelf in the audit was built out of
    // it, 45 leaves at a time.
    filing?: FilingDecision;
    // Q4: each child's own filing (+ its vector), keyed by raw url. Covers the whole
    // subtree, so recursion just passes it down.
    childFilings?: Map<string, ChildFiling>;
    parentId: string;
    sourceId: string;
    trustScore: number;
    // Review status the child (and its subtree) is created with — inherited from
    // the container being decomposed (pending_review for discovery, active for a
    // curated/seed container). See the two call sites.
    childStatus: ResourceStatus;
    child: ChildInput;
    taken: Set<string>;
    embedTasks: EmbedTask[];
    // Preserve URL fragments (manual anchor children only — see decomposeExisting).
    keepFragments?: boolean;
  },
): Promise<number> {
  const { topic, parentId, sourceId, trustScore, childStatus, child, taken, embedTasks } = args;
  const own = args.childFilings?.get(child.url);
  const childFiling = own?.filing ?? args.filing ?? defaultFiling(topic);
  const childTopic = childFiling.primary.topic;

  // F8: same canonical-URL dedup as the parent path (see upsertResource) — except
  // that anchor children keep their fragment (that IS the child's identity).
  const url = normalizeResourceUrl(child.url, { keepFragment: args.keepFragments });
  const clash = await tx.resource.findUnique({
    where: { url },
    select: { id: true },
  });
  if (clash) {
    console.log('[upsert-resource] skip existing child URL', { url, parentId });
    return 0;
  }

  const decompStatus: DecompositionStatus = child.decompositionStatus ?? 'atomic';
  // Q8 (P6): a container's navigation and marketing pages come down the same child list
  // as its lessons. The row is still CREATED — its URL must stay known, or the next
  // decomposition re-admits it and the F8 dedup has nothing to collapse onto — but it
  // enters already soft-deprecated, which is exactly what the one-time backfill does to
  // the furniture already in the library. Pickable is `active AND atomic`, so this is what
  // keeps it out of retrieval without lying about its shape (it IS an atomic page), and
  // `soft` because this is a quality downgrade, not a dead link.
  const furniture = classifyNonTeaching({
    title: child.title,
    summary: child.summary,
    url,
  });
  if (furniture.nonTeaching) {
    logWarn('upsert-resource.non_teaching_child', {
      url,
      title: child.title,
      reason: furniture.reason,
      parentId,
    });
  }
  const childSum = containerDuration(child.children ?? []);
  const slug = await uniqueSlug(tx, child.title, url, taken);
  const created = await tx.resource.create({
    data: {
      slug,
      // The mirror `writeMemberships` is about to write anyway (setPrimaryTopic owns it);
      // stated here so the row is never momentarily filed somewhere it does not belong.
      topic: childTopic,
      title: child.title,
      url,
      type: child.type as ResourceType,
      // Same two rules as the parent: a nested container is its children's sum, a
      // leaf is its own vetted claim.
      ...(decompStatus === 'decomposed' && childSum.durationMin != null
        ? childSum
        : vettedDuration(
            {
              type: child.type,
              durationMin: child.durationMin,
              durationSource: child.durationSource,
              decompositionStatus: decompStatus,
              childCount: child.children?.length ?? 0,
            },
            url,
          )),
      summary: child.summary,
      difficulty: child.difficulty as Difficulty,
      prerequisiteConcepts: child.prerequisiteConcepts,
      conceptsTaught: child.conceptsTaught,
      conceptOrigin: child.conceptOrigin,
      origin: 'agent',
      status: furniture.nonTeaching ? 'deprecated' : childStatus,
      ...(furniture.nonTeaching ? { deprecationSeverity: 'soft' as const } : {}),
      trustScore,
      sourceId,
      parentResourceId: parentId,
      orderInParent: child.orderInParent,
      decompositionStatus: decompStatus,
    },
    select: { id: true },
  });

  // T2b: children are the pickable leaves, so a missing membership costs MORE here than
  // on the container — it makes the whole decomposition unretrievable. Q4: the
  // memberships are now this child's own, measured against this child's own embedding.
  await writeMemberships(tx, created.id, childFiling);

  // ⚠️ AFTER the membership write, for the reason spelled out on the parent's
  // storeEmbedding call: setPrimaryTopic writes Resource.topic through the Prisma client
  // and bumps @updatedAt, while storeEmbedding stamps GREATEST("updatedAt", now()) — so
  // embedding first would leave a freshly-created row looking stale to embedMissing().
  if (own?.vector) await storeEmbedding(created.id, own.vector, tx);

  // Only atomic leaves are pickable, so only they are embedded post-commit. A child whose
  // vector was already written above still needs its embeddability probe, so it joins the
  // list flagged rather than being skipped (same shape as the parent path). Furniture is
  // excluded on the same rule: this list IS the pickable-atomic set (see the EmbedTask
  // comment), so a deprecated row on it would flow into `atomicIds` and back into
  // retrieval's discovery allowlist — undoing the deprecation two lines after writing it.
  if (decompStatus === 'atomic' && !furniture.nonTeaching) {
    embedTasks.push({
      id: created.id,
      url,
      title: child.title,
      summary: child.summary,
      conceptsTaught: child.conceptsTaught,
      embedded: Boolean(own?.vector),
    });
  }

  let count = 1;
  for (const grandchild of child.children ?? []) {
    count += await createChild(tx, {
      topic,
      filing: args.filing,
      childFilings: args.childFilings,
      parentId: created.id,
      sourceId,
      trustScore,
      childStatus,
      child: grandchild,
      taken,
      embedTasks,
      keepFragments: args.keepFragments,
    });
  }
  return count;
}

// ── per-child topic filing (Q4 / plan defect P3) ─────────────────────────────
//
// What a decomposed child is filed under, and the vector that evidence was measured
// against — keyed by the child's RAW url (what `createChild` still holds before F8
// normalization, and what the classifier and the embedder were keyed on).
type ChildFiling = { filing: FilingDecision; vector: number[] | null };

// One classifier call per chunk of children. Two reasons this is chunked rather than one
// call per container: `topicClassifier`'s output budget is spent on thinking first and
// the results array scales with the batch (the canonicalizer's 8k lesson), and a
// container may legitimately hold DECOMPOSITION_MAX_AUTO_CHILDREN=50 leaves per node
// plus nested descendants. A truncated response is not a loud failure here — it is a
// silent map miss, which degrades each affected child straight back to the parent's
// topic, i.e. back to the exact defect this block removes, and it would do so worst on
// the biggest containers (the motivating 45-leaf Khan unit).
const CLASSIFY_CHUNK = 25;

// Q4: file a container's whole child subtree on each child's OWN content, gated by the
// unchanged T2b guardrail, instead of copying the parent's filing down the tree.
//
// The parent's topic plays the role a discovery's REQUEST TOPIC plays for a top-level
// find, and it plays it in all three places that expects: the classifier's `fallback`
// (what the model returns when nothing fits — see applyParentPrior's header for why
// naming it there is safe), `decideFiling`'s `requestTopic` (the degradation target), and
// the prior itself. Those three must be the same topic or a child's degradation path
// stops agreeing with its filing path.
//
// Every step runs BEFORE the insert transaction opens: these are LLM and embedding
// network calls, and `decideFiling`'s evidence must be a SNAPSHOT taken before the first
// child lands. Filing them one at a time inside the transaction would let each inserted
// child become a neighbour of the ones after it — a 45-leaf container would bootstrap
// its own evidence and manufacture the very consensus the guardrail is supposed to test
// (measured on the discovery batch path 2026-07-25).
//
// The vectors are returned, not discarded: the children are about to be embedded
// post-commit anyway, so writing the same vector inside the transaction costs nothing
// extra and lands the row already embedded (the parent's T2a argument, one level down).
//
// Degrades exactly like the parent path. A classifier failure is an empty proposal list,
// an embed failure is a null vector and an empty neighbourhood; both reach `decideFiling`
// as `no-evidence`, which files the child under the parent's topic — contested, so the
// uncertainty is visible and T4's reclassifier revisits it — rather than dropping it.
// A child is never left without a membership, which post-T1 would make it unretrievable.
async function fileChildren(
  children: ChildInput[],
  parentTopic: string,
): Promise<Map<string, ChildFiling>> {
  const nodes = flattenChildren(children);
  const byUrl = new Map<string, ChildFiling>();
  if (nodes.length === 0) return byUrl;

  const vocabulary = await listCanonicals();
  const [proposalsByUrl, vectors] = await Promise.all([
    classifyChunked(nodes, vocabulary, parentTopic),
    safeEmbedBatch(
      nodes.map((n) => ({
        title: n.title,
        summary: n.summary,
        conceptsTaught: n.conceptsTaught,
      })),
    ),
  ]);

  const pools = await topicPools();
  let offParent = 0;
  for (const [i, node] of nodes.entries()) {
    const vector = vectors[i] ?? null;
    // Sequential rather than Promise.all: a large container would otherwise fire 50+
    // concurrent pgvector queries at a pooled client, and each one is a single indexed
    // lookup.
    const neighbourTopics = vector ? await knnNeighbourTopics(vector) : [];
    const filing = decideFilingWithParentPrior({
      proposals: proposalsByUrl.get(node.url)?.topics ?? [],
      requestTopic: parentTopic,
      neighbourTopics,
      pools,
    });
    if (filing.primary.topic !== parentTopic) offParent += 1;
    byUrl.set(node.url, { filing, vector });
  }

  log('upsert-resource.children-filed', {
    parentTopic,
    children: nodes.length,
    offParent,
    contested: [...byUrl.values()].filter((c) => c.filing.primary.contested).length,
  });
  return byUrl;
}

async function classifyChunked(
  nodes: ChildInput[],
  vocabulary: string[],
  parentTopic: string,
): Promise<Map<string, TopicProposal>> {
  const merged = new Map<string, TopicProposal>();
  for (let i = 0; i < nodes.length; i += CLASSIFY_CHUNK) {
    const chunk = nodes.slice(i, i + CLASSIFY_CHUNK).map((n) => ({
      url: n.url,
      title: n.title,
      summary: n.summary,
      conceptsTaught: n.conceptsTaught,
    }));
    const proposals = await classifyDiscoveryTopics(chunk, vocabulary, parentTopic);
    for (const [url, proposal] of proposals) merged.set(url, proposal);
  }
  return merged;
}

// The whole subtree, depth-first — a doc-TOC container can nest containers, and a nested
// container is filed on its own content too: it is the row every leaf under it would
// otherwise have inherited from.
function flattenChildren(children: ChildInput[]): ChildInput[] {
  return children.flatMap((c) => [c, ...flattenChildren(c.children ?? [])]);
}

// ── topic filing (T2b) ───────────────────────────────────────────────────────

// Q2: run a duration claim past the plausibility gate before it is persisted. A
// rejected claim costs the NUMBER, never the resource — the row is written with a
// null duration and `unknown` provenance, which is what the failed claim actually
// meant. The warning is the operator's signal that a supplier is fabricating.
function vettedDuration(
  claim: DurationClaim & { durationSource: DurationSource },
  url: string,
): { durationMin: number | null; durationSource: DurationSource } {
  const verdict = checkDuration(claim);
  if (verdict.ok) return { durationMin: claim.durationMin, durationSource: claim.durationSource };
  logWarn('upsert-resource.duration_rejected', {
    url,
    type: claim.type,
    durationMin: claim.durationMin,
    durationSource: claim.durationSource,
    reason: verdict.reason,
  });
  return { durationMin: null, durationSource: 'unknown' };
}

// What a caller that gathered no evidence gets: the topic it asked for, filed as
// `discovery` — which is exactly that origin's definition ("request topic; classifier
// skipped or unavailable"). relevance 1.0 here means UNKNOWN, not certain, the same
// convention T1's backfill used for `inherited`; any future minRelevance must stay
// origin-aware around it (see the ResourceTopic model comment).
function defaultFiling(topic: string): FilingDecision {
  return {
    primary: { topic, relevance: 1.0, origin: 'discovery', contested: false },
    secondaries: [],
    reason: 'no-evidence',
  };
}

// The primary goes through setPrimaryTopic — the ONE seam allowed to write `isPrimary`
// and the Resource.topic mirror — enlisted in this transaction so the row, its
// memberships and its mirror commit together. Secondaries are plain inserts (they touch
// neither field). skipDuplicates because a proposal can repeat the primary's topic.
async function writeMemberships(
  tx: TxClient,
  resourceId: string,
  filing: FilingDecision,
): Promise<void> {
  await setPrimaryTopic(resourceId, filing.primary.topic, {
    tx,
    relevance: filing.primary.relevance,
    origin: filing.primary.origin,
    contested: filing.primary.contested,
  });

  const secondaries = filing.secondaries
    .filter((s) => s.topic !== filing.primary.topic)
    .slice(0, MAX_MEMBERSHIPS - 1);
  if (secondaries.length === 0) return;

  await tx.resourceTopic.createMany({
    data: secondaries.map((s) => ({
      resourceId,
      topic: s.topic,
      relevance: s.relevance,
      origin: s.origin,
      contested: s.contested,
      isPrimary: false,
    })),
    skipDuplicates: true,
  });
}

// ── source + slug helpers (moved from web-fallback.ts) ───────────────────────

async function resolveSource(url: string): Promise<{ id: string; trustScore: number }> {
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return loadWebSource();
  }
  const candidates = await prisma.source.findMany({ select: { id: true, url: true, trustScore: true } });
  for (const s of candidates) {
    try {
      const sHost = new URL(s.url).hostname.replace(/^www\./, '');
      if (sHost && (sHost === host || host.endsWith('.' + sHost))) {
        return { id: s.id, trustScore: s.trustScore };
      }
    } catch {
      // Skip sources with non-URL `url` (the 'web' blanket row has url='https://').
    }
  }
  return loadWebSource();
}

async function loadWebSource(): Promise<{ id: string; trustScore: number }> {
  const web = await prisma.source.upsert({
    where: { slug: 'web' },
    update: {},
    create: { slug: 'web', name: 'Open web (agent-discovered)', url: 'https://', kind: 'community', trustScore: 0.4 },
    select: { id: true, trustScore: true },
  });
  return web;
}

// Phase 2.5h: resolve a YouTube video's Source by CHANNEL, not hostname. A seeded
// channel (3Blue1Brown, StatQuest, …) carries its trust prior; an unseeded channel
// falls back to the neutral `youtube` row (known platform, unvetted channel) so the
// engagement signal does the discriminating. This is the fix for the old collision
// where every youtube.com URL matched whichever channel row resolveSource hit first.
async function resolveYouTubeSource(channelId: string): Promise<{ id: string; trustScore: number }> {
  const byChannel = await prisma.source.findUnique({
    where: { youtubeChannelId: channelId },
    select: { id: true, trustScore: true },
  });
  if (byChannel) return byChannel;
  const youtube = await prisma.source.upsert({
    where: { slug: 'youtube' },
    update: {},
    create: { slug: 'youtube', name: 'YouTube (unseeded channel)', url: 'https://www.youtube.com', kind: 'community', trustScore: 0.5 },
    select: { id: true, trustScore: true },
  });
  return youtube;
}

// `taken` tracks slugs minted earlier in the same transaction (parent +
// siblings) that aren't yet visible to a DB lookup, so a playlist of
// similarly-titled videos can't collide on slug within one commit.
async function uniqueSlug(
  tx: TxClient,
  title: string,
  url: string,
  taken: Set<string>,
): Promise<string> {
  const base =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'resource';

  let hash = 0;
  for (let i = 0; i < url.length; i++) hash = (hash * 31 + url.charCodeAt(i)) | 0;
  const suffixed = `${base}-${(hash >>> 0).toString(36).slice(0, 6)}`;

  const candidate =
    !taken.has(base) && !(await slugExists(tx, base)) ? base : suffixed;
  taken.add(candidate);
  return candidate;
}

async function slugExists(tx: TxClient, slug: string): Promise<boolean> {
  const row = await tx.resource.findUnique({ where: { slug }, select: { id: true } });
  return Boolean(row);
}
