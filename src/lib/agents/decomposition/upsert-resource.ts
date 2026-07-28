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
// Children inherit topic / sourceId / trustScore / language from the parent;
// only the parent's source is resolved. Child concepts are already per-child
// (derived + canonicalized by the router, decision A) by the time they reach
// here.

import { prisma } from '@/lib/db';
import { safeEmbedResource, storeEmbedding } from '@/lib/ai/embeddings';
import { setPrimaryTopic } from '@/lib/curation/resource-topics';
import { MAX_MEMBERSHIPS, type FilingDecision } from '@/lib/curation/topic-knn';
import { safeClassifyAndPersist } from '@/lib/curation/embeddability';
import { computeTrustScore } from '@/lib/curation/trust-score';
import { youtubeEngagementSignal } from '@/lib/curation/youtube-signal';
import { normalizeResourceUrl } from './normalize-url';
import type { PrismaClient, ResourceType, Difficulty, DecompositionStatus, ResourceStatus } from '@prisma/client';
import type { DecompositionResult, ChildInput } from './decompose';

export type UpsertResourceInput = {
  url: string;
  title: string;
  type: string;
  difficulty: string;
  durationMin: number;
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
export type UpsertOutcome = {
  outcome: 'inserted' | 'skipped';
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
    if (existing.topic !== topic) {
      console.log('[upsert-resource] skip cross-topic URL collision', {
        url,
        existingTopic: existing.topic,
        requestedTopic: topic,
      });
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
          durationMin: resource.durationMin,
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
      const decision = filing ?? defaultFiling(topic);
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

  await prisma.$transaction(async (tx) => {
    await tx.resource.update({
      where: { id: resourceId },
      data: { decompositionStatus: decomposition.status },
    });
    // A reroute to 'atomic' (e.g. doc-TOC single_lesson/reference_index) makes
    // the parent itself pickable — embed it, or searchResources under-ranks it.
    // A 'decomposed' parent stays an unpickable container (children only).
    if (decomposition.status === 'atomic') {
      embedTasks.push({
        id: resourceId,
        url: existing.url,
        title: existing.title,
        summary: existing.summary,
        conceptsTaught: existing.conceptsTaught,
      });
    }
    for (const child of decomposition.children) {
      childrenCreated += await createChild(tx, {
        topic: existing.topic,
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
    await safeEmbedResource(t.id, { title: t.title, summary: t.summary, conceptsTaught: t.conceptsTaught });
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
    // T2b: the parent's filing, inherited whole. A container's children are by
    // construction the same subject as the container, and post-T2a the container itself
    // was embedded and guardrail-checked — so the evidence backing this membership was
    // tested at the granularity where the motivating mis-filing actually occurred.
    // Per-child classification stays out of scope. Absent for decomposeExisting, whose
    // parent's filing predates T2b; children then inherit the parent's topic as a plain
    // `discovery` membership, which is still what makes them retrievable at all.
    filing?: FilingDecision;
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
  const slug = await uniqueSlug(tx, child.title, url, taken);
  const created = await tx.resource.create({
    data: {
      slug,
      topic,
      title: child.title,
      url,
      type: child.type as ResourceType,
      durationMin: child.durationMin,
      summary: child.summary,
      difficulty: child.difficulty as Difficulty,
      prerequisiteConcepts: child.prerequisiteConcepts,
      conceptsTaught: child.conceptsTaught,
      origin: 'agent',
      status: childStatus,
      trustScore,
      sourceId,
      parentResourceId: parentId,
      orderInParent: child.orderInParent,
      decompositionStatus: decompStatus,
    },
    select: { id: true },
  });

  // T2b: children are the pickable leaves, so a missing membership costs MORE here than
  // on the container — it makes the whole decomposition unretrievable. Secondaries are
  // inherited too: they were tested against the container's embedding, which is the
  // subject the children share.
  await writeMemberships(tx, created.id, args.filing ?? defaultFiling(topic));

  // Only atomic leaves are pickable, so only they are embedded.
  if (decompStatus === 'atomic') {
    embedTasks.push({
      id: created.id,
      url,
      title: child.title,
      summary: child.summary,
      conceptsTaught: child.conceptsTaught,
    });
  }

  let count = 1;
  for (const grandchild of child.children ?? []) {
    count += await createChild(tx, {
      topic,
      filing: args.filing,
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

// ── topic filing (T2b) ───────────────────────────────────────────────────────

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
