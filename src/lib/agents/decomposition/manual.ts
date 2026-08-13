// Phase 2.5b-8 — manual decomposition router.
//
// The third source of an ordered child list, alongside the YouTube (API) and
// doc-TOC (HTML scrape) routers. Here the list is supplied by a human or a
// browser agent — the escape hatch for SPA containers (Khan Academy, etc.) whose
// lessons are client-rendered and so invisible to the scrape-based routers, yet
// which are real multi-lesson courses that must NOT be kept whole as atomic.
//
// Like the other routers it only produces a plan: it maps the supplied items to
// ChildInput[] (deriving each child's own concepts via concepts.ts, decision A)
// and the caller persists via decomposeExisting(). url + title are required per
// item; the rest is defaulted here:
//   type        — inferred from the URL (YouTube → video, else article)
//   difficulty  — inherited from the parent (children always inherit)
//   order       — the supplied list order (the human/agent vouches for it)
// There is no oversize gate: a hand-supplied list is vouched by construction.
//
// durationMin is NOT defaulted (library-quality Q2). It used to fall back to 20 —
// described here as deliberate parity with doc-TOC — and since this is the route
// every SPA container takes, that constant was the library's single largest source
// of placeholder durations: no estimate was ever attempted for 879 Khan Academy
// rows. The supplier is looking at the rendered page, which is the one context
// where the real number is free, so a supplied duration is `extracted` and an
// omitted one is null + `unknown`. Never invent one here.

import { deriveChildConcepts, resolveConcepts } from './concepts';
import type { ChildInput } from './decompose';
import type { ManualChildInput } from '@/lib/api/decomposition-review-schema';

const YOUTUBE_HOSTS = new Set(['youtube.com', 'm.youtube.com', 'youtu.be']);

// YouTube links are videos; everything else defaults to article. Mirrors the
// router's host list; kept local to avoid coupling to classify()'s plan shape.
function inferType(url: string): 'video' | 'article' {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return YOUTUBE_HOSTS.has(host) ? 'video' : 'article';
  } catch {
    return 'article';
  }
}

export async function decomposeManual(args: {
  items: ManualChildInput[];
  topic: string;
  difficulty: string;
  parentConcepts: string[];
}): Promise<{ children: ChildInput[] }> {
  const { items, topic, difficulty, parentConcepts } = args;

  const concepts = await deriveChildConcepts({
    topic,
    parentConcepts,
    items: items.map((it) => ({ ref: it.url, title: it.title, description: it.summary ?? '' })),
  });

  const children: ChildInput[] = items.map((it, idx) => ({
    url: it.url,
    title: it.title,
    type: it.type ?? inferType(it.url),
    difficulty,
    durationMin: it.durationMin ?? null,
    durationSource: it.durationMin == null ? 'unknown' : 'extracted',
    summary: it.summary?.trim() || it.title,
    ...resolveConcepts({ derived: concepts.get(it.url), parentConcepts, topic }),
    orderInParent: idx,
  }));

  return { children };
}
