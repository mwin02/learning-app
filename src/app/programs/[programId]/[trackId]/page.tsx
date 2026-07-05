// Frontend redesign Block 1, reskinned in Block 4: the program-scoped course
// home. The [trackId] layout already gated access and bridged the shell's
// progress into the CourseContext; this route renders the notebook sheet.

import { Sheet } from '@/components/notebook/Sheet';
import { NotebookCourseHome } from '@/app/programs/_components/NotebookCourseHome';

export default function ProgramCourseHomePage() {
  return (
    <Sheet>
      <NotebookCourseHome />
    </Sheet>
  );
}
