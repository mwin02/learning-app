// Phase 2.6 (learn UI), Block B: the course-player shell. Loads the Track once
// (server), then renders the Home Summary (Hi-Fi) chrome — the surface background,
// the sticky TopNav, and the sticky CourseSidebar — around the page content. Wraps
// everything in the client CourseProvider so the sidebar and the main column share
// one localStorage-backed progress model. (Fonts are now app-wide via the root
// layout, so no local next/font instantiation here.)
//
// Phase 3d: gated via getAuthorizedTrackView — anonymous viewers go to sign-in;
// non-admins need enrollment in a Program containing this Track AND a `ready`
// Track (closing the 2.6 "renders any Track by id, drafts included" gap).
// Unauthorized === nonexistent (404), so track ids aren't confirmable.

import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { getAuthorizedTrackView } from '@/lib/auth/track-access';
import { getViewer } from '@/lib/auth/viewer';
import { CourseProvider } from '../_components/course-context';
import { TopNav } from '../_components/TopNav';
import { CourseSidebar } from '../_components/CourseSidebar';

export const dynamic = 'force-dynamic';

// Title the browser tab after the course (overrides the app default). The lesson
// route refines this further; getAuthorizedTrackView is cache()'d, so this adds
// no extra queries — and it leaks nothing to viewers the layout will bounce.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ trackId: string }>;
}): Promise<Metadata> {
  const { trackId } = await params;
  const access = await getAuthorizedTrackView(trackId);
  if (access.kind !== 'ok') return {};
  return { title: access.track.title ?? `${access.track.topic} course` };
}

export default async function LearnLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ trackId: string }>;
}) {
  const { trackId } = await params;
  const access = await getAuthorizedTrackView(trackId);
  if (access.kind === 'login') {
    redirect(`/signin?next=${encodeURIComponent(`/learn/${trackId}`)}`);
  }
  if (access.kind !== 'ok') notFound();

  // Phase 3f: tell the provider whether a real user is signed in, so progress
  // goes to the Progress table instead of localStorage. cache()'d — the access
  // check above already resolved the viewer, so this is free.
  const viewer = await getViewer();

  return (
    <div className="min-h-screen bg-surface text-ink">
      <CourseProvider
        track={access.track}
        signedIn={viewer.userId !== null}
        basePath={`/learn/${trackId}`}
      >
        <TopNav />
        <div className="flex items-start">
          <CourseSidebar />
          <main className="min-h-[calc(100vh-var(--nav-h))] flex-1 min-w-0">{children}</main>
        </div>
      </CourseProvider>
    </div>
  );
}
