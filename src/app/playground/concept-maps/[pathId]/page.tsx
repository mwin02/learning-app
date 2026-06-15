import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ConceptResourceRole } from '@prisma/client';
import { prisma } from '@/lib/db';
import { isDevAuthEnabled } from '@/lib/dev-auth';
import { MAP_SPINE_MIN_PRIMARY_COVERAGE } from '@/lib/config';
import { layerBySlug } from '@/lib/agents/map/order';
import { STATUS_STYLE } from '../status-style';
import { ConceptActions } from './concept-actions';
import { ResourceActions } from './resource-actions';
import { AddConceptForm } from './add-concept-form';
import { PrereqActions } from './prereq-actions';
import { AttachResource } from './attach-resource';

export const dynamic = 'force-dynamic';

const ROLE_STYLE: Record<string, string> = {
  teaches: 'bg-green-100 text-green-800',
  uses: 'bg-gray-100 text-gray-700',
  assesses: 'bg-blue-100 text-blue-800',
};

// Phase 2.5d-5: render one concept map — its spine DAG (topo-layered) and each
// concept's candidate resources with role + coverage, flagging spine holes (a
// spine concept with no qualifying `teaches` primary). Read-only.
export default async function ConceptMapDetailPage({
  params,
}: {
  params: Promise<{ pathId: string }>;
}) {
  if (!isDevAuthEnabled()) notFound();
  const { pathId } = await params;

  const path = await prisma.path.findUnique({
    where: { id: pathId },
    select: {
      id: true,
      topic: true,
      status: true,
      updatedAt: true,
      concepts: {
        select: {
          id: true,
          slug: true,
          title: true,
          membership: true,
          resources: {
            select: {
              role: true,
              coverageScore: true,
              resource: { select: { id: true, title: true, url: true, type: true } },
            },
            orderBy: { coverageScore: 'desc' },
          },
          // Incoming edges: `from` is a prerequisite of this concept. `id` feeds
          // the per-edge remove + the add-prereq picker's exclusion set (2.5d-7b).
          prereqsIn: { select: { from: { select: { id: true, slug: true, title: true, membership: true } } } },
        },
        orderBy: { slug: 'asc' },
      },
    },
  });
  if (!path) notFound();

  const concepts = path.concepts;

  // Longest-path layering over the prereq DAG (shared with the Track builder's
  // linearization, src/lib/agents/map/order.ts). Edges come from each concept's
  // incoming prereqs: `from` is a prerequisite of the concept it points at.
  const edges = concepts.flatMap((c) =>
    c.prereqsIn.map((e) => ({ fromSlug: e.from.slug, toSlug: c.slug })),
  );
  const layerOfSlug = layerBySlug(concepts, edges);

  const layered = new Map<number, typeof concepts>();
  for (const c of concepts) {
    const l = layerOfSlug.get(c.slug) ?? 0;
    if (!layered.has(l)) layered.set(l, []);
    layered.get(l)!.push(c);
  }
  const layers = [...layered.keys()].sort((a, b) => a - b);

  const hasPrimary = (c: (typeof concepts)[number]) =>
    c.resources.some(
      (r) => r.role === ConceptResourceRole.teaches && r.coverageScore >= MAP_SPINE_MIN_PRIMARY_COVERAGE,
    );
  const holes = concepts.filter((c) => c.membership === 'spine' && !hasPrimary(c));
  // Spine-containment warning (2.5d-7c): spine concepts with a frontier prerequisite.
  // The spine must stay downward-closed, so the Track builder can trim unselected
  // frontier nodes without orphaning a spine concept. The map-edit API hard-blocks
  // creating such an edge directly, but a membership flip can reach it; surface it
  // here as a non-blocking warning. Mirrors frontierGatedSpine on the server.
  const frontierGated = concepts.filter(
    (c) => c.membership === 'spine' && c.prereqsIn.some((e) => e.from.membership === 'frontier'),
  );
  const style = STATUS_STYLE[path.status] ?? 'bg-gray-100 text-gray-700';
  // The full concept list feeds the add-prereq picker (which other concepts a
  // given concept can depend on). `membership` lets the picker exclude frontier
  // options for a spine concept (spine prerequisites must stay spine).
  const allConcepts = concepts.map((c) => ({ id: c.id, title: c.title, membership: c.membership }));

  return (
    <main className="p-6 flex flex-col gap-6">
      <section>
        <Link href="/playground/concept-maps" className="text-sm text-gray-600 underline">
          ← All concept maps
        </Link>
        <h1 className="text-2xl font-bold mt-2 flex items-center gap-3">
          {path.topic}
          <span className={`rounded px-2 py-0.5 text-xs font-medium ${style}`}>{path.status}</span>
        </h1>
        <p className="text-sm text-gray-600 mt-1">
          {concepts.length} concepts · {layers.length} prerequisite layers ·{' '}
          {holes.length > 0 ? (
            <span className="text-amber-700 font-medium">
              {holes.length} spine hole{holes.length === 1 ? '' : 's'}:{' '}
              {holes.map((h) => h.slug).join(', ')}
            </span>
          ) : (
            <span className="text-green-700 font-medium">no spine holes</span>
          )}
        </p>
        {frontierGated.length > 0 && (
          <p className="text-sm text-amber-700 font-medium mt-1">
            ⚠ {frontierGated.length} spine concept{frontierGated.length === 1 ? '' : 's'} with a
            frontier prerequisite: {frontierGated.map((c) => c.slug).join(', ')} — promote the
            prerequisite to spine, or the Track builder will orphan it.
          </p>
        )}
        <div className="mt-3">
          <AddConceptForm pathId={path.id} />
        </div>
      </section>

      {layers.map((layer) => (
        <section key={layer}>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">
            Layer {layer}
          </h2>
          <ul className="flex flex-col gap-3">
            {layered.get(layer)!.map((c) => {
              const hole = c.membership === 'spine' && !hasPrimary(c);
              return (
                <li
                  key={c.id}
                  className={`border rounded p-3 ${hole ? 'border-amber-400 bg-amber-50' : ''}`}
                >
                  <div className="flex items-center gap-2 text-sm">
                    <span className="font-medium">{c.title}</span>
                    <code className="text-xs text-gray-500">{c.slug}</code>
                    <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-600">
                      {c.membership}
                    </span>
                    {hole && (
                      <span className="rounded bg-amber-200 px-1.5 py-0.5 text-xs font-medium text-amber-900">
                        spine hole — no teaches ≥ {MAP_SPINE_MIN_PRIMARY_COVERAGE}
                      </span>
                    )}
                  </div>

                  <PrereqActions
                    conceptId={c.id}
                    membership={c.membership}
                    prereqs={c.prereqsIn.map((e) => ({ id: e.from.id, title: e.from.title }))}
                    allConcepts={allConcepts}
                  />

                  <ConceptActions
                    conceptId={c.id}
                    title={c.title}
                    membership={c.membership}
                  />

                  {c.resources.length === 0 ? (
                    <div className="text-xs text-gray-400 mt-2">no candidate resources</div>
                  ) : (
                    <ul className="mt-2 flex flex-col gap-1">
                      {c.resources.map((r, i) => {
                        const isPrimary =
                          r.role === ConceptResourceRole.teaches &&
                          r.coverageScore >= MAP_SPINE_MIN_PRIMARY_COVERAGE &&
                          // first qualifying teaches (sorted by coverage desc) is the primary
                          c.resources.findIndex(
                            (x) =>
                              x.role === ConceptResourceRole.teaches &&
                              x.coverageScore >= MAP_SPINE_MIN_PRIMARY_COVERAGE,
                          ) === i;
                        return (
                          <li key={r.resource.id} className="flex items-center gap-2 text-xs">
                            <span
                              className={`rounded px-1.5 py-0.5 font-medium ${ROLE_STYLE[r.role] ?? ''}`}
                            >
                              {r.role}
                            </span>
                            <span className="tabular-nums text-gray-500">
                              {r.coverageScore.toFixed(2)}
                            </span>
                            {isPrimary && (
                              <span className="rounded bg-green-600 px-1.5 py-0.5 text-white">
                                primary
                              </span>
                            )}
                            <a
                              href={r.resource.url}
                              target="_blank"
                              rel="noreferrer"
                              className="underline truncate"
                            >
                              {r.resource.title}
                            </a>
                            <span className="text-gray-400">{r.resource.type}</span>
                            <ResourceActions
                              conceptId={c.id}
                              resourceId={r.resource.id}
                              role={r.role}
                              coverageScore={r.coverageScore}
                            />
                          </li>
                        );
                      })}
                    </ul>
                  )}

                  <div className="mt-2">
                    <AttachResource conceptId={c.id} conceptTitle={c.title} topic={path.topic} />
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </main>
  );
}
