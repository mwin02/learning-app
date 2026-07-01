// Phase 2.75e (learn UI): the program-hub shell. Loads the ProgramView once (server,
// cache()'d so the page's load is free) and renders the design-system chrome — the
// surface background, the sticky ProgramTopNav, and the sticky ProgramSidebar listing
// the constituent Tracks — around the main column. Mirrors the course player's
// /learn/[trackId] layout one level up, but the program hub needs no client progress
// provider: it's a read-only overview that links into each Track's own player.

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getProgramView } from '@/lib/program-view';
import { ProgramTopNav } from '../_components/ProgramTopNav';
import { ProgramSidebar } from '../_components/ProgramSidebar';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ programId: string }>;
}): Promise<Metadata> {
  const { programId } = await params;
  const program = await getProgramView(programId);
  if (!program) return {};
  return { title: program.goal };
}

export default async function ProgramLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ programId: string }>;
}) {
  const { programId } = await params;
  const program = await getProgramView(programId);
  if (!program) notFound();

  return (
    <div className="min-h-screen bg-surface text-ink">
      <ProgramTopNav builtCount={program.builtCount} trackCount={program.trackCount} />
      <div className="flex items-start">
        <ProgramSidebar program={program} />
        <main className="min-h-[calc(100vh-var(--nav-h))] flex-1 min-w-0">{children}</main>
      </div>
    </div>
  );
}
