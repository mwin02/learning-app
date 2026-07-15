// Unit tests for sanitizeProgramView — the Phase 3d non-creator projection.
// Audit 6.2 extended it to blank per-slot requestError (raw worker diagnostics)
// alongside the Program-level error.

import { describe, it, expect, vi } from 'vitest';
import type { ProgramView } from './program-view';

// program-view imports @/lib/db, which validates DATABASE_URL at module eval.
vi.mock('@/lib/db', () => ({ prisma: {} }));

const { sanitizeProgramView } = await import('./program-view');

function makeView(overrides: Partial<ProgramView> = {}): ProgramView {
  return {
    id: 'prog_1',
    goal: 'Become a data engineer',
    title: 'Data Engineering Path',
    description: 'A generated description',
    createdById: 'user_1',
    background: 'I know some SQL',
    totalHoursPerWeek: 10,
    totalWeeks: 12,
    antiList: ['no videos'],
    status: 'ready',
    error: 'PrismaClientKnownRequestError: connection refused at db.internal:5432',
    phases: [
      {
        label: 'Foundations',
        tracks: [
          {
            topic: 'python',
            phaseLabel: 'Foundations',
            orderInProgram: 1,
            priorityTier: 'core',
            trackId: 'track_1',
            title: 'Python for Data',
            trackStatus: 'ready',
            summary: 'Learn Python',
            lessonCount: 10,
            totalMinutes: 300,
            rationale: 'Core skill',
            requestStatus: 'done',
            requestError: null,
          },
          {
            topic: 'sql',
            phaseLabel: 'Foundations',
            orderInProgram: 2,
            priorityTier: 'core',
            trackId: null,
            title: null,
            trackStatus: null,
            summary: null,
            lessonCount: 0,
            totalMinutes: 0,
            rationale: null,
            requestStatus: 'failed',
            requestError: 'Vertex model projects/my-gcp-project/models/gemini timed out',
          },
        ],
      },
    ],
    trackCount: 2,
    builtCount: 1,
    coreCount: 2,
    totalLessons: 10,
    totalMinutes: 300,
    ...overrides,
  };
}

describe('sanitizeProgramView', () => {
  it('blanks the Program-level error', () => {
    expect(sanitizeProgramView(makeView()).error).toBeNull();
  });

  it('blanks requestError on every slot (audit 6.2)', () => {
    const sanitized = sanitizeProgramView(makeView());
    for (const phase of sanitized.phases) {
      for (const track of phase.tracks) {
        expect(track.requestError).toBeNull();
      }
    }
  });

  it('blanks the creator-private inputs and substitutes the title as goal', () => {
    const sanitized = sanitizeProgramView(makeView());
    expect(sanitized.background).toBeNull();
    expect(sanitized.antiList).toEqual([]);
    expect(sanitized.goal).toBe('Data Engineering Path');
  });

  it('falls back to a generic goal when there is no title', () => {
    expect(sanitizeProgramView(makeView({ title: null })).goal).toBe('Learning program');
  });

  it('preserves the non-private slot fields (status, counts, requestStatus)', () => {
    const sanitized = sanitizeProgramView(makeView());
    const [python, sql] = sanitized.phases[0].tracks;
    expect(python.title).toBe('Python for Data');
    expect(python.lessonCount).toBe(10);
    expect(sql.requestStatus).toBe('failed');
    expect(sanitized.status).toBe('ready');
    expect(sanitized.totalLessons).toBe(10);
  });

  it('does not mutate the input view', () => {
    const view = makeView();
    sanitizeProgramView(view);
    expect(view.error).not.toBeNull();
    expect(view.phases[0].tracks[1].requestError).not.toBeNull();
  });
});
