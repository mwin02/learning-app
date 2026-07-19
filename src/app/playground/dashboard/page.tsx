import { requireAdminPage } from '@/lib/auth/viewer';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Dashboard · Playground' };

// Playground revamp Block 1: stub landing page so /playground has somewhere to
// redirect. Block 2 fills it in — action-queue counts (decomposition review,
// pending review, map-review findings, failed builds, broken tracks), worker
// health, library stats, and a resource-ID lookup.
export default async function DashboardPage() {
  await requireAdminPage();
  return (
    <main className="p-6">
      <h1 className="text-2xl font-bold mb-2">Dashboard</h1>
      <p className="text-sm text-gray-600">
        App-health overview coming in the next block. Use the tabs above for operator actions.
      </p>
    </main>
  );
}
