import type { ApprovalStep, RfaStatus } from './types';

export const statusLabel = (status: RfaStatus | string): string => ({
  DRAFT: 'Draft', SUBMITTED: 'Submitted', PENDING_RECOMMENDING_APPROVAL: 'Recommending Approval', PENDING_REVIEW: 'Reviewed & Noted',
  PENDING_AUTHORITY_APPROVAL: 'Authority Approval', RETURNED: 'Returned', DISAPPROVED: 'Disapproved', APPROVED: 'Approved',
  IMPLEMENTATION: 'Implementation', CLOSED: 'Closed', CANCELLED: 'Cancelled', EXCEPTION: 'Workflow Exception'
}[status] ?? status.replaceAll('_', ' '));

export const stepLabel = (step: ApprovalStep | string): string => ({
  PREPARED_BY: 'Prepared By', RECOMMENDING_APPROVAL: 'Recommending Approval', REVIEWED_AND_NOTED: 'Reviewed and Noted By', REVIEWED_BY: 'Reviewed By', NOTED_BY: 'Noted By', INVOLVED_DEPARTMENT_HEAD: 'Involved Department Head', APPROVED_BY: 'Approved By'
}[step] ?? step.replaceAll('_', ' '));

export const expenseClassificationLabel = (value?: string | null): string => value === 'OPEX' ? 'OPEX — Operating Expenditure' : value === 'CAPEX' ? 'CAPEX — Capital Expenditure' : value ? String(value) : '—';

/** Normalize imported "LAST, FIRST M." names to consistent Title Case for display. */
export const displayName = (value?: string | null): string => {
  const raw = String(value ?? '').trim();
  if (!raw) return '—';
  // "LAST, FIRST M." -> "Last, First M." ; "FIRST LAST" stays Title Case
  const parts = raw.split(',').map((p) => p.trim());
  const title = (text: string) => text.replace(/\b\w+/g, (w) => {
    if (/^[A-Z]\.$/.test(w)) return w; // initial
    if (/^[A-Z]{2,}$/.test(w)) return w.charAt(0) + w.slice(1).toLowerCase();
    return w;
  }).replace(/\bMc\w+/g, (w) => 'Mc' + w.slice(2).charAt(0).toUpperCase() + w.slice(3));
  return parts.map((p) => p ? title(p) : '').join(', ');
};

/** Produces the only value accepted by an HTML input[type="date"]. */
export const dateInputValue = (value: string): string => /^(\d{4}-\d{2}-\d{2})(?:T.*)?$/.exec(value.trim())?.[1] ?? '';

/** Canonical FY representation used by the backend and all budget-facing UI. */
export const fiscalYearPattern = '[0-9]{4}';
/** RFA numbers are given at submission; drafts have none yet. */
export const rfaNumberLabel = (rfaNumber?: string): string => rfaNumber || 'Draft';

export const isFiscalYear = (value: string): boolean => /^[0-9]{4}$/.test(value);

// School years run June to May and are named by their first year: 2026 = SY 2026–2027.
// An RFA's school year is set automatically from its filing date.
const SCHOOL_YEAR_START_MONTH = 6;
export function schoolYearOf(value: Date | string = new Date()): number {
  const text = value instanceof Date ? new Date(value.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10) : String(value).slice(0, 10);
  const [year, month] = text.split('-').map(Number);
  if (!year || !month) return 0;
  return month >= SCHOOL_YEAR_START_MONTH ? year : year - 1;
}
export const currentSchoolYear = (): number => schoolYearOf(new Date());
export const schoolYearLabel = (start: number | string): string => {
  const year = Number(start);
  return year ? `SY ${year}–${year + 1}` : '—';
};
/** Next school year, the current one, then the previous five, for report pickers. */
export function schoolYearOptions(): Array<{ value: string; label: string }> {
  const current = currentSchoolYear();
  return Array.from({ length: 7 }, (_, index) => current + 1 - index).map((year) => ({ value: String(year), label: schoolYearLabel(year) }));
}

export const money = (value: number | string): string => new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' }).format(Number(value || 0));
export const date = (value: string): string => value ? new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium' }).format(new Date(value.length === 10 ? `${value}T00:00:00` : value)) : '—';
export const dateTime = (value: string): string => value ? new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—';
