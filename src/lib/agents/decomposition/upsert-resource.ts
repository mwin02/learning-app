// Phase 2.5b — shared Resource upsert (parent + decomposed children).
//
// Extracted from web-fallback.ts so discovery and the seed-backfill script
// (2.5b-4) write resources through one path (ROADMAP 2.5b decision #6). Given a
// resource and the result of decompose(), it persists the parent with the
// right decompositionStatus and, when a router produced children, the atomic
// children — parent + children in a single transaction. Embeddings are written
// after commit (they reference the freshly-created ids).
//
// Children inherit topic / sourceId / trustScore / language from the parent;
// only the parent's source is resolved. Child concepts are already per-child
// (derived + canonicalized by the router, decision A) by the time they reach
// here.

import { prisma } from '@/lib/db';
import { safeEmbedResource } from '@/lib/ai/embeddings';
import type { PrismaClient, ResourceType, Difficulty, DecompositionStatus } from '@prisma/client';
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
};

export type UpsertOutcome = 'inserted' | 'skipped';

type TxClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

// Rows queued for embed-on-insert once the transaction commits.
type EmbedTask = { id: string; title: string; summary: string; conceptsTaught: string[] };

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
    return 'skipped';
  }

  const source = await resolveSource(resource.url);
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
          origin: 'agent',
          status: 'pending_review',
          trustScore: source.trustScore,
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
          title: resource.title,
          summary: resource.summary,
          conceptsTaught: resource.conceptsTaught,
        });
      }

      for (const child of decomposition.children) {
        const childId = await createChild(tx, {
          topic,
          parentId: parent.id,
          sourceId: source.id,
          trustScore: source.trustScore,
          child,
          taken,
        });
        if (childId) {
          embedTasks.push({
            id: childId,
            title: child.title,
            summary: child.summary,
            conceptsTaught: child.conceptsTaught,
          });
        }
      }
    });
  } catch (err) {
    console.log('[upsert-resource] transaction failed', {
      url: resource.url,
      error: (err as Error).message,
    });
    return 'skipped';
  }

  // Best-effort embeds, post-commit: a failure logs but leaves the row in place
  // for the next backfill (embeddedAt < updatedAt).
  for (const t of embedTasks) {
    await safeEmbedResource(t.id, {
      title: t.title,
      summary: t.summary,
      conceptsTaught: t.conceptsTaught,
    });
  }

  return 'inserted';
}

// Apply a decomposition to an ALREADY-EXISTING resource (the seed-backfill case,
// 2.5b-4) — the parent row already exists, unlike the discovery path which
// creates it. Updates the parent's decompositionStatus and, for a 'decomposed'
// result, creates the children through the same createChild path (slug, source/
// trust inheritance, URL-collision skip, post-commit embed). Idempotent on
// re-run: children whose URL already exists are skipped.
export async function decomposeExisting(
  resourceId: string,
  decomposition: DecompositionResult,
): Promise<{ status: DecompositionResult['status']; childrenCreated: number }> {
  const existing = await prisma.resource.findUnique({
    where: { id: resourceId },
    select: {
      topic: true,
      sourceId: true,
      trustScore: true,
      title: true,
      summary: true,
      conceptsTaught: true,
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
        title: existing.title,
        summary: existing.summary,
        conceptsTaught: existing.conceptsTaught,
      });
    }
    for (const child of decomposition.children) {
      const childId = await createChild(tx, {
        topic: existing.topic,
        parentId: resourceId,
        sourceId: existing.sourceId,
        trustScore: existing.trustScore,
        child,
        taken,
      });
      if (childId) {
        childrenCreated++;
        embedTasks.push({ id: childId, title: child.title, summary: child.summary, conceptsTaught: child.conceptsTaught });
      }
    }
    // Raise the interactive-transaction timeout well above Prisma's 5s default:
    // a manual (or forced) decomposition is un-gated, so a large SPA course can
    // create 100+ children, and each child is a few round-trips to a remote DB.
    // This is a rare admin curation op, so holding the connection ~tens of
    // seconds for an atomic all-or-nothing insert is the right trade.
  }, { maxWait: 10_000, timeout: 120_000 });

  for (const t of embedTasks) {
    await safeEmbedResource(t.id, { title: t.title, summary: t.summary, conceptsTaught: t.conceptsTaught });
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
    select: { title: true, summary: true, conceptsTaught: true },
  });
  if (row) {
    await safeEmbedResource(resourceId, {
      title: row.title,
      summary: row.summary,
      conceptsTaught: row.conceptsTaught,
    });
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

// Create one atomic child of a decomposed container. Skips (returns null) if the
// child URL already exists as a standalone resource — a video can appear both
// as a seeded single and inside a playlist; we keep the first and don't dupe.
async function createChild(
  tx: TxClient,
  args: {
    topic: string;
    parentId: string;
    sourceId: string;
    trustScore: number;
    child: ChildInput;
    taken: Set<string>;
  },
): Promise<string | null> {
  const { topic, parentId, sourceId, trustScore, child, taken } = args;

  const clash = await tx.resource.findUnique({
    where: { url: child.url },
    select: { id: true },
  });
  if (clash) {
    console.log('[upsert-resource] skip existing child URL', { url: child.url, parentId });
    return null;
  }

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
      status: 'pending_review',
      trustScore,
      sourceId,
      parentResourceId: parentId,
      orderInParent: child.orderInParent,
      decompositionStatus: 'atomic',
    },
    select: { id: true },
  });
  return created.id;
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
