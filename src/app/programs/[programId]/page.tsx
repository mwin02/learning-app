// Phase 2.75e (learn UI): the program-hub home page. The shell layout already loaded
// (and cache()'d) the ProgramView, so this route just renders the main column.

import { notFound } from 'next/navigation';
import { getProgramView } from '@/lib/program-view';
import { ProgramHome } from '../_components/ProgramHome';

export const dynamic = 'force-dynamic';

export default async function ProgramHomePage({
  params,
}: {
  params: Promise<{ programId: string }>;
}) {
  const { programId } = await params;
  const program = await getProgramView(programId);
  if (!program) notFound();
  return <ProgramHome program={program} />;
}
