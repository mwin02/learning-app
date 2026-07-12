'use client';

// Chat intake Block 4: the /programs/new conversation pane. The transcript is
// CLIENT-held (never stored server-side — plan decision) and resent each turn
// as context; the server owns the draft and the turn budget. On `ready` the
// confirmation card renders from the server's draft, and "Create program" POSTs
// it through the shared submitProgram helper — the same public route, quota,
// burst, dedup, and validation as the form. A true dead end (exhausted budget,
// rate limit) points at the form toggle, the designed fallback — and hands it
// the gathered draft so nothing is retyped. Transient faults (network, 5xx)
// are retryable in place: the server deliberately does NOT count a failed
// turn, so the client must not kill the conversation over one.

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { NewProgramForm } from './NewProgramForm';
import { submitProgram, type GenerateProgramPayload } from './submit-program';

type ChatMessage = { role: 'user' | 'assistant'; content: string };

// Mirrors the route's default caps (message ≤ 1000 chars, transcript ≤ 30 msgs
// of ≤ 1000) so a long assistant reply or a huge ?goal= is clamped before
// sending. Best-effort only: the route SLICES an over-long transcript to its
// own (env-tunable) cap rather than rejecting, so a mismatch degrades to
// trimmed context, never a 400.
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

  // The taped sticky note: the draft pinned to the sheet, ready to submit.
  return (
    <div className="-rotate-[0.4deg] self-stretch rounded border border-note-edge bg-note p-4 shadow-[0_2px_5px_rgba(0,0,0,.07)]">
      <div className="nb-kicker mb-2 text-note-label">✎ your program —</div>
      <dl className="flex flex-col gap-2 font-script text-sm text-script-body">
        <div>
          <dt className="nb-kicker text-[11px] text-note-label">Goal</dt>
          <dd>{draft.goal}</dd>
        </div>
        {draft.background && (
          <div>
            <dt className="nb-kicker text-[11px] text-note-label">Background</dt>
            <dd>{draft.background}</dd>
          </div>
        )}
        <div>
          <dt className="nb-kicker text-[11px] text-note-label">Budget</dt>
          <dd>
            {draft.totalHoursPerWeek} h/week × {draft.totalWeeks} weeks
          </dd>
        </div>
        {draft.antiList && draft.antiList.length > 0 && (
          <div>
            <dt className="nb-kicker text-[11px] text-note-label">Excluded</dt>
            <dd>{draft.antiList.join(', ')}</dd>
          </div>
        )}
      </dl>
      {error && <p className="mt-3 font-script text-sm text-crayon-red">{error}</p>}
      <button
        type="button"
        onClick={onCreate}
        disabled={busy}
        className="btn-ink mt-4 -rotate-[0.5deg] px-6 py-1.5 text-[24px] disabled:opacity-50"
      >
        {busy ? 'Planning your program…' : 'Create program →'}
      </button>
      <p className="mt-2 font-script text-xs text-script-faint">
        Not quite right? Keep chatting below to revise it.
      </p>
    </div>
  );
}

export function IntakeChat({
  initialGoal,
  onFallbackToForm,
  onDraftChange,
}: {
  initialGoal?: string;
  onFallbackToForm: () => void;
  // Reports the server's latest draft upward so the form fallback can be
  // seeded from it (nothing gathered is lost when the chat dead-ends).
  onDraftChange?: (draft: Partial<GenerateProgramPayload>) => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // The home scratchpad's ?goal= carry-through PREFILLS the input; the learner
  // presses Send. (It used to auto-send on mount, but that burned an
  // IntakeSession + a Flash call on every reload of /programs/new?goal=… —
  // five reloads rate-limited the user out of chat without them typing a word.
  // Visiting the page must cost nothing until the user acts.)
  const [input, setInput] = useState(() => (initialGoal ?? '').trim().slice(0, MSG_MAX));
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);
  const [draft, setDraft] = useState<Partial<GenerateProgramPayload> | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dead, setDead] = useState<string | null>(null); // terminal: exhausted / rate-limited / rejected
  const [notice, setNotice] = useState<string | null>(null); // transient: retry is fine
  const bottomRef = useRef<HTMLDivElement | null>(null);

  // A transient fault: un-append the optimistic user bubble and put the
  // message back in the input so Send retries it verbatim. The server didn't
  // count the turn, so neither should the UI.
  function retryable(message: string, why: string) {
    setMessages((prev) => prev.slice(0, -1));
    setInput(message);
    setNotice(why);
  }

  async function send(text: string) {
    const message = text.trim().slice(0, MSG_MAX);
    if (!message || busy || dead) return;
    setBusy(true);
    setNotice(null);
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
      retryable(message, 'That didn’t go through — check your connection and send it again.');
      setBusy(false);
      return;
    }

    if (data.exhausted) {
      if (data.reply) setMessages((prev) => [...prev, { role: 'assistant', content: data.reply! }]);
      setDead('This conversation hit its length limit — finish up with the form below.');
    } else if (status === 200 && data.reply) {
      setSessionId(data.sessionId);
      setMessages((prev) => [...prev, { role: 'assistant', content: data.reply! }]);
      if (data.draft) {
        setDraft(data.draft);
        onDraftChange?.(data.draft);
      }
      setReady(Boolean(data.ready));
    } else if (data.code === 'RATE_LIMITED') {
      setDead('Too many chat sessions recently — use the form below, or come back in a bit.');
    } else if (status >= 500 || status === 200) {
      // 5xx (the route deliberately did NOT count the turn) or a 200 missing
      // its reply — one hiccup must not forfeit the conversation.
      retryable(message, 'That didn’t go through — send it again.');
    } else {
      // 4xx: something structurally wrong (stale/closed session, bad body) —
      // retrying the same request can't help.
      setDead('The chat hit a snag — the form below works.');
    }
    setBusy(false);
  }

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [messages, ready]);

  return (
    <div className="flex flex-col gap-4">
      {/* 55vh: one-off layout constant — tall enough for a conversation, short
          enough that the input stays in view on a laptop. */}
      {/* overflow-x-hidden: the tilted sticky notes poke a hair past the
          column edge; without it the tilt creates a horizontal scrollbar. The
          scrollbar itself is thinned + tinted to the ruling so the default
          bright bar doesn't sit on the paper. */}
      <div className="flex max-h-[55vh] flex-col gap-3 overflow-y-auto overflow-x-hidden px-1 [scrollbar-color:var(--color-rule)_transparent] [scrollbar-width:thin]">
        {messages.length === 0 && !busy && (
          <p className="font-script text-md italic leading-relaxed text-script-faint">
            Tell me what you want to learn and I&apos;ll put a program together — goal, what you
            already know, and how much time you have.
          </p>
        )}
        {messages.map((m, i) => (
          // The learner's words go up as sticky notes; ours are written
          // straight onto the sheet in script.
          <div
            key={i}
            className={
              m.role === 'user'
                ? 'ml-10 self-end rotate-[0.6deg] rounded border border-note-edge bg-note px-[13px] py-[6px] font-script text-sm text-script-body shadow-[0_2px_5px_rgba(0,0,0,.07)]'
                : 'mr-10 self-start font-script text-md leading-relaxed text-script-body'
            }
          >
            {m.content}
          </div>
        ))}
        {busy && (
          <div className="mr-10 self-start font-script text-md italic text-script-dim">
            <span className="pencil-bob inline-block" aria-hidden>
              ✏️
            </span>{' '}
            writing…
          </div>
        )}
        {/* The card survives a dead chat on purpose: a ready draft that hit
            the turn budget is still submittable — killing it would break the
            exhausted reply's "your answers aren't lost" promise. */}
        {ready && draft && <ConfirmationCard draft={draft} />}
        <div ref={bottomRef} />
      </div>

      {notice && !dead && (
        <p className="font-script text-sm text-crayon-red" role="status">
          {notice}
        </p>
      )}
      {dead ? (
        <p className="max-w-[440px] rounded border border-note-edge bg-note px-3.5 py-2 font-script text-sm text-crayon-red">
          {dead}
        </p>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send(input);
          }}
          className="flex items-end gap-3"
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={busy}
            maxLength={MSG_MAX}
            placeholder={messages.length === 0 ? 'e.g. I want to be ready for first-year CS' : 'Reply…'}
            className="w-full border-b-2 border-rule bg-transparent px-0 py-1 font-script text-lg text-pen caret-pen outline-none placeholder:italic placeholder:text-script-dim focus-visible:border-pen disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={busy || !input.trim()}
            className="btn-ink px-5 py-1 text-[22px] disabled:opacity-50"
          >
            Send
          </button>
        </form>
      )}
      {dead && (
        <button
          type="button"
          onClick={onFallbackToForm}
          className="self-start font-script text-sm text-script-faint underline"
        >
          Open the form →
        </button>
      )}
    </div>
  );
}

// The /programs/new pane: chat by default, the structured form behind a toggle
// (the turn-budget fallback and the chat-hater escape hatch). The chat stays
// MOUNTED (hidden) while the form shows: unmounting discarded the sessionId,
// transcript, and server draft, so a toggle round-trip silently orphaned the
// conversation. The form is seeded from the chat's latest draft for the same
// reason — the fallback must carry the answers over, not restart.
export function IntakePane({ initialGoal }: { initialGoal?: string }) {
  const [mode, setMode] = useState<'chat' | 'form'>('chat');
  const [draft, setDraft] = useState<Partial<GenerateProgramPayload> | null>(null);
  return (
    <div className="flex flex-col gap-4">
      <div className={mode === 'chat' ? 'flex flex-col' : 'hidden'}>
        <IntakeChat
          initialGoal={initialGoal}
          onFallbackToForm={() => setMode('form')}
          onDraftChange={setDraft}
        />
      </div>
      {mode === 'form' && (
        <NewProgramForm defaultGoal={initialGoal} defaults={draft ?? undefined} />
      )}
      <button
        type="button"
        onClick={() => setMode(mode === 'chat' ? 'form' : 'chat')}
        className="self-center font-script text-sm text-script-faint underline"
      >
        {mode === 'chat' ? 'prefer a form? →' : 'prefer to chat? →'}
      </button>
    </div>
  );
}
