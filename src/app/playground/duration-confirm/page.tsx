import { readFile } from 'node:fs/promises';
import { requireAdminPage } from '@/lib/auth/viewer';
import { prisma } from '@/lib/db';
import { slugProposalsSchema, type SlugProposalRecord } from '@/lib/curation/slug-proposals';
import { logWarn } from '@/lib/log';
import { ConfirmDuration } from './confirm-duration';

export const dynamic = 'force-dynamic';

const PROPOSALS = 'docs/audits/khan-slug-proposals.json';

// Q10 — the confirmation half of the second Khan matching pass.
//
// 254 active Khan video rows carry no duration because their stored title no longer
// matches the YouTube title (our rows were retitled as exercise objectives:
// "Estimate limit values from graphs" against "Limits from graphs"). The URL slug
// still names the video and resolves 127 of them — but Q6b measured that key ~4%
// confidently wrong, so every match here is a PROPOSAL. Confirming one PATCHes the
// duration through Q9's existing seam, which stamps `durationSource: 'reviewer'` —
// the value is then a human's, which is what it is: you agreed the two videos are
// the same video.
//
// Doing nothing is a legitimate outcome. A proposal left unconfirmed keeps its row
// honestly `unknown`, and that count is reported rather than minimised.

async function loadProposals(): Promise<SlugProposalRecord[]> {
  const raw = await readFile(PROPOSALS, 'utf8').catch(() => null);
  if (raw === null) return [];
  const parsed = slugProposalsSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    logWarn('duration-confirm.proposals-unreadable', { file: PROPOSALS, issues: parsed.error.issues.length });
    return [];
  }
  return parsed.data;
}

// Only rows still standing at `unknown` with no number are open: a confirmed row
// gained a `reviewer` duration and drops out, which is what makes revisiting this
// page after a run idempotent rather than a second helping of the same decisions.
async function openProposals(all: SlugProposalRecord[]) {
  const rows = await prisma.resource.findMany({
    where: {
      id: { in: all.map((p) => p.resourceId) },
      durationMin: null,
      durationSource: 'unknown',
    },
    select: { id: true },
  });
  const open = new Set(rows.map((r) => r.id));
  return all.filter((p) => open.has(p.resourceId));
}

export default async function DurationConfirmPage() {
  await requireAdminPage();

  const all = await loadProposals();
  const pending = await openProposals(all);

  return (
    <main className="flex flex-col gap-6 p-6">
      <section>
        <h1 className="mb-2 text-2xl font-bold">Confirm proposed durations</h1>
        <p className="max-w-2xl text-sm text-gray-600">
          Khan video rows whose stored title matched nothing on Khan&apos;s YouTube channel, but
          whose <strong>URL slug</strong> did. The slug key was measured{' '}
          <strong>~4% confidently wrong</strong> — different videos, one 711s and one 269s under
          the same name — so nothing here is written until you agree with it. Open the row and the
          proposed video, and confirm only if they are the same lesson. A confirmed duration is
          recorded as <code>reviewer</code>-measured, because at that point it is your
          measurement. <strong>Leaving one alone is a valid answer</strong>: the row stays honestly{' '}
          <code>unknown</code>.
        </p>
        <p className="mt-2 text-sm text-gray-500">
          {pending.length} open of {all.length} proposed
          {all.length === 0 && (
            <>
              {' '}
              — none on disk. Run <code>scripts/resolve-unknowns.ts</code> to generate them.
            </>
          )}
        </p>
      </section>

      <ul className="flex flex-col gap-3">
        {pending.map((p) => (
          <li key={p.resourceId} className="rounded border p-3 text-sm">
            <div className="font-medium">{p.title}</div>
            <div className="truncate text-xs text-gray-400">
              <a href={p.url} target="_blank" rel="noreferrer" className="underline">
                {p.url}
              </a>
            </div>
            <div className="mt-1 text-xs text-gray-600">
              slug key <code>{p.slugKey}</code> →{' '}
              <a
                href={`https://www.youtube.com/watch?v=${p.videoId}`}
                target="_blank"
                rel="noreferrer"
                className="underline"
              >
                {p.videoTitle}
              </a>
            </div>
            <ConfirmDuration resourceId={p.resourceId} proposedMin={p.proposedMin} />
          </li>
        ))}
      </ul>
    </main>
  );
}
