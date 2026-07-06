// The app-wide top nav bar (frontend redesign): one consistent, distinct bar at
// the top of every page. Server component so it reads the session directly and
// adapts to auth state — signed-in viewers get the profile menu (Log out);
// everyone else gets a Sign in link. The logo lives here (removed from the
// per-page sheet headers, which used to each render their own brand).

import Link from 'next/link';
import { prisma } from '@/lib/db';
import { getViewer } from '@/lib/auth/viewer';
import { NotebookBrand } from './NotebookBrand';
import { ProfileMenu } from './ProfileMenu';

export async function TopNav() {
  // getViewer() is request-cache()'d, so this shares the lookup with any page/
  // layout below that also gates on the viewer — no extra session cost.
  const viewer = await getViewer();
  const user = viewer.userId
    ? await prisma.user.findUnique({
        where: { id: viewer.userId },
        select: { email: true, name: true },
      })
    : null;

  return (
    <header className="sticky top-0 z-20 flex h-[var(--nav-h)] flex-none items-center gap-3 border-b-2 border-rule bg-paper px-[26px] shadow-[0_2px_8px_rgba(0,0,0,0.06)]">
      <NotebookBrand href="/" />
      {viewer.userId && (
        <Link
          href="/programs"
          className="ml-1.5 rounded-[8px_10px_8px_10px] px-3 py-1 font-hand text-[21px] font-bold text-pen no-underline hover:bg-note"
        >
          Programs
        </Link>
      )}
      <div className="flex-1" />
      {viewer.userId ? (
        <ProfileMenu label={user?.name ?? user?.email ?? 'Account'} />
      ) : (
        <Link
          href="/signin"
          className="btn-doodle -rotate-1 px-4 py-[3px] text-[20px] no-underline"
        >
          Sign in
        </Link>
      )}
    </header>
  );
}
