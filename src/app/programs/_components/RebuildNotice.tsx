// Reports R8: the course page's rebuild affordance — a sticky-note banner saying
// the course is being rebuilt (with AutoRefresh mounted, so the page actually
// becomes the new course without a manual reload) or that the last attempt failed.
//
// A server component: the state it renders is a CourseRequest row, and the page is
// force-dynamic, so there is nothing for the client to do beyond the refresh timer.

import { AutoRefresh } from '@/app/programs/_components/AutoRefresh';
import type { RebuildNotice as Notice } from '@/lib/services/rebuild-activity';

export function RebuildNotice({ notice }: { notice: Notice }) {
  const building = notice.kind === 'building';
  return (
    <div
      role="status"
      className="mb-5 -rotate-[0.3deg] rounded border border-note-edge bg-note px-3.5 py-2.5 shadow-[0_2px_5px_rgba(0,0,0,.07)]"
    >
      <div
        className={`font-script text-sm font-bold ${building ? 'text-script-body' : 'text-crayon-red'}`}
      >
        {building ? '↻ ' : '! '}
        {notice.title}
      </div>
      <p className="mt-1 max-w-[560px] font-script text-xs text-script-dim">{notice.detail}</p>
      {building && <AutoRefresh />}
    </div>
  );
}
