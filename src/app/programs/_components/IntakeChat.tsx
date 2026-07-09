'use client';

// Chat intake Block 4: the /programs/new conversation pane. The transcript is
// CLIENT-held (never stored server-side — plan decision) and resent each turn
// as context; the server owns the draft and the turn budget. On `ready` the
// confirmation card renders from the server's draft, and "Create program" POSTs
// it through the shared submitProgram helper — the same public route, quota,
// burst, dedup, and validation as the form. Any dead end (exhausted budget,
// rate limit, fetch failure) points at the form toggle, the designed fallback.

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { NewProgramForm } from './NewProgramForm';
import { submitProgram, type GenerateProgramPayload } from './submit-program';

type ChatMessage = { role: 'user' | 'assistant'; content: string };

// Mirrors the route's body caps (message ≤ 1000 chars, transcript ≤ 30 msgs of
// ≤ 1000): the client clamps before sending so a long assistant reply or a
// huge ?goal= never turns into a 400.
const MSG_MAX = 1000;
const TRANSCRIPT_MAX = 30;

type IntakeResponse = {
  sessionId?: string;
  reply?: string;
  draft?: Partial<GenerateProgramPayload>;
  ready?: boolean;
  exhausted?: boolean;
  code?: string;
  error?: string;
};

function ConfirmationCard({ draft }: { draft: Partial<GenerateProgramPayload> }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onCreate() {
    setBusy(true);
    setError(null);
    // `ready` guaranteed the draft parses server-side; the cast mirrors that.
    const result = await submitProgram(draft as GenerateProgramPayload);
    if (result.ok) {
      router.push(`/programs/${result.programId}`);
      return;
    }
    setBusy(false);
    setError(result.message);
  }

  return (
    <div className="rounded-control border border-line bg-fill p-4">
      <div className="eyebrow mb-2">Your program</div>
      <dl className="flex flex-col gap-2 text-sm text-body">
        <div>
          <dt className="meta-xs">Goal</dt>
          <dd>{draft.goal}</dd>
        </div>
        {draft.background && (
          <div>
            <dt className="meta-xs">Background</dt>
            <dd>{draft.background}</dd>
          </div>
        )}
        <div>
          <dt className="meta-xs">Budget</dt>
          <dd>
            {draft.totalHoursPerWeek} h/week × {draft.totalWeeks} weeks
          </dd>
        </div>
        {draft.antiList && draft.antiList.length > 0 && (
          <div>
            <dt className="meta-xs">Excluded</dt>
            <dd>{draft.antiList.join(', ')}</dd>
          </div>
        )}
      </dl>
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      <button
        type="button"
        onClick={onCreate}
        disabled={busy}
        className="mt-4 w-full rounded-button bg-brand px-5 py-2.5 font-semibold text-white disabled:opacity-50"
      >
        {busy ? 'Planning your program…' : 'Create program'}
      </button>
      <p className="meta-xs mt-2">Not quite right? Keep chatting below to revise it.</p>
    </div>
  );
}

export function IntakeChat({
  initialGoal,
  onFallbackToForm,
}: {
  initialGoal?: string;
  onFallbackToForm: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);
  const [draft, setDraft] = useState<Partial<GenerateProgramPayload> | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dead, setDead] = useState<string | null>(null); // terminal: exhausted / rate-limited / failed
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const seededRef = useRef(false);

  async function send(text: string) {
    const message = text.trim().slice(0, MSG_MAX);
    if (!message || busy || dead) return;
    setBusy(true);
    const transcript = messages
      .map((m) => ({ ...m, content: m.content.slice(0, MSG_MAX) }))
      .slice(-TRANSCRIPT_MAX);
    setMessages((prev) => [...prev, { role: 'user', content: message }]);
    setInput('');

    let data: IntakeResponse;
    let status: number;
    try {
      const res = await fetch('/api/intake', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, message, transcript }),
      });
      status = res.status;
      data = await res.json().catch(() => ({}));
    } catch {
      setDead('The chat is unavailable right now — the form below works.');
      setBusy(false);
      return;
    }

    if (data.exhausted) {
      if (data.reply) setMessages((prev) => [...prev, { role: 'assistant', content: data.reply! }]);
      setDead('This conversation hit its length limit — finish up with the form below.');
    } else if (status === 200 && data.reply) {
      setSessionId(data.sessionId);
      setMessages((prev) => [...prev, { role: 'assistant', content: data.reply! }]);
      if (data.draft) setDraft(data.draft);
      setReady(Boolean(data.ready));
    } else if (data.code === 'RATE_LIMITED') {
      setDead('Too many chat sessions recently — use the form below, or come back in a bit.');
    } else {
      setDead('The chat hit a snag — the form below works.');
    }
    setBusy(false);
  }

  // The home scratchpad's ?goal= carry-through seeds and auto-sends the first
  // message. Ref-guarded so React strict-mode's double effect run (and any
  // re-render) can't burn a second turn.
  useEffect(() => {
    if (seededRef.current) return;
    seededRef.current = true;
    if (!initialGoal?.trim()) return;
    // Deferred a tick: the auto-send mutates state, which doesn't belong
    // synchronously inside an effect body. Cleanup re-arms the ref so strict
    // mode's mount→unmount→mount cycle sends exactly once (the first mount's
    // timer is cancelled, the second's fires).
    const t = setTimeout(() => void send(initialGoal), 0);
    return () => {
      clearTimeout(t);
      seededRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [messages, ready]);

  return (
    <div className="flex flex-col gap-4">
      {/* 55vh: one-off layout constant — tall enough for a conversation, short
          enough that the input stays in view on a laptop. */}
      <div className="flex max-h-[55vh] flex-col gap-3 overflow-y-auto">
        {messages.length === 0 && !busy && (
          <p className="text-sm text-muted">
            Tell me what you want to learn and I&apos;ll put a program together — goal, what you
            already know, and how much time you have.
          </p>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            className={
              m.role === 'user'
                ? 'ml-8 self-end rounded-control bg-brand px-3 py-2 text-sm text-white'
                : 'mr-8 self-start rounded-control bg-fill px-3 py-2 text-sm text-body'
            }
          >
            {m.content}
          </div>
        ))}
        {busy && <div className="mr-8 self-start rounded-control bg-fill px-3 py-2 text-sm text-muted">…</div>}
        {ready && draft && !dead && <ConfirmationCard draft={draft} />}
        <div ref={bottomRef} />
      </div>

      {dead ? (
        <p className="text-sm text-muted">{dead}</p>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send(input);
          }}
          className="flex gap-2"
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={busy}
            maxLength={MSG_MAX}
            placeholder={messages.length === 0 ? 'e.g. I want to be ready for first-year CS' : 'Reply…'}
            className="w-full rounded-control border border-line bg-surface px-3 py-2 text-sm text-ink disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={busy || !input.trim()}
            className="rounded-button bg-brand px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            Send
          </button>
        </form>
      )}
      {dead && (
        <button type="button" onClick={onFallbackToForm} className="meta-xs self-start underline">
          Open the form
        </button>
      )}
    </div>
  );
}

// The /programs/new pane: chat by default, the structured form behind a toggle
// (the turn-budget fallback and the chat-hater escape hatch).
export function IntakePane({ initialGoal }: { initialGoal?: string }) {
  const [mode, setMode] = useState<'chat' | 'form'>('chat');
  return (
    <div className="flex flex-col gap-4">
      {mode === 'chat' ? (
        <IntakeChat initialGoal={initialGoal} onFallbackToForm={() => setMode('form')} />
      ) : (
        <NewProgramForm defaultGoal={initialGoal} />
      )}
      <button
        type="button"
        onClick={() => setMode(mode === 'chat' ? 'form' : 'chat')}
        className="meta-xs self-center underline"
      >
        {mode === 'chat' ? 'Prefer a form?' : 'Prefer to chat?'}
      </button>
    </div>
  );
}
