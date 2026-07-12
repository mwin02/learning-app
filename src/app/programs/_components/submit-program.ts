// Chat intake Block 4: the ONE place a client submits a program creation. The
// form and the chat confirmation card both call this, so the /api/generate-program
// error vocabulary maps to user-facing copy exactly once — no duplicated strings.

export type GenerateProgramPayload = {
  goal: string;
  background?: string;
  totalHoursPerWeek: number;
  totalWeeks: number;
  antiList?: string[];
};

export type SubmitProgramResult =
  | { ok: true; programId: string }
  | { ok: false; message: string };

function messageFor(code: unknown, details: unknown): string {
  const limit =
    details && typeof details === 'object' && 'limit' in details ? String(details.limit) : '';
  switch (code) {
    case 'FREE_LIMIT_REACHED':
      return `You've reached the free limit of ${limit} programs this month.`;
    case 'PLAN_EMPTY':
      return 'We could not turn that goal into a program — try a more specific learning goal.';
    case 'GOAL_REJECTED':
      return 'That goal is outside the subjects we cover (math, natural sciences, computer science).';
    case 'RATE_LIMITED':
      return 'Too many programs created recently — please wait a bit and try again.';
    case 'INVALID_INPUT':
      return 'Please check the form — some fields are invalid.';
    default:
      return 'Something went wrong. Please try again.';
  }
}

export async function submitProgram(payload: GenerateProgramPayload): Promise<SubmitProgramResult> {
  let res: Response;
  try {
    res = await fetch('/api/generate-program', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    return { ok: false, message: 'Something went wrong. Please try again.' };
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 202 && data.programId) return { ok: true, programId: data.programId };
  return { ok: false, message: messageFor(data.code, data.details) };
}
