// Phase 3d: what an UNENROLLED viewer sees at /programs/[id] — deliberately
// barebones (the designed enrollment page comes with the frontend pass).
// Receives the SANITIZED view only: title-as-goal, description, plan shape —
// never the creator's private inputs. Frontend-redesign Block 1: also the
// anonymous public preview — signed-out viewers get a sign-in link (returning
// here) instead of the enroll POST.

import type { ProgramView } from '@/lib/program-view';
import { formatDuration } from '@/lib/format-duration';
import { EnrollButton, SignInToEnrollLink } from './EnrollButton';

export function EnrollPrompt({
  program,
  signedIn,
}: {
  program: ProgramView;
  signedIn: boolean;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-surface text-ink">
      <div className="card max-w-lg p-8 text-center">
        <div className="eyebrow mb-3">Program</div>
        <h1 className="mb-3 text-2xl font-bold tracking-[-0.5px]">{program.goal}</h1>
        {program.description && <p className="mb-4 text-body">{program.description}</p>}
        <p className="meta mb-6">
          {program.trackCount} track{program.trackCount === 1 ? '' : 's'} · {program.totalLessons}{' '}
          lessons · {formatDuration(program.totalMinutes)} · {program.totalHoursPerWeek} h/wk ×{' '}
          {program.totalWeeks} wk
        </p>
        {signedIn ? <EnrollButton programId={program.id} /> : <SignInToEnrollLink />}
      </div>
    </div>
  );
}
