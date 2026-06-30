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
import { safeEmbedResource } from '@/lib/ai/embeddings';
import { safeClassifyAndPersist } from '@/lib/curation/embeddability';
import { computeTrustScore } from '@/lib/curation/trust-score';
import { youtubeEngagementSignal } from '@/lib/curation/youtube-signal';
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
export type UpsertOutcome = { outcome: 'inserted' | 'skipped'; atomicIds: string[] };

type TxClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

// Rows queued for post-commit per-resource work (embed + 2.5j embeddability probe)
// once the transaction commits. `url` feeds the embeddability classifier.
type EmbedTask = { id: string; url: string; title: string; summary: string; conceptsTaught: string[] };

export async function upsertResource(
  topic: string,
  resource: UpsertResourceInput,
  decomposition: DecompositionResult,
): Promise<UpsertOutcome> {
  const existing = await prisma.resource.findUnique({
    where: { url: resource.url },
    select: { id: true, topic: true },
  });
  if (existing) {
    if (existing.topic !== topic) {
      console.log('[upsert-resource] skip cross-topic URL collision', {
        url: resource.url,
        existingTopic: existing.topic,
        requestedTopic: topic,
      });
    }
    return { outcome: 'skipped', atomicIds: [] };
  }

  // YouTube videos resolve their Source by channelId (hostname can't tell channels
  // apart); everything else by URL host. Then compose trustScore through the single
  // seam: a YouTube video carries an engagement EvidenceSignal so its trust reflects
  // its own reception; other resources have no signal and rest on the source prior.
  const source = resource.youtube
    ? await resolveYouTubeSource(resource.youtube.channelId)
    : await resolveSource(resource.url);
  const engagement = resource.youtube ? youtubeEngagementSignal(resource.youtube) : null;
  const sourceTrust = computeTrustScore({
    base: source.trustScore,
    signals: engagement ? [engagement] : [],
  });
  const taken = new Set<string>();
  const embedTasks: EmbedTask[] = [];

  try {
    await prisma.$transaction(async (tx) => {
      const parentSlug = await uniqueSlug(tx, resource.title, resource.url, taken);
      const parent = await tx.resource.create({
        data: {
          slug: parentSlug,
          topic,
          title: resource.title,
          url: resource.url,
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
      // A decomposed container is the unpickable parent; an atomic resource has
      // no children. Either way the parent itself is only embedded when it can
      // be picked (atomic) — embedding an unpickable container wastes a call.
      if (decomposition.status === 'atomic') {
        embedTasks.push({
          id: parent.id,
          url: resource.url,
          title: resource.title,
          summary: resource.summary,
          conceptsTaught: resource.conceptsTaught,
        });
      }

      for (const child of decomposition.children) {
        await createChild(tx, {
          topic,
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
    });
  } catch (err) {
    console.log('[upsert-resource] transaction failed', {
      url: resource.url,
      error: (err as Error).message,
    });
    return { outcome: 'skipped', atomicIds: [] };
  }

  // Best-effort embeds, post-commit: a failure logs but leaves the row in place
  // for the next backfill (embeddedAt < updatedAt). embedTasks are exactly the
  // atomic (pickable) ids created above. Phase 2.5j: classify embeddability over
  // the same pickable set (only resources that reach a Lesson need a deliveryMode);
  // also best-effort, retried by the backfill on `embedCheckedAt IS NULL`.
  for (const t of embedTasks) {
    await safeEmbedResource(t.id, {
      title: t.title,
      summary: t.summary,
      conceptsTaught: t.conceptsTaught,
    });
    await safeClassifyAndPersist(t.id, t.url);
  }

  return { outcome: 'inserted', atomicIds: embedTasks.map((t) => t.id) };
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
  },
): Promise<number> {
  const { topic, parentId, sourceId, trustScore, childStatus, child, taken, embedTasks } = args;

  const clash = await tx.resource.findUnique({
    where: { url: child.url },
    select: { id: true },
  });
  if (clash) {
    console.log('[upsert-resource] skip existing child URL', { url: child.url, parentId });
    return 0;
  }

  const decompStatus: DecompositionStatus = child.decompositionStatus ?? 'atomic';
  const slug = await uniqueSlug(tx, child.title, child.url, taken);
  const created = await tx.resource.create({
    data: {
      slug,
      topic,
      title: child.title,
      url: child.url,
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

  // Only atomic leaves are pickable, so only they are embedded.
  if (decompStatus === 'atomic') {
    embedTasks.push({
      id: created.id,
      url: child.url,
      title: child.title,
      summary: child.summary,
      conceptsTaught: child.conceptsTaught,
    });
  }

  let count = 1;
  for (const grandchild of child.children ?? []) {
    count += await createChild(tx, {
      topic,
      parentId: created.id,
      sourceId,
      trustScore,
      childStatus,
      child: grandchild,
      taken,
      embedTasks,
    });
  }
  return count;
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
