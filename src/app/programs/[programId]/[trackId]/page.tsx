// Frontend redesign Block 1: the program-scoped course home. The [trackId]
// layout already gated access and loaded the Track into the CourseProvider;
// this route just renders the shared main column.

import { CourseHome } from '@/app/learn/_components/CourseHome';

export default function ProgramCourseHomePage() {
  return <CourseHome />;
}
