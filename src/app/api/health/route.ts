import { generateText } from 'ai';
import { getModel } from '@/lib/models';

export async function GET(request: Request) {
  const probe = new URL(request.url).searchParams.get('probe');

  if (probe !== 'ai') {
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
    return Response.json(
      { ok: false, error: (err as Error).message },
      { status: 500 },
    );
  }
}
