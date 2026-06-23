// Phase 2.6 (learn UI): the "Key concepts" card. The source design had a
// "What you'll learn" outcomes grid, but we have no outcomes field — so this
// surfaces the track's distinct conceptsTaught as chips instead (real data).

import { MONO } from './primitives';

export function KeyConcepts({ concepts }: { concepts: string[] }) {
  if (concepts.length === 0) return null;
  return (
    <div className="mb-[26px] rounded-[14px] border border-[#e7eaef] bg-white px-[22px] py-5 shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
      <div className={`mb-[14px] text-[10px] tracking-[1.5px] text-[#9aa2ad] ${MONO}`}>
        KEY CONCEPTS
      </div>
      <div className="flex flex-wrap gap-2">
        {concepts.map((concept) => (
          <span
            key={concept}
            className="rounded-full border border-[#e7eaef] bg-[#f7f8fa] px-3 py-1 text-[13px] text-[#3f4651]"
          >
            {concept}
          </span>
        ))}
      </div>
    </div>
  );
}
