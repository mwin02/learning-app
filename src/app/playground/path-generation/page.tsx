import { notFound } from 'next/navigation';
import { requireAdminPage } from '@/lib/auth/viewer';
import { PlaygroundForm } from './PlaygroundForm';

export const dynamic = 'force-dynamic';

export default async function PlaygroundPage() {
  await requireAdminPage();

  return (
    <main className="p-6 flex flex-col gap-8">
      <section>
        <h1 className="text-2xl font-bold mb-2">Course request playground</h1>
        <p className="text-sm text-gray-600 mb-4">
          Internal tool. POSTs to <code>/api/generate-path</code>, which validates + topic-gates the
          input and enqueues a <code>CourseRequest</code> (fire-and-forget). The out-of-band worker
          builds the Track; see <code>/playground/concept-maps</code> for the resulting maps and{' '}
          <code>/playground/broken-tracks</code> for triage.
        </p>
        <PlaygroundForm />
      </section>
    </main>
  );
}
