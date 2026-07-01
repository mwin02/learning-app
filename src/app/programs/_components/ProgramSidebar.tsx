// Phase 2.75e (learn UI): the sticky left sidebar for the program hub — the analog
// of the course player's CourseSidebar, but its rows are the program's TRACKS (one
// per topic), grouped by phase, instead of one course's lessons. A built track links
// into its own /learn player; unbuilt/failed slots render inert with a status badge.
// Server component: clicking a track leaves the program shell for /learn, so there's
// no in-shell active state to track.

import Link from 'next/link';
import type { ProgramView } from '@/lib/program-view';
import { formatMinutes } from '@/lib/program-view';
import { PROGRAM_STATE_LABEL, TRACK_STATE_LABEL, trackBuildState } from './program-ui';

function TrackRow({ track }: { track: ProgramView['phases'][number]['tracks'][number] }) {
  const state = trackBuildState(track);
  const dot =
    state === 'ready' ? 'bg-success' : state === 'failed' ? 'bg-faint' : 'bg-brand';
  const inner = (
    <>
      <span className={`mt-1.5 h-2 w-2 flex-none rounded-full ${dot}`} />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium leading-tight text-ink">
          {track.title ?? track.topic}
        </span>
        <span className="meta-xs mt-0.5 block">
          {state === 'ready'
            ? `${track.lessonCount} lessons · ${formatMinutes(track.totalMinutes)}`
            : TRACK_STATE_LABEL[state]}
        </span>
      </span>
      {track.priorityTier === 'core' && (
        <span className="eyebrow mt-0.5 flex-none text-brand">CORE</span>
      )}
    </>
  );

  // Only a built track is navigable; an unbuilt slot is a static row.
  return track.trackId && state === 'ready' ? (
    <Link
      href={`/learn/${track.trackId}`}
      className="mx-2.5 my-px flex items-start gap-[11px] rounded-control px-3.5 py-2 hover:bg-fill"
    >
      {inner}
    </Link>
  ) : (
    <div className="mx-2.5 my-px flex items-start gap-[11px] rounded-control px-3.5 py-2 opacity-70">
      {inner}
    </div>
  );
}

export function ProgramSidebar({ program }: { program: ProgramView }) {
  return (
    <aside className="sticky top-[var(--nav-h)] min-h-[calc(100vh-var(--nav-h))] w-[322px] flex-none self-start border-r border-line bg-card pb-5">
      <div className="block border-b border-line-soft px-5 pb-[18px] pt-5">
        <div className="eyebrow text-muted">PROGRAM</div>
        <div className="mb-2 mt-[5px] text-lg font-semibold leading-tight">{program.goal}</div>
        <div className="flex items-center justify-between">
          <span className="meta">
            {program.builtCount} / {program.trackCount} courses ready
          </span>
          <span className="meta font-medium text-brand">{PROGRAM_STATE_LABEL[program.status]}</span>
        </div>
      </div>

      <div className="eyebrow px-5 pb-1.5 pt-4">PROGRAM CONTENT</div>

      {program.phases.map((phase) => (
        <div key={phase.label}>
          <div className="px-5 py-2.5">
            <span className="block text-sm font-medium leading-tight">{phase.label}</span>
            <span className="meta-xs mt-0.5 block">
              {phase.tracks.length} course{phase.tracks.length === 1 ? '' : 's'}
            </span>
          </div>
          <div className="pb-1">
            {phase.tracks.map((track) => (
              <TrackRow key={track.topic} track={track} />
            ))}
          </div>
        </div>
      ))}
    </aside>
  );
}
