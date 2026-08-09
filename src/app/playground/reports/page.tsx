import Link from 'next/link';
import { listReportTriage, REPORT_ROW_CAP, type TriageItem } from '@/lib/curation/report-triage';
import { requireAdminPage } from '@/lib/auth/viewer';
import { categoryLabel, lessonChoices } from '@/lib/report-triage-view';
import { TriageActions } from './triage-actions';

export const dynamic = 'force-dynamic';

// The learner-driven defect queue: open ResourceReports grouped by resource,
// ranked by distinct reporters then age. Every action here delegates to existing
// curation machinery (deprecate / unlink / refile / edit) — the queue's job is to
// route a defect to the RIGHT axis, which is the whole point of reports existing
// next to votes. Deliberately different from Pending review (an approval queue on
// resources we sourced); this one is driven by learners hitting the defect.

function ResourceHeader({ item }: { item: TriageItem }) {
  const r = item.resource;
  if (!r) return <span className="font-medium text-gray-500">resource {item.resourceId} (deleted)</span>;
  return (
    <>
      <Link href={`/playground/resource/${item.resourceId}`} className="font-medium underline">
        {r.title}
      </Link>
      <div className="mt-1 text-gray-600">
        <span>{r.topic}</span>
        {' · '}
        <span>{r.origin}</span>
        {' · '}
        <span className={r.status === 'active' ? 'text-green-700' : 'text-red-700'}>
          {r.status}
          {r.deprecationSeverity ? ` (${r.deprecationSeverity})` : ''}
        </span>
        {' · '}
        <span>trust {r.trustScore.toFixed(2)}</span>
        {r.requiresPurchase && <span className="text-amber-700"> · requiresPurchase</span>}
      </div>
      <div className="mt-1 truncate text-xs text-gray-400">
        <a href={r.url} target="_blank" rel="noreferrer" className="underline">
          {r.url}
        </a>
      </div>
    </>
  );
}

function LessonContext({ lessons }: { lessons: TriageItem['lessons'] }) {
  if (lessons.length === 0) return null;
  return (
    <p className="mt-1 text-xs text-gray-500">
      Reported from: {lessons.map((l) => `${l.trackTitle ?? 'track'} → ${l.title}`).join('; ')}
    </p>
  );
}

export default async function ReportsPage() {
  await requireAdminPage();
  const { items, truncated } = await listReportTriage();

  return (
    <main className="flex flex-col gap-6 p-6">
      <section>
        <h1 className="mb-2 text-2xl font-bold">Reports</h1>
        <p className="max-w-2xl text-sm text-gray-600">
          Learner-filed defect reports, grouped by resource and ranked by how many distinct people
          hit them. <strong>Each category acts on a different axis</strong>: a broken link
          deprecates the row, a wrong topic <em>refiles</em> it, and a
          &ldquo;doesn&rsquo;t fit this lesson&rdquo; report <em>unlinks</em> it from that
          lesson&rsquo;s concepts — it never deprecates a good resource for being in the wrong
          place. Resolving one report closes the other open reports of the same category on the
          same resource unless you untick that. Built Tracks are immutable and are not touched;
          only future builds are corrected.
        </p>
      </section>

      <section>
        <h2 className="mb-2 text-xl font-semibold">
          Open <span className="font-normal text-gray-500">({items.length} resources)</span>
        </h2>
        {truncated && (
          <p className="mb-2 text-xs text-amber-700">
            Showing the first {REPORT_ROW_CAP} open reports only.
          </p>
        )}
        {items.length === 0 ? (
          <p className="text-sm text-gray-600">Nothing here.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {items.map((item) => (
              <li key={item.resourceId} className="rounded border p-3 text-sm">
                <ResourceHeader item={item} />
                <p className="mt-1 text-xs text-gray-500">
                  {item.reporters} reporter(s) · oldest {item.oldestAt.toISOString().slice(0, 10)}
                  {item.autoResolved > 0 && ` · ${item.autoResolved} already auto-resolved`}
                </p>
                <LessonContext lessons={item.lessons} />
                <ul className="mt-2 flex flex-col gap-3 border-l-2 border-gray-100 pl-3">
                  {item.categories.map((group) => (
                    <li key={group.category}>
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{categoryLabel(group.category)}</span>
                        <span className="text-xs text-gray-500">
                          {group.reporters} reporter(s) · {group.category}
                        </span>
                      </div>
                      {group.reports.map((report) => (
                        <div key={report.id} className="mt-1 text-xs text-gray-600">
                          {report.note && <p className="italic">&ldquo;{report.note}&rdquo;</p>}
                          {report.resolution && <p className="text-blue-700">probe: {report.resolution}</p>}
                          {/* Re-reported after being settled: what the last resolution
                              or dismissal said is the evidence that the fix didn't take. */}
                          {report.priorResolution && (
                            <p className="text-amber-700">
                              re-reported · previously: {report.priorResolution}
                            </p>
                          )}
                        </div>
                      ))}
                      {/* Acts on the OLDEST report of the group; the rest close with
                          it by default (five reports of one dead link are one defect).
                          `unlink` is the exception — it picks a lesson, and closes only
                          that lesson's reports. */}
                      <TriageActions
                        reportId={group.reports[0].id}
                        category={group.category}
                        lessonChoices={lessonChoices(group.lessonTargets, item.lessons)}
                        currentTopic={item.resource?.topic ?? null}
                        currentRequiresPurchase={item.resource?.requiresPurchase ?? false}
                      />
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
