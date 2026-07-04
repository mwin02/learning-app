// Phase 3d: the one request-scoped answer to "what may this viewer see of this
// Program?" — shared by the program layout, page, and generateMetadata (cache()
// dedupes). Composes the viewer (session/role) with the ProgramView and applies
// the privacy rule from 3a/3c: goal/background/antiList are creator-private;
// everyone else (enrolled learners included) gets the sanitized view whose
// heading is the generated title.

import { cache } from 'react';
import { getProgramView, sanitizeProgramView, type ProgramView } from '@/lib/program-view';
import { getViewer, isEnrolledInProgram } from '@/lib/auth/viewer';

export type ProgramAccess = {
  view: ProgramView;
  enrolled: boolean;
  isCreator: boolean;
};

export const getProgramAccess = cache(async (programId: string): Promise<ProgramAccess | null> => {
  const [viewer, raw] = await Promise.all([getViewer(), getProgramView(programId)]);
  if (!raw) return null;
  const isCreator = viewer.userId != null && raw.createdById === viewer.userId;
  const privileged = viewer.isAdmin || isCreator;
  const enrolled =
    privileged || (viewer.userId ? await isEnrolledInProgram(viewer.userId, programId) : false);
  return { view: privileged ? raw : sanitizeProgramView(raw), enrolled, isCreator };
});
