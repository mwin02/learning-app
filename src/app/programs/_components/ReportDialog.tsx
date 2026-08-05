'use client';

// Reports R3: the learner-facing defect channel, sitting next to RatingButtons.
// A vote is taste; this names WHICH defect, so triage can act on the right axis.
//
// Two hard-won constraints from RatingButtons, both about where this lives:
//   - several placements sit inside an <a> / a <details> summary, so every click
//     preventDefaults + stopPropagates — reporting must never navigate the row or
//     toggle the disclosure it sits in.
//   - the panel itself is PORTALED to <body>. Rendering it inline would put a
//     form (and its Escape/typing/click surface) inside that same anchor or
//     summary; out of the DOM subtree, its native events can't reach either.
//
// No aggregate report counts, same reasoning as the vote toggles.

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ReportCategory } from '@prisma/client';
import { NOTE_MAX_CHARS, pendingLabelFor, reportCategoryOptions } from '@/lib/report-view';
import { submitReport } from './submit-report';

function FlagIcon({ size = 14 }: { size?: number }) {
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
      <path d="M5 21V4m0 0h11.5l-2 4 2 4H5" />
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

  const close = () => {
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
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
      setCategory(null);
      setNote('');
      setPhase({ kind: 'form', error: null });
      triggerRef.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const stop = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const send = async (e: React.MouseEvent) => {
    stop(e);
    if (!category || phase.kind === 'sending') return;
    setPhase({ kind: 'sending' });
    const trimmed = note.trim();
    const result = await submitReport({
      resourceId,
      category,
      ...(lessonId ? { lessonId } : {}),
      ...(trimmed ? { note: trimmed } : {}),
    });
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
        <FlagIcon />
      </button>

      {open &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
            onClick={(e) => {
              stop(e);
              close();
            }}
          >
            <div
              ref={panelRef}
              role="dialog"
              aria-modal="true"
              aria-label="Report a problem"
              tabIndex={-1}
              onClick={stop}
              className="max-h-[85vh] w-full max-w-[420px] overflow-y-auto rounded-[10px_12px_10px_12px] border-2 border-rule bg-paper p-5 shadow-[0_10px_28px_rgba(0,0,0,.3)] outline-none"
            >
              <div className="font-hand text-[26px] font-bold leading-none text-script">
                Report a problem
              </div>
              <div className="mt-1 truncate font-script text-2xs text-script-dim">{resourceTitle}</div>

              {phase.kind === 'done' ? (
                <>
                  <p className="mb-0 mt-4 font-script text-sm leading-[26px] text-script-body">
                    {phase.message}
                  </p>
                  <div className="mt-4 flex justify-end">
                    <button
                      type="button"
                      onClick={(e) => {
                        stop(e);
                        close();
                      }}
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
                          onClick={(e) => e.stopPropagation()}
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
                    onClick={(e) => e.stopPropagation()}
                    placeholder="Anything else we should know? (optional)"
                    aria-label="Optional note"
                    rows={3}
                    className="mt-3 w-full resize-y rounded-[6px] border border-rule bg-card p-2.5 font-script text-sm text-script-body placeholder:text-script-dim"
                  />

                  {phase.kind === 'form' && phase.error && (
                    <p className="mb-0 mt-2 font-script text-2xs text-crayon-red">{phase.error}</p>
                  )}

                  <div className="mt-4 flex items-center justify-end gap-3">
                    {phase.kind === 'sending' && (
                      <span className="mr-auto font-script text-2xs text-script-dim" role="status">
                        {pendingLabelFor(category ?? 'other')}
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={(e) => {
                        stop(e);
                        close();
                      }}
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
