// Notebook component gallery (frontend redesign, Block B). Admin-only preview
// of the prop-driven notebook components with mock data — lets us review the
// design language before the wired pages (dashboard, program shell, course
// overview) exist. Not linked from the user-facing app.

import { requireAdminPage } from '@/lib/auth/viewer';
import { PreviewGallery } from './PreviewGallery';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Notebook gallery · Playground' };

export default async function NotebookGalleryPage() {
  await requireAdminPage();
  return <PreviewGallery />;
}
