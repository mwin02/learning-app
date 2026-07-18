// Button definitions for the pending-review queue — a plain module (NOT
// 'use client') because the server page composes variants per row (e.g.
// [...ROW_BUTTONS, DECOMPOSE_BUTTON] for atomic rows). Exports from a client
// module reach a server component only as client-reference proxies, which are
// not iterable — spreading them throws at render. Keeping the data here lets
// both the server page and the client ReviewActions import it directly.

export type Action = 'approve' | 'reject' | 'decompose';
export type Severity = 'soft' | 'hard';

// `severity` only applies to reject: soft = quality downgrade (future runs
// only), hard = broken/dead link (also lets a future Track layer flag in-flight
// learners). The API defaults to soft, but the UI is explicit so the reviewer's
// intent is recorded on the row.
export type Button = {
  label: string;
  action: Action;
  cascade: boolean;
  severity?: Severity;
  className: string;
};

const APPROVE_CLASS = 'border-green-600 text-green-700 hover:bg-green-50';
const REJECT_SOFT_CLASS = 'border-red-600 text-red-700 hover:bg-red-50';
const REJECT_HARD_CLASS = 'border-red-900 text-red-900 hover:bg-red-50';
const DECOMPOSE_CLASS = 'border-blue-600 text-blue-700 hover:bg-blue-50';

// Buttons per row variant. A container offers subtree-wide actions; an atomic
// resource or a single child offers per-row actions. Reject splits by severity:
// "quality" (soft) for a working-but-weak resource, "broken" (hard) for a dead
// link.
export const CONTAINER_BUTTONS: Button[] = [
  { label: 'Approve all', action: 'approve', cascade: true, className: APPROVE_CLASS },
  { label: 'Reject all (quality)', action: 'reject', cascade: true, severity: 'soft', className: REJECT_SOFT_CLASS },
  { label: 'Reject all (broken)', action: 'reject', cascade: true, severity: 'hard', className: REJECT_HARD_CLASS },
];

export const ROW_BUTTONS: Button[] = [
  { label: 'Approve', action: 'approve', cascade: false, className: APPROVE_CLASS },
  { label: 'Reject (quality)', action: 'reject', cascade: false, severity: 'soft', className: REJECT_SOFT_CLASS },
  { label: 'Reject (broken)', action: 'reject', cascade: false, severity: 'hard', className: REJECT_HARD_CLASS },
];

// Only offered on atomic rows (the page appends it per-row): re-routes a
// misclassified "atomic" resource — really a container (course TOC, whole
// book) — to the decomposition queue instead of approving/rejecting it.
// cascade is meaningless here (per-row by definition); the client omits it.
export const DECOMPOSE_BUTTON: Button = {
  label: 'Send to decompose',
  action: 'decompose',
  cascade: false,
  className: DECOMPOSE_CLASS,
};
