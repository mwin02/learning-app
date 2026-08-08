import { describe, expect, it } from 'vitest';
import { resolveReplacementTrack, type RebuildEdge } from '@/lib/services/track-replacement';

const member = (...ids: string[]) => (id: string) => ids.includes(id);

describe('resolveReplacementTrack', () => {
  it('resolves a single rebuild to the Track the plan now points at', () => {
    const edges: RebuildEdge[] = [{ replacesTrackId: 'a', trackId: 'b' }];
    expect(resolveReplacementTrack('a', edges, member('b'))).toBe('b');
  });

  it('walks a chain of rebuilds to the current member', () => {
    const edges: RebuildEdge[] = [
      { replacesTrackId: 'a', trackId: 'b' },
      { replacesTrackId: 'b', trackId: 'c' },
    ];
    expect(resolveReplacementTrack('a', edges, member('c'))).toBe('c');
  });

  it('returns null for a track that was never rebuilt (no access regression)', () => {
    expect(resolveReplacementTrack('x', [{ replacesTrackId: 'a', trackId: 'b' }], member('b'))).toBeNull();
  });

  it('returns null when no successor is a current member', () => {
    const edges: RebuildEdge[] = [{ replacesTrackId: 'a', trackId: 'b' }];
    expect(resolveReplacementTrack('a', edges, member('z'))).toBeNull();
  });

  it('prefers the newest successor when both rebuilds of a Track are members', () => {
    const edges: RebuildEdge[] = [
      { replacesTrackId: 'a', trackId: 'b' },
      { replacesTrackId: 'a', trackId: 'c' },
    ];
    expect(resolveReplacementTrack('a', edges, member('b', 'c'))).toBe('c');
  });

  // The newest rebuild fulfilled but never repointed the slot (a sibling build was
  // still in flight), so the older one still owns it.
  it('falls back to an older successor when the newest one never took the slot', () => {
    const edges: RebuildEdge[] = [
      { replacesTrackId: 'a', trackId: 'b' },
      { replacesTrackId: 'a', trackId: 'c' },
    ];
    expect(resolveReplacementTrack('a', edges, member('b'))).toBe('b');
  });

  it('searches past a dead-end branch to a member deeper in another one', () => {
    const edges: RebuildEdge[] = [
      { replacesTrackId: 'a', trackId: 'b' },
      { replacesTrackId: 'b', trackId: 'd' },
      { replacesTrackId: 'a', trackId: 'c' },
    ];
    expect(resolveReplacementTrack('a', edges, member('d'))).toBe('d');
  });

  it('does not loop forever on a cyclic edge set', () => {
    const edges: RebuildEdge[] = [
      { replacesTrackId: 'a', trackId: 'b' },
      { replacesTrackId: 'b', trackId: 'a' },
    ];
    expect(resolveReplacementTrack('a', edges, member('z'))).toBeNull();
  });
});
