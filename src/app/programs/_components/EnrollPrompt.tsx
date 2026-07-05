// Phase 3d, reskinned in frontend-redesign Block 7: what an UNENROLLED viewer
// (anonymous included) sees at any /programs/[id]/... URL — the program
// preview as a notebook sheet, per the Enroll Page (Notebook) mock. Receives
// the SANITIZED view only: title-as-goal, description, plan shape — never the
// creator's private inputs. Renders outside the shell (no rail), so it owns
// its Desk. Dropped from the mock (no data / locked decisions): instructor
// bio, ratings, wishlist, certificate, preview video, free-preview chips.
// Contents = collapsible course boxes → sections → lesson titles (native
// <details>, so the whole prompt stays a server component).

import type { ProgramView, ProgramTrackView } from '@/lib/program-view';
import { formatMinutes } from '@/lib/program-view';
import { loadProgramCourseProgress, type CourseProgress } from '@/lib/program-progress';
import { Desk, Sheet } from '@/components/notebook/Sheet';
import { StickyNote, ChapterChip } from '@/components/notebook/primitives';
import { accentFor, romanize } from '@/components/notebook/accents';
import { trackBuildState } from './program-ui';
import { EnrollButton, SignInToEnrollLink } from './EnrollButton';

function titleCase(slug: string): string {
  return slug
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// Doodle-bordered fact chip; alternating corner radii like the mock's.
function Chip({ label, flip }: { label: string; flip: boolean }) {
  return (
    <span
      className={`border-[1.5px] border-rule px-3 py-[3px] font-script text-xs text-script-body ${
        flip ? 'rounded-[5px_14px_5px_14px]' : 'rounded-[14px_5px_14px_5px]'
      }`}
    >
      {label}
    </span>
  );
}

// Hand-drawn expand chevron; rotates when the owning <details> opens.
function Chevron({ open }: { open?: boolean }) {
  return (
    <span
      className={`flex-none font-hand text-[19px] font-bold text-script-dim transition-transform ${
        open ? 'group-open/course:rotate-90' : 'group-open/section:rotate-90'
      }`}
      aria-hidden
    >
      ›
    </span>
  );
}

function LessonLine({ title }: { title: string }) {
  return (
    <div className="flex items-start gap-2.5 py-[3px] pl-1 font-script text-sm leading-[22px] text-script-body">
      <span className="flex-none text-script-dim">○</span>
      <span>{title}</span>
    </div>
  );
}

// One course as a collapsible box: summary row (chip · title · counts), then
// sections as nested collapsibles revealing their lesson titles (a flat course
// lists lessons directly). Native <details> — no client JS, works pre-enroll.
function CourseBox({
  track,
  index,
  skeleton,
}: {
  track: ProgramTrackView;
  index: number;
  skeleton: CourseProgress | undefined;
}) {
  const ready = track.trackId !== null && trackBuildState(track) === 'ready' && skeleton != null;

  if (!ready) {
    return (
      <div className="mb-2.5 flex items-center gap-3.5 rounded-[3px] border-2 border-dashed border-rule px-3.5 py-2.5 opacity-80">
        <div className="flex h-8 w-8 flex-none -rotate-3 items-center justify-center rounded-[8px_10px_9px_11px] border-2 border-dashed border-script-dim font-hand text-[17px] font-bold text-script-dim">
          {trackBuildState(track) === 'failed' ? '×' : '…'}
        </div>
        <span className="min-w-0 flex-1 font-hand text-[23px] font-bold leading-none text-script-faint">
          {track.title ?? titleCase(track.topic)}
        </span>
        <span className="flex-none font-script text-2xs text-script-dim">
          {trackBuildState(track) === 'failed' ? 'couldn’t be built' : 'being written…'}
        </span>
      </div>
    );
  }

  // Group lessons under sections like the rail does; SetNull leftovers get an
  // "Other" group; a flat (un-sectioned) course lists lessons directly.
  let groups: { id: string; title: string; lessons: { id: string; title: string }[] }[] | null =
    null;
  if (skeleton.sections.length > 0) {
    groups = skeleton.sections.map((s) => ({
      id: s.id,
      title: s.title,
      lessons: skeleton.lessons.filter((l) => l.sectionId === s.id),
    }));
    const loose = skeleton.lessons.filter((l) => l.sectionId === null);
    if (loose.length > 0) groups.push({ id: '__loose', title: 'Other', lessons: loose });
  }

  return (
    <details className="group/course mb-2.5 rounded-[3px] border border-note-edge bg-card px-3.5 shadow-[0_3px_8px_rgba(0,0,0,.07)]">
      <summary className="flex cursor-pointer list-none items-center gap-3.5 py-2.5 [&::-webkit-details-marker]:hidden">
        <ChapterChip label={romanize(index)} bg={accentFor(index).bg} size={32} />
        <span className="min-w-0 flex-1 font-hand text-[23px] font-bold leading-none text-script">
          {track.title ?? titleCase(track.topic)}
        </span>
        <span className="flex-none font-script text-2xs text-script-dim">
          {track.lessonCount} lessons · {formatMinutes(track.totalMinutes)}
        </span>
        <Chevron open />
      </summary>
      <div className="border-t border-dashed border-rule pb-3 pt-1.5">
        {groups ? (
          groups.map((g) => (
            <details key={g.id} className="group/section">
              <summary className="flex cursor-pointer list-none items-baseline gap-2.5 py-1.5 [&::-webkit-details-marker]:hidden">
                <Chevron />
                <span className="min-w-0 flex-1 font-hand text-[20px] font-bold leading-none text-script">
                  {g.title}
                </span>
                <span className="flex-none font-script text-2xs text-script-dim">
                  {g.lessons.length} lesson{g.lessons.length === 1 ? '' : 's'}
                </span>
              </summary>
              <div className="pb-1.5 pl-6">
                {g.lessons.map((l) => (
                  <LessonLine key={l.id} title={l.title} />
                ))}
              </div>
            </details>
          ))
        ) : (
          <div className="pl-1">
            {skeleton.lessons.map((l) => (
              <LessonLine key={l.id} title={l.title} />
            ))}
          </div>
        )}
      </div>
    </details>
  );
}

export async function EnrollPrompt({
  program,
  signedIn,
}: {
  program: ProgramView;
  signedIn: boolean;
}) {
  const building = program.status === 'planning' || program.status === 'building';
  const ordered = program.phases.flatMap((ph) => ph.tracks);
  const chapterOf = new Map(ordered.map((t, i) => [t.topic, i]));

  // Lesson/section skeletons for the built courses (titles only — no viewer,
  // no progress). Lesson titles are generated content, same public-preview
  // class as course titles.
  const readyTrackIds = ordered.flatMap((t) =>
    t.trackId && trackBuildState(t) === 'ready' ? [t.trackId] : []
  );
  const skeletons = await loadProgramCourseProgress(null, readyTrackIds);

  return (
    <Desk maxWidth={980}>
      <Sheet>
        <div className="nb-kicker pt-2">goal-driven program · free to join</div>
        <h1 className="mb-2.5 mt-1.5 font-hand text-[52px] font-bold leading-[0.95] text-script">
          <span style={{ background: 'linear-gradient(transparent 64%, rgba(255,224,102,.72) 64%)' }}>
            {program.goal}
          </span>
        </h1>
        {program.description && (
          <p className="mb-4 max-w-[560px] text-lg leading-[34px]">{program.description}</p>
        )}

        <div className="mb-6 flex flex-wrap gap-2.5">
          {[
            `${program.trackCount} course${program.trackCount === 1 ? '' : 's'}`,
            `${program.totalLessons} lessons`,
            `≈${formatMinutes(program.totalMinutes)}`,
            `${program.totalHoursPerWeek}h/wk × ${program.totalWeeks} weeks`,
          ].map((label, i) => (
            <Chip key={label} label={label} flip={i % 2 === 1} />
          ))}
        </div>

        {/* two-column body: contents + the sticky enroll card */}
        <div className="flex flex-col-reverse items-start gap-8 md:flex-row">
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex items-baseline gap-3">
              <div className="font-hand text-[30px] font-bold tracking-[1px] text-script">Contents</div>
              <div className="-translate-y-1.5 flex-1 border-b-2 border-dashed border-rule" />
            </div>
            {building && (
              <p className="mb-1 font-script text-xs italic text-script-faint">
                the courses are still being written — enroll now and they’ll appear as they’re
                finished
              </p>
            )}
            {program.phases.map((phase) => (
              <section key={phase.label}>
                {program.phases.length > 1 && (
                  <div className="pt-3 font-hand text-[21px] font-bold text-script-faint">
                    {phase.label}
                  </div>
                )}
                {phase.tracks.map((track) => (
                  <CourseBox
                    key={track.topic}
                    track={track}
                    index={chapterOf.get(track.topic) ?? 0}
                    skeleton={track.trackId ? skeletons.get(track.trackId) : undefined}
                  />
                ))}
              </section>
            ))}
          </div>

          <aside className="w-full flex-none md:sticky md:top-[calc(var(--nav-h)+26px)] md:w-[290px]">
            <StickyNote rotate={0.8} tape="right" className="px-[22px] pb-5 pt-[22px]">
              <div className="flex items-baseline gap-2.5">
                <span className="font-hand text-[44px] font-bold leading-none text-script">Free</span>
                <span className="font-script text-2xs text-script-faint">self-paced</span>
              </div>
              <div className="mt-3.5 text-center">
                {signedIn ? <EnrollButton programId={program.id} /> : <SignInToEnrollLink />}
              </div>
              <div className="my-4 border-t border-dashed border-note-edge" />
              <div className="mb-2 font-script text-2xs uppercase tracking-[1px] text-note-label">
                this program includes
              </div>
              <div className="flex flex-col gap-1.5">
                {[
                  `${program.totalLessons} curated lessons across ${program.trackCount} course${program.trackCount === 1 ? '' : 's'}`,
                  'videos, readings & interactive embeds',
                  'practice questions with answers',
                  'progress that follows you across devices',
                ].map((line) => (
                  <div key={line} className="flex items-start gap-2 font-script text-sm leading-6 text-script-body">
                    <span className="flex-none text-pen">›</span>
                    <span>{line}</span>
                  </div>
                ))}
              </div>
            </StickyNote>
          </aside>
        </div>
      </Sheet>
    </Desk>
  );
}
