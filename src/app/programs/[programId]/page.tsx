// Phase 2.75e (learn UI): the program-hub home page. The shell layout already loaded
// (and cache()'d) the access-checked ProgramView, so this route just renders the main
// column. Phase 3d: reads through getProgramAccess so the page can never render a
// less-sanitized view than the layout decided; when unenrolled, the layout shows the
// EnrollPrompt and this renders nothing.

import { notFound } from 'next/navigation';
import { getProgramAccess } from '@/lib/auth/program-access';
import { ProgramHome } from '../_components/ProgramHome';

export const dynamic = 'force-dynamic';

export default async function ProgramHomePage({
  params,
}: {
  params: Promise<{ programId: string }>;
}) {
  const { programId } = await params;
  const access = await getProgramAccess(programId);
  if (!access) notFound();
  if (!access.enrolled) return null; // the layout renders the EnrollPrompt instead
  return <ProgramHome program={access.view} />;
}
