// Phase 2.6 (learn UI), Block B: the course-player shell. Loads the Track once
// (server), then renders the Home Summary (Hi-Fi) chrome — the surface background,
// the sticky TopNav, and the sticky CourseSidebar — around the page content. Wraps
// everything in the client CourseProvider so the sidebar and the main column share
// one localStorage-backed progress model. (Fonts are now app-wide via the root
// layout, so no local next/font instantiation here.)

import { notFound } from 'next/navigation';
import { getTrackView } from '@/lib/track-view';
import { CourseProvider } from '../_components/course-context';
import { TopNav } from '../_components/TopNav';
import { CourseSidebar } from '../_components/CourseSidebar';

export const dynamic = 'force-dynamic';

export default async function LearnLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ trackId: string }>;
}) {
  const { trackId } = await params;
  const track = await getTrackView(trackId);
  if (!track) notFound();

  return (
    <div className="min-h-screen bg-surface text-ink">
      <CourseProvider track={track}>
        <TopNav />
        <div className="flex items-start">
          <CourseSidebar />
          <main className="min-h-[calc(100vh-var(--nav-h))] flex-1 min-w-0">{children}</main>
        </div>
      </CourseProvider>
    </div>
  );
}
