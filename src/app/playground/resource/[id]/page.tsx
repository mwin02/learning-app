import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@/lib/db';
import { requireAdminPage } from '@/lib/auth/viewer';

export const dynamic = 'force-dynamic';

export default async function ResourceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireAdminPage();

  const { id } = await params;

  const resource = await prisma.resource.findUnique({
    where: { id },
    include: {
      source: true,
      parent: { select: { id: true, title: true } },
      children: {
        orderBy: { orderInParent: 'asc' },
        select: { id: true, title: true, orderInParent: true, decompositionStatus: true },
      },
    },
  });

  if (!resource) notFound();

  return (
    <main className="p-6 flex flex-col gap-6">
      <div>
        <Link href="/playground/dashboard" className="text-sm underline">
          ← back to dashboard
        </Link>
      </div>

      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold">{resource.title}</h1>
        <a
          href={resource.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm underline break-all"
        >
          {resource.url} ↗
        </a>
      </header>

      <section>
        <h2 className="text-lg font-semibold mb-2">Fields</h2>
        <dl className="text-sm grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
          <dt className="font-medium">id</dt>
          <dd className="font-mono text-xs">{resource.id}</dd>
          <dt className="font-medium">slug</dt>
          <dd>{resource.slug}</dd>
          <dt className="font-medium">topic</dt>
          <dd>{resource.topic}</dd>
          <dt className="font-medium">type</dt>
          <dd>{resource.type}</dd>
          <dt className="font-medium">tier</dt>
          <dd>{resource.tier}</dd>
          <dt className="font-medium">difficulty</dt>
          <dd>{resource.difficulty}</dd>
          <dt className="font-medium">durationMin</dt>
          <dd>{resource.durationMin}</dd>
          <dt className="font-medium">trustScore</dt>
          <dd>{resource.trustScore.toFixed(2)}</dd>
          <dt className="font-medium">origin</dt>
          <dd>{resource.origin}</dd>
          <dt className="font-medium">status</dt>
          <dd>{resource.status}</dd>
          <dt className="font-medium">language</dt>
          <dd>{resource.language}</dd>
          <dt className="font-medium">requiresPurchase</dt>
          <dd>{String(resource.requiresPurchase)}</dd>
          <dt className="font-medium">attribution</dt>
          <dd>{resource.attribution ?? '—'}</dd>
          <dt className="font-medium">decompositionStatus</dt>
          <dd>{resource.decompositionStatus}</dd>
          <dt className="font-medium">orderInParent</dt>
          <dd>{resource.orderInParent ?? '—'}</dd>
          <dt className="font-medium">createdAt</dt>
          <dd>{resource.createdAt.toISOString()}</dd>
        </dl>
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-1">Decomposition</h2>
        <dl className="text-sm grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
          <dt className="font-medium">parent</dt>
          <dd>
            {resource.parent ? (
              <Link href={`/playground/resource/${resource.parent.id}`} className="underline">
                {resource.parent.title}
              </Link>
            ) : (
              '—'
            )}
          </dd>
          <dt className="font-medium">children</dt>
          <dd>
            {resource.children.length === 0 ? (
              '—'
            ) : (
              <ol className="list-decimal pl-5">
                {resource.children.map((c) => (
                  <li key={c.id}>
                    <Link href={`/playground/resource/${c.id}`} className="underline">
                      {c.title}
                    </Link>
                    <span className="text-xs text-gray-500"> ({c.decompositionStatus})</span>
                  </li>
                ))}
              </ol>
            )}
          </dd>
        </dl>
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-1">Summary</h2>
        <p className="text-sm">{resource.summary}</p>
      </section>

      {/* Generated content (origin='generated', e.g. the on-ramp lesson). Plain-text
          rendering — the styled markdown view is the learn UI's job; here we just
          surface the stored body verbatim so an operator can read/verify it. */}
      {resource.content != null && (
        <section>
          <h2 className="text-lg font-semibold mb-1">
            Content ({resource.content.length.toLocaleString()} chars)
          </h2>
          <pre className="text-sm whitespace-pre-wrap font-sans bg-gray-50 border border-gray-200 rounded p-3">
            {resource.content}
          </pre>
        </section>
      )}

      <section>
        <h2 className="text-lg font-semibold mb-1">Concepts taught ({resource.conceptsTaught.length})</h2>
        {resource.conceptsTaught.length === 0 ? (
          <p className="text-sm text-gray-600">—</p>
        ) : (
          <ul className="text-sm list-disc pl-5">
            {resource.conceptsTaught.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-1">
          Prerequisite concepts ({resource.prerequisiteConcepts.length})
        </h2>
        {resource.prerequisiteConcepts.length === 0 ? (
          <p className="text-sm text-gray-600">—</p>
        ) : (
          <ul className="text-sm list-disc pl-5">
            {resource.prerequisiteConcepts.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-1">Source</h2>
        <dl className="text-sm grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
          <dt className="font-medium">name</dt>
          <dd>{resource.source.name}</dd>
          <dt className="font-medium">slug</dt>
          <dd>{resource.source.slug}</dd>
          <dt className="font-medium">kind</dt>
          <dd>{resource.source.kind}</dd>
          <dt className="font-medium">trustScore</dt>
          <dd>{resource.source.trustScore.toFixed(2)}</dd>
          <dt className="font-medium">url</dt>
          <dd>
            <a
              href={resource.source.url}
              target="_blank"
              rel="noopener noreferrer"
              className="underline break-all"
            >
              {resource.source.url}
            </a>
          </dd>
        </dl>
      </section>

      <details className="text-xs">
        <summary className="cursor-pointer text-gray-600">raw JSON</summary>
        <pre className="mt-2 p-3 bg-gray-100 rounded overflow-auto">
          {JSON.stringify(resource, null, 2)}
        </pre>
      </details>
    </main>
  );
}
