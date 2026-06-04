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
import type { PrismaClient, ResourceType, Difficulty } from '@prisma/client';
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
