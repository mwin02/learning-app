// Phase 2.6 (learn UI), Block B: the course-player shell. Loads the Track once
// (server), then renders the Home Summary (Hi-Fi) chrome — IBM Plex type, the
// #f5f6f8 surface, the sticky TopNav, and the sticky CourseSidebar — around the
// page content. Wraps everything in the client CourseProvider so the sidebar and
// the main column share one localStorage-backed progress model.

import { notFound } from 'next/navigation';
import { IBM_Plex_Sans, IBM_Plex_Mono } from 'next/font/google';
import { getTrackView } from '@/lib/track-view';
import { CourseProvider } from '../_components/course-context';
import { SANS } from '../_components/primitives';
import { TopNav } from '../_components/TopNav';
import { CourseSidebar } from '../_components/CourseSidebar';

export const dynamic = 'force-dynamic';

const plexSans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-plex-sans',
});
const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-plex-mono',
});

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
    <div
      className={`${plexSans.variable} ${plexMono.variable} ${SANS} min-h-screen bg-[#f5f6f8] text-[#1f2730]`}
    >
      <CourseProvider track={track}>
        <TopNav />
        <div className="flex items-start">
          <CourseSidebar />
          <main className="min-h-[calc(100vh-62px)] flex-1 min-w-0">{children}</main>
        </div>
      </CourseProvider>
    </div>
  );
}
