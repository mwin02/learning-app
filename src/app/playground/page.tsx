import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@/lib/db';
import { isDevAuthEnabled } from '@/lib/dev-auth';
import { PlaygroundForm } from './PlaygroundForm';

export const dynamic = 'force-dynamic';

export default async function PlaygroundPage() {
  if (!isDevAuthEnabled()) notFound();

  const paths = await prisma.path.findMany({
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: {
      id: true,
      topic: true,
      title: true,
      difficulty: true,
      createdAt: true,
      _count: { select: { items: true } },
    },
  });

  return (
    <main className="p-6 flex flex-col gap-8">
      <section>
        <div className="flex items-center justify-between mb-2">
          <h1 className="text-2xl font-bold">Agent playground</h1>
          <Link href="/playground/search" className="text-sm underline">
            resource search →
          </Link>
        </div>
        <p className="text-sm text-gray-600 mb-4">
          Internal tool. POSTs to <code>/api/generate-path</code> with whatever you type — Zod and
          the topic gate run server-side, so invalid input shows up as a structured error below.
        </p>
        <PlaygroundForm />
      </section>

      <section>
        <h2 className="text-xl font-semibold mb-2">Recent paths ({paths.length})</h2>
        {paths.length === 0 ? (
          <p className="text-sm text-gray-600">No paths yet. Generate one above.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {paths.map((p) => (
              <li key={p.id} className="border rounded p-3 text-sm">
                <Link href={`/playground/${p.id}`} className="font-medium underline">
                  {p.title}
                </Link>
                <div className="text-gray-600 mt-1">
                  <span>topic: {p.topic}</span>
                  {' · '}
                  <span>difficulty: {p.difficulty}</span>
                  {' · '}
                  <span>{p._count.items} items</span>
                  {' · '}
                  <span>{p.createdAt.toISOString()}</span>
                </div>
                <div className="text-gray-500 text-xs mt-1">id: {p.id}</div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
