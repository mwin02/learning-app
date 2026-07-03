// Phase 3d: authorized loader for the course player — shared by the learn
// layout and its generateMetadata (cache() dedupes). Closes the known Phase-2.6
// gap: /learn/[trackId] used to render ANY Track by id, drafts included.
//
// Rules: admins (and the local dev bypass) see everything; a learner sees a
// Track only when (a) they're enrolled in a Program whose plan contains it —
// Tracks are internal, access always derives through a Program — and (b) the
// Track is `ready`. Unauthorized and nonexistent are the same `not_found` on
// purpose (don't confirm ids); a missing session is distinct so the layout can
// redirect to sign-in instead of 404ing someone who merely isn't logged in yet.

import { cache } from 'react';
import { getTrackView, type TrackView } from '@/lib/track-view';
import { getViewer, canViewTrack } from '@/lib/auth/viewer';

export type TrackAccess =
  | { kind: 'ok'; track: TrackView }
  | { kind: 'login' }
  | { kind: 'not_found' };

export const getAuthorizedTrackView = cache(async (trackId: string): Promise<TrackAccess> => {
  const viewer = await getViewer();
  if (!viewer.userId && !viewer.isAdmin) return { kind: 'login' };

  const track = await getTrackView(trackId);
  if (!track) return { kind: 'not_found' };
  if (viewer.isAdmin) return { kind: 'ok', track };

  if (track.status !== 'ready') return { kind: 'not_found' };
  if (!viewer.userId || !(await canViewTrack(viewer.userId, trackId))) {
    return { kind: 'not_found' };
  }
  return { kind: 'ok', track };
});
