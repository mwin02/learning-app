import { generateText } from 'ai';
import { getModel } from '@/lib/ai/models';
import { devBypass, getSessionUserId } from '@/lib/api/with-auth';
import { isAdmin } from '@/lib/api/with-admin-auth';

export async function GET(request: Request) {
  const probe = new URL(request.url).searchParams.get('probe');

  // H2 (audit 9.2): the AI probe fires a live (billed) model call, so it is
  // admin-only. Non-admins asking for probe=ai get the plain liveness body —
  // same shape as no probe at all, so the gated path isn't enumerable.
  if (probe !== 'ai' || !((await isAdmin(await getSessionUserId())) || devBypass())) {
    return Response.json({ ok: true, ts: Date.now() });
  }

  try {
    const { model, modelId, temperature, maxOutputTokens } = getModel('health');
    const { text, usage } = await generateText({
      model,
      temperature,
      maxOutputTokens,
      prompt: 'Reply with the single word: pong',
    });
    // TODO(observability): replace with structured logging once multiple
    // agents are in flight. For now this is enough to spot-check usage.
    console.log('[health] call', { modelId, usage });
    return Response.json({ ok: true, model: modelId, reply: text, usage });
  } catch (err) {
    // H2 (audit 9.2): don't echo err.message — provider errors can carry
    // project/model internals. Details go to the server log only.
    console.error('[health] AI probe failed', err);
    return Response.json({ ok: false, error: 'AI probe failed' }, { status: 500 });
  }
}
