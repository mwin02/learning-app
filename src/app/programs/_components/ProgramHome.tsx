// Phase 2.75e (learn UI): the program hub's main column — the analog of CourseHome,
// one level up. A hero (goal + status + background), at-a-glance program stats, then
// the plan laid out phase by phase with a card per constituent Track (its rationale,
// tier, size, and a link into its /learn course player). Server component; reads the
// shared ProgramView.

import Link from 'next/link';
import type { ProgramView, ProgramTrackView } from '@/lib/program-view';
import { formatMinutes } from '@/lib/program-view';
import {
  PROGRAM_STATE_LABEL,
  TRACK_STATE_BADGE,
  TRACK_STATE_LABEL,
  trackBuildState,
} from './program-ui';

function titleCase(slug: string): string {
  return slug
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function StatCard({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="card p-5">
      <div className="eyebrow">{label}</div>
      <div className="stat-value mt-2">{value}</div>
      <div className="mt-0.5 text-xs text-muted">{sub}</div>
    </div>
  );
}

function TrackCard({ track }: { track: ProgramTrackView }) {
  const state = trackBuildState(track);
  const built = track.trackId && state === 'ready';
  return (
    <div className="card p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="eyebrow text-brand">
            {titleCase(track.topic)}
            {track.priorityTier === 'core' ? ' · CORE' : ' · OPTIONAL'}
          </div>
          <div className="mt-1 text-md font-semibold leading-tight">
            {track.title ?? titleCase(track.topic)}
          </div>
        </div>
        <span className={`flex-none rounded-button px-2.5 py-1 text-2xs font-medium ${TRACK_STATE_BADGE[state]}`}>
          {TRACK_STATE_LABEL[state]}
        </span>
      </div>

      {track.rationale && (
        <p className="mt-2 max-w-[620px] text-sm leading-[1.55] text-body">{track.rationale}</p>
      )}

      <div className="mt-3 flex items-center gap-4">
        {built ? (
          <>
            <span className="meta-xs">
              {track.lessonCount} lessons · {formatMinutes(track.totalMinutes)}
            </span>
            <Link
              href={`/learn/${track.trackId}`}
              className="ml-auto rounded-button bg-brand px-3.5 py-1.5 text-sm font-medium text-white hover:opacity-90"
            >
              Start course →
            </Link>
          </>
        ) : (
          <span className="meta-xs">
            {state === 'failed'
              ? track.requestError
                ? `Couldn’t build: ${track.requestError}`
                : 'This course couldn’t be built.'
              : 'This course is still being built — check back shortly.'}
          </span>
        )}
      </div>
    </div>
  );
}

export function ProgramHome({ program }: { program: ProgramView }) {
  return (
    <div className="px-10 pb-[60px] pt-[34px]">
      <div className="mx-auto max-w-[860px]">
        <div className="meta mb-[18px] tracking-[0.5px]">
          My Programs&nbsp;&nbsp;/&nbsp;&nbsp;{program.goal}
        </div>

        <div className="eyebrow text-brand">GOAL-DRIVEN PROGRAM · {PROGRAM_STATE_LABEL[program.status].toUpperCase()}</div>
        <h1 className="mb-3 mt-[7px] text-3xl font-bold tracking-[-0.5px]">{program.goal}</h1>
        {program.background && (
          <p className="mb-[var(--space-section)] max-w-[660px] text-md leading-[1.6] text-body">
            Tailored to your background: {program.background}
          </p>
        )}

        {program.status === 'failed' && program.error && (
          <div className="mb-[var(--space-section)] rounded-card border border-line bg-fill p-4 text-sm text-muted">
            We couldn’t turn this goal into a program: {program.error}
          </div>
        )}

        <div className="mb-[var(--space-section)] grid grid-cols-3 gap-[14px]">
          <StatCard
            label="COURSES"
            value={`${program.trackCount}`}
            sub={`${program.builtCount} ready${program.coreCount ? ` · ${program.coreCount} core` : ''}`}
          />
          <StatCard label="TOTAL LESSONS" value={`${program.totalLessons}`} sub="across all courses" />
          <StatCard
            label="EST. TIME"
            value={formatMinutes(program.totalMinutes)}
            sub={`${program.totalHoursPerWeek}h/wk × ${program.totalWeeks}w plan`}
          />
        </div>

        {program.phases.map((phase, i) => (
          <section key={phase.label} className={i > 0 ? 'mt-[var(--space-section)]' : ''}>
            <div className="mb-3 flex items-baseline gap-3">
              <h2 className="text-lg font-semibold tracking-[-0.2px]">{phase.label}</h2>
              <span className="meta-xs">
                {phase.tracks.length} course{phase.tracks.length === 1 ? '' : 's'}
              </span>
            </div>
            <div className="flex flex-col gap-[14px]">
              {phase.tracks.map((track) => (
                <TrackCard key={track.topic} track={track} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
