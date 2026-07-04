// Notebook UI (Block B): small shared presentational pieces of the notebook
// language — the hand-drawn progress bar, the tilted chapter chip, the taped
// sticky note, and the "up next" index card. Purely prop-driven; no data.

export function ProgressDoodle({
  pct,
  ink,
  className = '',
}: {
  pct: number;
  ink: string; // accent ink (CSS color) for the fill
  className?: string;
}) {
  return (
    <div className={`h-[9px] overflow-hidden rounded-md border-[1.5px] border-desk bg-card ${className}`}>
      <div className="h-full" style={{ width: `${Math.min(100, Math.max(0, pct))}%`, background: ink }} />
    </div>
  );
}

export function ChapterChip({
  label,
  bg,
  size = 44,
  className = '',
}: {
  label: string; // chapter numeral / section number
  bg: string; // accent fill (CSS color)
  size?: number;
  className?: string;
}) {
  return (
    <div
      className={`flex flex-none -rotate-3 items-center justify-center rounded-[9px_11px_8px_12px] font-hand font-bold text-white shadow-[0_3px_6px_rgba(0,0,0,.13)] ${className}`}
      style={{ width: size, height: size, background: bg, fontSize: Math.round(size * 0.55) }}
    >
      {label}
    </div>
  );
}

// A sticky note with a piece of translucent tape on top. The tape's washi-teal
// is deliberately translucent so it reads on both light and dark paper.
export function StickyNote({
  children,
  rotate = -0.8,
  tape = 'left',
  className = '',
}: {
  children: React.ReactNode;
  rotate?: number;
  tape?: 'left' | 'right';
  className?: string;
}) {
  return (
    <div
      className={`relative rounded-[3px] border border-note-edge bg-note shadow-[0_6px_14px_rgba(0,0,0,.1)] ${className}`}
      style={{ transform: `rotate(${rotate}deg)` }}
    >
      <div
        className={`absolute -top-[11px] h-[22px] w-24 border ${tape === 'left' ? 'left-10 -rotate-3' : 'right-[26px] rotate-[4deg]'}`}
        style={{ background: 'rgba(120,185,175,.55)', borderColor: 'rgba(120,185,175,.5)' }}
      />
      {children}
    </div>
  );
}

// The "up next" index card: white card, accent spine, icon + kicker + title.
export function IndexCard({
  accent,
  icon,
  kicker,
  title,
  meta,
}: {
  accent: string; // spine + icon color (CSS color)
  icon: React.ReactNode;
  kicker: string;
  title: string;
  meta?: string;
}) {
  return (
    <div
      className="relative flex max-w-[560px] -rotate-[0.4deg] items-center gap-3.5 rounded-[3px] border border-note-edge bg-card px-[18px] py-[13px] shadow-[0_4px_10px_rgba(0,0,0,.08)]"
      style={{ borderLeft: `5px solid ${accent}` }}
    >
      <span
        className="inline-flex h-10 w-10 flex-none -rotate-3 items-center justify-center rounded-[9px_11px_10px_12px] border-2"
        style={{ borderColor: accent, color: accent }}
      >
        {icon}
      </span>
      <div className="flex-1">
        <div className="font-script text-2xs uppercase tracking-[1px] text-script-dim">{kicker}</div>
        <div className="font-hand text-[24px] font-bold leading-none text-script">{title}</div>
      </div>
      {meta && <span className="font-script text-sm text-script-faint">{meta}</span>}
    </div>
  );
}
