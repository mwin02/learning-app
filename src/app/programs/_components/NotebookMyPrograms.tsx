// Frontend redesign Block 6: the my-programs dashboard sheet, per the Home
// Dashboard (Notebook) mock — greeting, "My Table of Contents" hero, stat row,
// then one ToC chapter per enrolled program (the mock listed flat courses; our
// chapters are programs). Dropped from the mock: day streak (no streaks) and
// page numbers (the edge slot shows the courses-ready count instead). Programs
// still planning/building/failed render as inert dashed rows. Server component;
// the page assembles the data and the Desk/Sheet around it.

import Link from 'next/link';
import { accentFor, romanize } from '@/components/notebook/accents';
import { TocEntry } from '@/components/notebook/TocEntry';
import { PROGRAM_STATE_LABEL } from './program-ui';

export type DashboardProgram = {
  id: string;
  title: string;
  // Creator-private goal for the meta line; null for enrolled non-creators
  // (and for creators whose title IS the goal — no point repeating it).
  goalNote: string | null;
  status: string;
  courseCount: number;
  builtCount: number;
  doneLessons: number;
  totalLessons: number;
  nextUp: string | null;
};

function Stat({ value, label, color }: { value: string; label: string; color?: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="font-hand text-[34px] font-bold leading-none" style={{ color: color ?? 'var(--color-script)' }}>
        {value}
      </span>
      <span className="text-xs uppercase tracking-[0.5px] text-script-dim">{label}</span>
    </div>
  );
}

// A program that isn't browsable yet — still planning/building, or failed.
// Still a link: the program overview renders its live build status.
function InertProgram({ program }: { program: DashboardProgram }) {
  const failed = program.status === 'failed';
  return (
    <Link
      href={`/programs/${program.id}`}
      className="flex items-start gap-4 border-b border-dashed border-rule py-3.5 no-underline opacity-80"
    >
      <div className="mt-0.5 flex h-11 w-11 flex-none -rotate-3 items-center justify-center rounded-[9px_11px_8px_12px] border-[2.5px] border-dashed border-script-dim font-hand text-[22px] font-bold text-script-dim">
        {failed ? '×' : '…'}
      </div>
      <div className="min-w-0 flex-1">
        <span className="font-hand text-[28px] font-bold leading-none text-script-faint">{program.title}</span>
        <div className="mt-0.5 font-script text-xs text-script-dim">
          {failed
            ? 'this program couldn’t be built'
            : 'your courses are being written — check back shortly'}
        </div>
      </div>
      <span className="mt-1 flex-none font-script text-sm italic text-script-dim">
        {PROGRAM_STATE_LABEL[program.status as keyof typeof PROGRAM_STATE_LABEL]?.toLowerCase() ??
          program.status}
      </span>
    </Link>
  );
}

export function NotebookMyPrograms({
  firstName,
  programs,
}: {
  firstName: string | null;
  programs: DashboardProgram[];
}) {
  const doneLessons = programs.reduce((s, p) => s + p.doneLessons, 0);
  const totalLessons = programs.reduce((s, p) => s + p.totalLessons, 0);
  const pct = totalLessons > 0 ? Math.round((doneLessons / totalLessons) * 100) : 0;

  return (
    <>
      <div className="nb-kicker pt-2">welcome back{firstName ? `, ${firstName}` : ''}</div>
      <h1 className="mb-1.5 mt-1 font-hand text-[56px] font-bold leading-[0.92] text-script">
        My{' '}
        <span style={{ background: 'linear-gradient(transparent 60%, rgba(255,224,102,.72) 60%)' }}>
          Table of Contents
        </span>
      </h1>
      <p className="mb-2 max-w-[560px] text-lg leading-[34px]">
        Everything you’re learning, in one place. Flip to any chapter and pick up where you left
        off.
      </p>

      {programs.length > 0 && (
        <div className="mb-7 mt-3.5 flex flex-wrap gap-[26px]">
          <Stat value={String(programs.length)} label={`program${programs.length === 1 ? '' : 's'}`} />
          <Stat value={`${pct}%`} label="overall complete" color="var(--color-crayon-red)" />
          <Stat value={String(doneLessons)} label="lessons done" color="var(--color-crayon-green)" />
        </div>
      )}

      <div className="mb-1 flex items-baseline gap-3">
        <div className="font-hand text-[30px] font-bold tracking-[1px] text-script">Contents</div>
        <div className="-translate-y-1.5 flex-1 border-b-2 border-dashed border-rule" />
      </div>

      {programs.length === 0 && (
        <p className="mt-3 font-script text-sm text-script-faint">
          Nothing here yet — describe a goal below and we’ll draw up the chapters.
        </p>
      )}

      {programs.map((program, i) =>
        program.status === 'ready' || program.status === 'partial' ? (
          <TocEntry
            key={program.id}
            chapter={romanize(i)}
            accent={accentFor(i)}
            title={program.title}
            meta={[
              program.goalNote ?? 'goal-driven program',
              `${program.courseCount} course${program.courseCount === 1 ? '' : 's'}`,
              `${program.totalLessons} lessons`,
            ].join(' · ')}
            nextUp={program.nextUp ?? undefined}
            done={program.doneLessons}
            total={program.totalLessons}
            href={`/programs/${program.id}`}
            edge={
              program.builtCount < program.courseCount
                ? `${program.builtCount}/${program.courseCount} ready`
                : undefined
            }
          />
        ) : (
          <InertProgram key={program.id} program={program} />
        )
      )}

      {/* appendix: start a new program */}
      <Link href="/programs/new" className="mt-1 flex items-center gap-3.5 pb-1 pt-4 no-underline">
        <div className="flex h-11 w-11 flex-none -rotate-3 items-center justify-center rounded-[9px_11px_8px_12px] border-[2.5px] border-dashed border-script-dim font-hand text-[30px] font-bold text-script-faint">
          +
        </div>
        <div>
          <div className="font-hand text-[26px] font-bold leading-none text-script">
            Start a new chapter
          </div>
          <div className="mt-0.5 font-script text-sm text-script-dim">
            Describe a new goal and we’ll build the program →
          </div>
        </div>
      </Link>
    </>
  );
}
