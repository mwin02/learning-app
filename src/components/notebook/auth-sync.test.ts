import { describe, it, expect } from 'vitest';
import { decideAuthSync } from './auth-sync';

describe('decideAuthSync', () => {
  it('does nothing while both sides agree', () => {
    expect(decideAuthSync(null, true, true)).toEqual({ refresh: false, actedOn: null });
    expect(decideAuthSync(null, false, false)).toEqual({ refresh: false, actedOn: null });
  });

  it('refreshes when the session ended under a signed-in header', () => {
    expect(decideAuthSync(null, true, false)).toEqual({ refresh: true, actedOn: false });
  });

  it('refreshes when the viewer signed in elsewhere under a signed-out header', () => {
    expect(decideAuthSync(null, false, true)).toEqual({ refresh: true, actedOn: true });
  });

  it('refreshes only once while the server keeps rejecting the browser session', () => {
    const first = decideAuthSync(null, false, true);
    expect(first.refresh).toBe(true);
    expect(decideAuthSync(first.actedOn, false, true)).toEqual({ refresh: false, actedOn: true });
  });

  it('re-arms once the sides agree, so a later divergence still refreshes', () => {
    const settled = decideAuthSync(false, true, true);
    expect(settled).toEqual({ refresh: false, actedOn: null });
    expect(decideAuthSync(settled.actedOn, true, false)).toEqual({ refresh: true, actedOn: false });
  });

  it('acts again when the browser state flips away from the one already acted on', () => {
    expect(decideAuthSync(false, true, true)).toEqual({ refresh: false, actedOn: null });
    expect(decideAuthSync(true, true, false)).toEqual({ refresh: true, actedOn: false });
  });
});
