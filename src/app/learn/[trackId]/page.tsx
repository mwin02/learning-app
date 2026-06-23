// Phase 2.6 (learn UI), Block C: the course home/summary page. The shell layout
// already loaded the Track into the CourseProvider, so this route just renders the
// main column — CourseHome reads everything from the shared course context.

import { CourseHome } from '../_components/CourseHome';

export default function CourseHomePage() {
  return <CourseHome />;
}
