'use client';

// Reports R3: the learner-facing defect channel, sitting next to RatingButtons.
// A vote is taste; this names WHICH defect, so triage can act on the right axis.
//
// Two hard-won constraints from RatingButtons, both about where this lives:
//   - several placements sit inside an <a> / a <details> summary, so the TRIGGER's
//     click preventDefaults + stopPropagates — reporting must never navigate the
//     row or toggle the disclosure it sits in. Inside the panel, only
//     stopPropagation (see `stop` below).
//   - the panel itself is PORTALED to <body>. Rendering it inline would put a
//     form (and its Escape/typing/click surface) inside that same anchor or
//     summary; out of the DOM subtree, its native events can't reach either.
//
// No aggregate report counts, same reasoning as the vote toggles.

import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ReportCategory } from '@prisma/client';
import { NOTE_MAX_CHARS, pendingLabelFor, reportCategoryOptions, tabStops } from '@/lib/report-view';
import { submitReport } from './submit-report';

// Warning triangle rather than a flag: "flag" reads as bookmark/save in a
// reading surface sitting next to thumbs, and this control reports a defect.
function AlertIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  );
}

type Phase = { kind: 'form'; error: string | null } | { kind: 'sending' } | { kind: 'done'; message: string };

export function ReportDialog({
  resourceId,
  lessonId,
  generated = false,
  resourceTitle,
}: {
  resourceId: string;
  // Ambient placement context: WHERE the learner hit this. R4 triages
  // wrong_lesson_fit on it, so a placement defect stays distinguishable from a
  // defect in the resource row itself.
  lessonId?: string;
  generated?: boolean;
  resourceTitle: string;
}) {
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<ReportCategory | null>(null);
  const [note, setNote] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'form', error: null });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const doneRef = useRef<HTMLButtonElement>(null);
  const ackId = useId();
  // Generation counter for in-flight sends. The dead-link probe is synchronous and
  // bounded at 6s, so a learner can close (Escape or Cancel) seconds before the
  // response lands; without this, the late `done` write reopens onto the
  // acknowledgement screen with no picker. Every close invalidates the send it
  // interrupted.
  const sendId = useRef(0);

  const close = () => {
    sendId.current += 1;
    setOpen(false);
    setCategory(null);
    setNote('');
    setPhase({ kind: 'form', error: null });
    triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
        return;
      }
      // `aria-modal` only asserts that the rest of the page is inert; nothing
      // enforces it, so Tab is cycled inside the panel by hand.
      if (e.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = Array.from(
        panel.querySelectorAll<HTMLElement>('button:not([disabled]), textarea:not([disabled]), input:not([disabled])')
      );
      // tabStops, not DOM order: a radio group is ONE stop, and it is the checked
      // radio — see the comment on tabStops for what DOM order breaks.
      const stops = tabStops(focusable, (el) =>
        el instanceof HTMLInputElement && el.type === 'radio' ? { radioGroup: el.name, checked: el.checked } : {}
      );
      if (stops.length === 0) return;
      const first = stops[0];
      const last = stops[stops.length - 1];
      const active = document.activeElement;
      // Focus outside the panel entirely: the panel itself (tabIndex -1, where it
      // starts), or <body>, where the browser drops it when "Send report" disables
      // itself mid-send — a failure the phase-flip effect below cannot fix, since a
      // send that comes back with an error never reaches the `done` phase.
      if (active === panel || !(active instanceof Node) || !panel.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
        return;
      }
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  // The acknowledgement swap unmounts the button that was focused, which drops
  // focus to <body> — outside the dialog, with nothing announced. Move it to the
  // one control the new screen has.
  useEffect(() => {
    if (phase.kind === 'done') doneRef.current?.focus();
  }, [phase.kind]);

  // Trigger-only. Several placements sit inside an <a> or a <details> summary, so
  // opening the dialog must not navigate or toggle them. NOTHING inside the panel
  // may use this: the panel is portaled to <body>, well clear of those elements,
  // and preventDefault there cancels the <label> activation behaviour that
  // forwards a click to its radio — which is what made the picker respond only to
  // a direct hit on the ~13px dot.
  const stop = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const send = async () => {
    if (!category || phase.kind === 'sending') return;
    const id = ++sendId.current;
    setPhase({ kind: 'sending' });
    const trimmed = note.trim();
    const result = await submitReport({
      resourceId,
      category,
      ...(lessonId ? { lessonId } : {}),
      ...(trimmed ? { note: trimmed } : {}),
    });
    if (sendId.current !== id) return;
    setPhase(result.ok ? { kind: 'done', message: result.message } : { kind: 'form', error: result.message });
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={`Report a problem with ${resourceTitle}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Report a problem"
        onClick={(e) => {
          stop(e);
          setOpen(true);
        }}
        className="inline-flex h-7 w-7 flex-none items-center justify-center rounded-full border border-transparent text-script-dim transition-colors hover:border-rule hover:text-crayon-red"
      >
        <AlertIcon />
      </button>

      {open &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
            onClick={close}
          >
            <div
              ref={panelRef}
              role="dialog"
              aria-modal="true"
              aria-label="Report a problem"
              tabIndex={-1}
              onClick={(e) => e.stopPropagation()}
              className="max-h-[85vh] w-full max-w-[420px] overflow-y-auto rounded-[10px_12px_10px_12px] border-2 border-rule bg-paper p-5 shadow-[0_10px_28px_rgba(0,0,0,.3)] outline-none"
            >
              <div className="font-hand text-[26px] font-bold leading-none text-script">
                Report a problem
              </div>
              <div className="mt-1 truncate font-script text-2xs text-script-dim">{resourceTitle}</div>

              {phase.kind === 'done' ? (
                <>
                  <p id={ackId} className="mb-0 mt-4 font-script text-sm leading-[26px] text-script-body">
                    {phase.message}
                  </p>
                  <div className="mt-4 flex justify-end">
                    <button
                      ref={doneRef}
                      type="button"
                      // NOT a live region: this <p> is inserted already holding its
                      // text, as part of the whole-subtree phase swap, and a
                      // pre-populated region is not reliably announced (VoiceOver
                      // drops it). Describing the button we move focus to says it
                      // once, deterministically — and acknowledgementFor's branches
                      // differ in substance, so silence would hide WHICH happened.
                      aria-describedby={ackId}
                      onClick={close}
                      className="btn-ink px-4 py-1 text-[19px]"
                    >
                      Done
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="mt-4 flex flex-col gap-1.5">
                    {reportCategoryOptions({ generated }).map((opt) => (
                      <label
                        key={opt.value}
                        className="flex cursor-pointer items-center gap-2.5 rounded-[8px] px-2 py-1.5 font-script text-sm text-script-body hover:bg-note"
                      >
                        <input
                          type="radio"
                          name={`report-${resourceId}`}
                          value={opt.value}
                          checked={category === opt.value}
                          disabled={phase.kind === 'sending'}
                          onChange={() => setCategory(opt.value)}
                          className="accent-[var(--color-pen)]"
                        />
                        {opt.label}
                      </label>
                    ))}
                  </div>

                  <textarea
                    value={note}
                    maxLength={NOTE_MAX_CHARS}
                    disabled={phase.kind === 'sending'}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="Anything else we should know? (optional)"
                    aria-label="Optional note"
                    rows={3}
                    className="mt-3 w-full resize-y rounded-[6px] border border-rule bg-card p-2.5 font-script text-sm text-script-body placeholder:text-script-dim"
                  />

                  {phase.kind === 'form' && phase.error && (
                    <p role="alert" className="mb-0 mt-2 font-script text-2xs text-crayon-red">
                      {phase.error}
                    </p>
                  )}

                  <div className="mt-4 flex items-center justify-end gap-3">
                    {phase.kind === 'sending' && (
                      <span className="mr-auto font-script text-2xs text-script-dim" role="status">
                        {pendingLabelFor(category ?? 'other')}
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={close}
                      className="btn-doodle px-3.5 py-0.5 text-[19px]"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={!category || phase.kind === 'sending'}
                      onClick={send}
                      className="btn-ink px-4 py-1 text-[19px] disabled:opacity-50"
                    >
                      Send report
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
