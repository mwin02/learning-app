// Frontend redesign Block 2: the program overview as a notebook sheet — hero
// (goal/status), handwritten stat row, then the plan as a table of contents:
// phases as handwritten dividers, one TocEntry per built course (real progress
// + next-up from the server read), inert rows for building/failed slots.
// Server component; the page assembles it on the Desk next to the BookmarkRail.

import type { ProgramView, ProgramTrackView } from '@/lib/program-view';
import { formatMinutes } from '@/lib/program-view';
import type { CourseProgress } from '@/lib/program-progress';
import { accentFor, romanize } from '@/components/notebook/accents';
import { PctDone } from '@/components/notebook/primitives';
import { TocEntry } from '@/components/notebook/TocEntry';
import { PROGRAM_STATE_LABEL, TRACK_STATE_LABEL, trackBuildState } from './program-ui';

function titleCase(slug: string): string {
  return slug
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

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

// A plan slot that isn't a navigable course yet: dashed chip + status note.
function InertSlot({ track }: { track: ProgramTrackView }) {
  const state = trackBuildState(track);
  return (
    <div className="flex items-start gap-4 border-b border-dashed border-rule py-3.5 opacity-80">
      <div className="mt-0.5 flex h-11 w-11 flex-none -rotate-3 items-center justify-center rounded-[9px_11px_8px_12px] border-[2.5px] border-dashed border-script-dim font-hand text-[22px] font-bold text-script-dim">
        {state === 'failed' ? '×' : '…'}
      </div>
      <div className="min-w-0 flex-1">
        <span className="font-hand text-[28px] font-bold leading-none text-script-faint">
          {track.title ?? titleCase(track.topic)}
        </span>
        <div className="mt-0.5 font-script text-xs text-script-dim">
          {state === 'failed'
            ? track.requestError
              ? `couldn’t build — ${track.requestError}`
              : 'this course couldn’t be built'
            : 'still being written — check back shortly'}
        </div>
      </div>
      <span className="mt-1 flex-none font-script text-sm italic text-script-dim">
        {TRACK_STATE_LABEL[state].toLowerCase()}
      </span>
    </div>
  );
}

export function NotebookProgramHome({
  program,
  progress,
}: {
  program: ProgramView;
  progress: Map<string, CourseProgress>;
}) {
  // Courses number continuously across phases (the rail uses the same order).
  const ordered = program.phases.flatMap((ph) => ph.tracks);
  const chapterOf = new Map(ordered.map((t, i) => [t.topic, i]));

  const doneLessons = ordered.reduce(
    (sum, t) => sum + (t.trackId ? (progress.get(t.trackId)?.doneCount ?? 0) : 0),
    0
  );
  const pct = program.totalLessons > 0 ? Math.round((doneLessons / program.totalLessons) * 100) : 0;

  return (
    <>
      {/* sheet header — the brand now lives in the app-wide top nav; this row
          keeps the program's overall progress readout, aligned right. */}
      <div className="mb-5 flex h-[44px] items-end justify-end">
        <PctDone pct={pct} />
      </div>

      <div className="mb-1.5 font-script text-xs text-script-dim">My Programs &nbsp;→&nbsp; {program.goal}</div>

      {/* hero */}
      <div className="nb-kicker">
        goal-driven program · {PROGRAM_STATE_LABEL[program.status].toLowerCase()}
      </div>
      <h1 className="mb-2.5 mt-1.5 font-hand text-[52px] font-bold leading-[0.95] text-script">
        <span style={{ background: 'linear-gradient(transparent 62%, rgba(255,224,102,.72) 62%)' }}>
          {program.goal}
        </span>
      </h1>
      {program.description && (
        <p className="mb-1 max-w-[620px] text-lg leading-[34px]">{program.description}</p>
      )}
      {program.background && (
        <p className="mb-1 max-w-[620px] font-script text-sm text-script-faint">
          tailored to your background: {program.background}
        </p>
      )}

      {program.status === 'failed' && program.error && (
        <p className="mt-3 max-w-[560px] rounded border border-note-edge bg-note px-3.5 py-2 font-script text-sm text-crayon-red">
          We couldn’t turn this goal into a program: {program.error}
        </p>
      )}

      {/* stat row */}
      <div className="my-6 flex flex-wrap gap-[26px]">
        <Stat value={String(program.trackCount)} label={`courses · ${program.builtCount} ready`} />
        <Stat value={String(program.totalLessons)} label="lessons" />
        <Stat value={formatMinutes(program.totalMinutes)} label="est. time" color="var(--color-crayon-red)" />
        <Stat
          value={`${program.totalHoursPerWeek}h/wk`}
          label={`× ${program.totalWeeks} weeks planned`}
          color="var(--color-crayon-green)"
        />
      </div>

      {/* contents */}
      <div className="mb-1 flex items-baseline gap-3">
        <div className="font-hand text-[30px] font-bold tracking-[1px] text-script">Contents</div>
        <div className="-translate-y-1.5 flex-1 border-b-2 border-dashed border-rule" />
      </div>

      {program.phases.map((phase) => (
        <section key={phase.label}>
          {program.phases.length > 1 && (
            <div className="flex items-baseline gap-2 pt-4">
              <span className="font-hand text-[23px] font-bold text-script-faint">{phase.label}</span>
              <span className="font-script text-2xs text-script-dim">
                — {phase.tracks.length} course{phase.tracks.length === 1 ? '' : 's'}
              </span>
            </div>
          )}
          {phase.tracks.map((track) => {
            const i = chapterOf.get(track.topic) ?? 0;
            const cp = track.trackId ? progress.get(track.trackId) : undefined;
            return track.trackId && trackBuildState(track) === 'ready' ? (
              <TocEntry
                key={track.topic}
                chapter={romanize(i)}
                accent={accentFor(i)}
                title={track.title ?? titleCase(track.topic)}
                meta={`${titleCase(track.topic)} · ${track.lessonCount} lessons · ${formatMinutes(track.totalMinutes)}${track.priorityTier === 'core' ? ' · core' : ''}`}
                nextUp={cp?.nextUp?.title}
                done={cp?.doneCount ?? 0}
                total={cp?.totalCount ?? track.lessonCount}
                href={`/programs/${program.id}/${track.trackId}`}
                edge={formatMinutes(track.totalMinutes)}
              />
            ) : (
              <InertSlot key={track.topic} track={track} />
            );
          })}
        </section>
      ))}
    </>
  );
}
