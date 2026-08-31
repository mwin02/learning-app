// Notebook UI (Block A): the ruled paper sheet every notebook page writes on.
// Visual chrome (paper, ruling, shadow) comes from the `.sheet` class in
// globals.css; this component adds the physical structure — red margin double
// line and three punch holes — and the standard writing area padding (content
// starts right of the margin). Purely presentational.

export function Sheet({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`sheet relative min-w-0 flex-1 overflow-hidden pb-[60px] pl-[var(--sheet-pl)] pr-[var(--sheet-pr)] pt-[26px] ${className}`}>
      {/* red margin + its thinner companion */}
      <div className="absolute bottom-0 left-[var(--sheet-margin-x)] top-0 w-[2px] bg-margin" />
      <div className="absolute bottom-0 left-[calc(var(--sheet-margin-x)+4px)] top-0 w-px bg-margin-soft" />
      {/* three punch holes — hidden on phones, where the margin is too narrow to
          hold them clear of the text */}
      {['top-[130px]', 'top-1/2', 'bottom-[130px]'].map((pos) => (
        <div
          key={pos}
          className={`absolute left-[var(--sheet-hole-x)] hidden h-5 w-5 rounded-full bg-hole shadow-[var(--shadow-hole)] sm:block ${pos}`}
        />
      ))}
      {children}
    </div>
  );
}

// The desk the sheet sits on: full-viewport warm backdrop with the subtle
// dotted texture, centering a max-width column. Wrap a page's Sheet in this.
export function Desk({
  children,
  maxWidth = 900,
}: {
  children: React.ReactNode;
  maxWidth?: number;
}) {
  return (
    <div
      className="min-h-[calc(100vh-var(--nav-h))] bg-desk px-[var(--desk-px)] pb-[60px] pt-[26px] font-script text-script-body"
      style={{
        backgroundImage: 'radial-gradient(var(--desk-dot) 1px, transparent 1px)',
        backgroundSize: '5px 5px',
      }}
    >
      <div className="mx-auto flex items-start" style={{ maxWidth }}>
        {children}
      </div>
    </div>
  );
}
