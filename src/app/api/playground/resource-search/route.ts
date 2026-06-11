// GET /api/playground/resource-search — JSON resource search for the inspector's
// attach-resource picker (2.5d-7c). The /playground/resource page does the same
// search but as a server component reading searchParams; the attach picker is a
// client control that needs a fetch()-able endpoint, so this exposes the same
// searchResources primitive over HTTP.
//
// Admin/operator-gated via withAdminAuth (NOT user-auth) like the rest of the
// playground curation surface. Returns ONLY pickable candidates — active + atomic
// (statuses=['active'], pickableOnly) — because that's exactly what
// attach_resource will accept (the map-edit API rejects a non-pickable resource).
// Searching the concept's topic ∪ its related topics mirrors candidate-attachment
// (attach-candidates.ts), so e.g. a javascript-react map surfaces javascript rows.
//
// Query params: q (free-text intent, optional), topic (required — the Path's
// canonical topic), limit (optional, ≤ MAP_RESOURCE_PICKER_LIMIT).

import { withAdminAuth } from '@/lib/api/with-admin-auth';
import { searchResources } from '@/lib/agents/tools/search-resources';
import { relatedTopics } from '@/types/resource';
import { MAP_RESOURCE_PICKER_LIMIT } from '@/lib/config';

// searchResources hits Vertex embeddings (Node, not Edge) on the ranked path.
export const runtime = 'nodejs';

export const GET = withAdminAuth(async (req) => {
  const url = new URL(req.url);
  const query = url.searchParams.get('q')?.trim() || undefined;
  const topic = url.searchParams.get('topic')?.trim();
  if (!topic) {
    return Response.json({ error: 'topic is required.' }, { status: 400 });
  }
  const rawLimit = Number(url.searchParams.get('limit'));
  const limit = Math.min(
    MAP_RESOURCE_PICKER_LIMIT,
    Math.max(1, Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : MAP_RESOURCE_PICKER_LIMIT),
  );

  const results = await searchResources({
    query,
    topics: relatedTopics(topic),
    statuses: ['active'],
    pickableOnly: true,
    limit,
  });

  // Trim the wire payload to what the picker renders.
  return Response.json({
    results: results.map((r) => ({
      id: r.id,
      title: r.title,
      url: r.url,
      type: r.type,
      difficulty: r.difficulty,
      topic: r.topic,
      conceptsTaught: r.conceptsTaught,
    })),
  });
});
