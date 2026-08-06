'use client';

// Reports R7: where the two halves of this feature visibly become one loop —
// the learner reports a broken resource, and this is how they collect the fix.
//
// Structure follows ReportDialog (portal to <body>, Escape closes, backdrop
// click closes) for one reason beyond consistency: the panel holds a form, and
// rendering it inline would put its typing/Escape surface inside the notebook
// sheet's own handlers.
//
// The status read happens on open, not on mount: it is three queries per course
// home otherwise, for a dialog most visits never open.

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import {
  changeSummary,
  EDIT_HINT,
  formStateFrom,
  masteryOptions,
  NOTHING_CHANGED,
  PROGRESS_LINE,
  quotaLine,
  rebuildEdits,
  rebuildErrorMessage,
  type RebuildFormState,
  type RebuildStatus,
} from '@/lib/rebuild-view';
import { fetchRebuildStatus, submitRegenerate } from './submit-regenerate';

const inputCls =
  'w-full rounded border border-note-edge bg-note px-3 py-2 font-script text-sm text-script-body outline-none placeholder:italic placeholder:text-script-dim focus-visible:border-pen';

type Phase =
  | { kind: 'loading' }
  | { kind: 'form'; error: string | null }
  | { kind: 'sending' }
  | { kind: 'done'; message: string };

export function RegenerateDialog({ programId, trackId }: { programId: string; trackId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [status, setStatus] = useState<RebuildStatus | null>(null);
  const [form, setForm] = useState<RebuildFormState | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const close = () => {
    setOpen(false);
    setStatus(null);
    setForm(null);
    setPhase({ kind: 'loading' });
    triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    panelRef.current?.focus();
    let active = true;
    void fetchRebuildStatus(programId, trackId).then((result) => {
      if (!active) return;
      if (!result.ok) {
        setPhase({ kind: 'form', error: result.message });
        return;
      }
      setStatus(result.status);
      setForm(formStateFrom(result.status.inputs));
      setPhase({ kind: 'form', error: null });
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      active = false;
      document.removeEventListener('keydown', onKey);
    };
  }, [open, programId, trackId]);

  const edits = status && form ? rebuildEdits(status.inputs, form) : {};
  const changed = status ? changeSummary(status.staleness) : [];
  // R5's precondition 4, mirrored so the refusal is visible before it is spent:
  // an unedited form off an unchanged course would be refused as `not_stale`.
  const canSubmit =
    !!status && !status.rebuilding && status.quota.allowed && (status.staleness.stale || Object.keys(edits).length > 0);

  const set = (patch: Partial<RebuildFormState>) => setForm((f) => (f ? { ...f, ...patch } : f));

  const send = async () => {
    if (!status || !form || phase.kind === 'sending') return;
    setPhase({ kind: 'sending' });
    const result = await submitRegenerate(programId, trackId, rebuildEdits(status.inputs, form));
    if (!result.ok) {
      setPhase({ kind: 'form', error: result.message });
      return;
    }
    setPhase({ kind: 'done', message: result.message });
    // The program shell renders the in-flight/building affordances off server
    // state, so a refresh is what hands this rebuild over to AutoRefresh.
    router.refresh();
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className="btn-doodle px-3.5 py-0.5 text-[19px]"
      >
        Rebuild this course
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
              aria-label="Rebuild this course"
              tabIndex={-1}
              onClick={(e) => e.stopPropagation()}
              className="max-h-[85vh] w-full max-w-[480px] overflow-y-auto rounded-[10px_12px_10px_12px] border-2 border-rule bg-paper p-5 shadow-[0_10px_28px_rgba(0,0,0,.3)] outline-none"
            >
              <div className="font-hand text-[26px] font-bold leading-none text-script">
                Rebuild this course
              </div>

              {phase.kind === 'done' ? (
                <>
                  <p className="mb-0 mt-4 font-script text-sm leading-[26px] text-script-body">
                    {phase.message}
                  </p>
                  <div className="mt-4 flex justify-end">
                    <button type="button" onClick={close} className="btn-ink px-4 py-1 text-[19px]">
                      Done
                    </button>
                  </div>
                </>
              ) : (
                <>
                  {phase.kind === 'loading' && (
                    <p className="mb-0 mt-4 font-script text-sm text-script-dim" role="status">
                      Checking what has changed…
                    </p>
                  )}

                  {status && form && (
                    <>
                      <div className="mt-4 rounded-[8px] border border-note-edge bg-note px-3 py-2.5">
                        {changed.length > 0 ? (
                          <ul className="m-0 list-none space-y-1 p-0 font-script text-sm text-script-body">
                            {changed.map((line) => (
                              <li key={line} className="flex gap-2">
                                <span className="flex-none text-pen">→</span>
                                {line}
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="mb-0 font-script text-sm text-script-body">{NOTHING_CHANGED}</p>
                        )}
                      </div>

                      <p className="mb-0 mt-3.5 font-script text-xs text-script-dim">{EDIT_HINT}</p>

                      <div className="mt-2 flex flex-col gap-3">
                        <label className="flex flex-col gap-1">
                          <span className="nb-kicker text-[11px] text-note-label">What you want from it</span>
                          <textarea
                            value={form.goal}
                            maxLength={2000}
                            rows={3}
                            disabled={phase.kind === 'sending'}
                            onChange={(e) => set({ goal: e.target.value })}
                            placeholder="e.g. Enough calculus to start a stats course"
                            className={inputCls}
                          />
                        </label>
                        <label className="flex flex-col gap-1">
                          <span className="nb-kicker text-[11px] text-note-label">How far you want to get</span>
                          <select
                            value={form.targetMastery}
                            disabled={phase.kind === 'sending'}
                            onChange={(e) => set({ targetMastery: e.target.value })}
                            className={inputCls}
                          >
                            <option value="">No preference</option>
                            {masteryOptions().map((o) => (
                              <option key={o.value} value={o.value}>
                                {o.label}
                              </option>
                            ))}
                          </select>
                        </label>
                        <div className="flex gap-4">
                          <label className="flex flex-1 flex-col gap-1">
                            <span className="nb-kicker text-[11px] text-note-label">Weeks</span>
                            <input
                              type="number"
                              min={1}
                              max={52}
                              value={form.timeframeWeeks}
                              disabled={phase.kind === 'sending'}
                              onChange={(e) => set({ timeframeWeeks: e.target.value })}
                              className={inputCls}
                            />
                          </label>
                          <label className="flex flex-1 flex-col gap-1">
                            <span className="nb-kicker text-[11px] text-note-label">Hours / week</span>
                            <input
                              type="number"
                              min={1}
                              max={40}
                              value={form.hoursPerWeek}
                              disabled={phase.kind === 'sending'}
                              onChange={(e) => set({ hoursPerWeek: e.target.value })}
                              className={inputCls}
                            />
                          </label>
                        </div>
                      </div>

                      <p className="mb-0 mt-3.5 font-script text-xs text-script-dim">
                        {PROGRESS_LINE} {quotaLine(status.quota)}
                      </p>

                      {status.rebuilding && (
                        <p className="mb-0 mt-2 font-script text-xs text-crayon-red">
                          {rebuildErrorMessage('ALREADY_REBUILDING')}
                        </p>
                      )}
                      {!status.quota.allowed && (
                        <p className="mb-0 mt-2 font-script text-xs text-crayon-red">
                          {rebuildErrorMessage('FREE_LIMIT_REACHED', status.quota.limit)}
                        </p>
                      )}
                    </>
                  )}

                  {phase.kind === 'form' && phase.error && (
                    <p className="mb-0 mt-2 font-script text-xs text-crayon-red">{phase.error}</p>
                  )}

                  <div className="mt-4 flex items-center justify-end gap-3">
                    {phase.kind === 'sending' && (
                      <span className="mr-auto font-script text-2xs text-script-dim" role="status">
                        Queueing the rebuild…
                      </span>
                    )}
                    <button type="button" onClick={close} className="btn-doodle px-3.5 py-0.5 text-[19px]">
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={!canSubmit || phase.kind === 'sending'}
                      onClick={send}
                      className="btn-ink px-4 py-1 text-[19px] disabled:opacity-50"
                    >
                      Rebuild
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
