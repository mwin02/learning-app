import { generateText } from 'ai';
import { geminiFlash } from '@/lib/vertex';

export async function GET(request: Request) {
  const probe = new URL(request.url).searchParams.get('probe');

  if (probe !== 'ai') {
    return Response.json({ ok: true, ts: Date.now() });
  }

  try {
    const { text } = await generateText({
      model: geminiFlash,
      prompt: 'Reply with the single word: pong',
    });
    return Response.json({ ok: true, model: 'gemini-2.5-flash', reply: text });
  } catch (err) {
    return Response.json(
      { ok: false, error: (err as Error).message },
      { status: 500 },
    );
  }
}
