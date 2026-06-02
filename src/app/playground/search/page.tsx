import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@/lib/db';
import { isDevAuthEnabled } from '@/lib/dev-auth';
import { searchResources } from '@/lib/agents/tools/search-resources';
import { SEARCH_RANK_THRESHOLD } from '@/lib/config';
import type { Difficulty } from '@prisma/client';

export const dynamic = 'force-dynamic';

const DIFFICULTIES = ['beginner', 'intermediate', 'advanced'] as const;

function coerceDifficulty(raw: string | undefined): Difficulty | undefined {
  return (DIFFICULTIES as readonly string[]).includes(raw ?? '')
    ? (raw as Difficulty)
    : undefined;
}

function firstParam(v: string | string[] | undefined): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  return s?.trim() ? s.trim() : undefined;
}

export default async function ResourceSearchPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  if (!isDevAuthEnabled()) notFound();

  const sp = await searchParams;
  const query = firstParam(sp.q);
  const topic = firstParam(sp.topic);
  const difficulty = coerceDifficulty(firstParam(sp.difficulty));
  const limit = Math.min(50, Math.max(1, Number(firstParam(sp.limit)) || 30));

  // Distinct topics for the dropdown.
  const topicRows = await prisma.resource.findMany({
    distinct: ['topic'],
    select: { topic: true },
    orderBy: { topic: 'asc' },
  });
  const topics = topicRows.map((r) => r.topic);

  const results = await searchResources({ query, topic, difficulty, limit });
  const ranked = results.some((r) => r.distance !== null);

  return (
    <main className="p-6 flex flex-col gap-6">
      <section>
        <div className="flex items-center justify-between mb-2">
          <h1 className="text-2xl font-bold">Resource search</h1>
          <Link href="/playground" className="text-sm underline">
            ← back to playground
          </Link>
        </div>
        <p className="text-sm text-gray-600 mb-4">
          Hybrid search over the <code>Resource</code> library (AR-2): structured filters →
          semantic vector rank. A filtered set of ≤ {SEARCH_RANK_THRESHOLD} returns wholesale by
          trust score (no embedding spent); above that, a query ranks by cosine similarity.
        </p>

        <form method="get" className="flex flex-col gap-3 max-w-2xl">
          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium">query (what the resources should cover)</span>
            <input
              name="q"
              type="text"
              defaultValue={query ?? ''}
              placeholder="e.g. intro to derivatives and limits"
              className="border px-2 py-1 rounded"
            />
          </label>

          <div className="flex gap-3">
            <label className="flex flex-col gap-1 flex-1">
              <span className="text-sm font-medium">topic</span>
              <select name="topic" defaultValue={topic ?? ''} className="border px-2 py-1 rounded">
                <option value="">(all topics)</option>
                {topics.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1 flex-1">
              <span className="text-sm font-medium">difficulty</span>
              <select
                name="difficulty"
                defaultValue={difficulty ?? ''}
                className="border px-2 py-1 rounded"
              >
                <option value="">(any)</option>
                {DIFFICULTIES.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1 w-28">
              <span className="text-sm font-medium">limit</span>
              <input
                name="limit"
                type="number"
                min={1}
                max={50}
                defaultValue={limit}
                className="border px-2 py-1 rounded"
              />
            </label>
          </div>

          <button
            type="submit"
            className="border px-4 py-2 rounded bg-black text-white self-start"
          >
            Search
          </button>
        </form>
      </section>

      <section>
        <h2 className="text-xl font-semibold mb-1">
          {results.length} result{results.length === 1 ? '' : 's'}
        </h2>
        <p className="text-sm text-gray-600 mb-3">
          {ranked
            ? 'ranked by semantic similarity (distance shown — lower is closer)'
            : 'fast-path / trust-score order (no query ranking applied)'}
        </p>

        {results.length === 0 ? (
          <p className="text-sm text-gray-600">
            No pickable resources match these filters.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {results.map((r) => (
              <li key={r.id} className="border rounded p-3 text-sm">
                <div className="flex items-baseline gap-2">
                  {r.distance !== null && (
                    <span className="font-mono text-xs bg-gray-100 px-1.5 py-0.5 rounded">
                      {r.distance.toFixed(4)}
                    </span>
                  )}
                  <Link
                    href={`/playground/resource/${r.id}`}
                    className="font-medium underline"
                  >
                    {r.title}
                  </Link>
                </div>
                <div className="text-gray-600 mt-1">
                  <span>{r.type}</span>
                  {' · '}
                  <span>{r.difficulty}</span>
                  {' · '}
                  <span>{r.tier}</span>
                  {' · '}
                  <span>{r.durationMin} min</span>
                  {' · '}
                  <span>trust {r.trustScore.toFixed(2)}</span>
                  {r.requiresPurchase && (
                    <>
                      {' · '}
                      <span className="text-amber-700">paid</span>
                    </>
                  )}
                </div>
                {r.conceptsTaught.length > 0 && (
                  <div className="text-gray-500 text-xs mt-1">
                    teaches: {r.conceptsTaught.join(', ')}
                  </div>
                )}
                <div className="text-gray-400 text-xs mt-1 truncate">
                  <a href={r.url} target="_blank" rel="noreferrer" className="underline">
                    {r.url}
                  </a>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
