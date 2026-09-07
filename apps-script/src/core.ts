import { APPROVAL_SECTIONS, APPROVAL_STEPS } from './constants';
import type { ApprovalSection, MatrixRecord, UserRecord } from './types';

export function formatRfaNumber(year: number, sequence: number): string {
  if (!Number.isInteger(year) || !Number.isInteger(sequence) || sequence < 1) {
    throw new Error('Invalid RFA numbering input.');
  }
  return `RFA-${year}-${String(sequence).padStart(4, '0')}`;
}

export function normalizeEmail(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

/** Keeps HTML-date and persisted ISO timestamps in the canonical date-only form. */
export function canonicalIsoDate(value: unknown): string {
  const raw = String(value ?? '').trim();
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})(?:T.*)?$/);
  return match ? match[1] : raw;
}

export function toBoolean(value: unknown): boolean {
  return value === true || String(value).toUpperCase() === 'TRUE' || value === 1 || value === '1';
}

export function stepRank(step: string): number {
  return APPROVAL_STEPS.indexOf(step as (typeof APPROVAL_STEPS)[number]);
}

export function orderedMatrix(rows: MatrixRecord[]): MatrixRecord[] {
  return rows
    .filter((row) => toBoolean(row.ACTIVE) && toBoolean(row.REQUIRED) && stepRank(row.APPROVAL_STEP) > 0)
    .sort((a, b) => stepRank(a.APPROVAL_STEP) - stepRank(b.APPROVAL_STEP) || Number(a.SEQUENCE) - Number(b.SEQUENCE));
}

export interface RoutingResult {
  next?: { matrix: MatrixRecord; user: UserRecord };
  skipped: Array<{ matrix: MatrixRecord; reason: string; user?: UserRecord }>;
}

export function selectNextApprover(
  matrixRows: MatrixRecord[],
  users: UserRecord[],
  requesterEmail: string,
  startIndex = 0
): RoutingResult {
  const matrix = orderedMatrix(matrixRows);
  const skipped: RoutingResult['skipped'] = [];
  const requester = normalizeEmail(requesterEmail);

  for (let index = Math.max(0, startIndex); index < matrix.length; index += 1) {
    const row = matrix[index];
    const user = users.find((candidate) => candidate.USER_ID === row.APPROVER_USER_ID);
    if (!user) {
      skipped.push({ matrix: row, reason: 'Configured approver does not exist.' });
      continue;
    }
    if (!toBoolean(user.ACTIVE) || !toBoolean(user.CAN_APPROVE_RFA)) {
      skipped.push({ matrix: row, user, reason: 'Configured approver is inactive or lacks approval permission.' });
      continue;
    }
    if (normalizeEmail(user.EMAIL) === requester) {
      skipped.push({ matrix: row, user, reason: 'Self-approval conflict.' });
      continue;
    }
    return { next: { matrix: row, user }, skipped };
  }
  return { skipped };
}

export function validateRfaInput(payload: Record<string, unknown>, forSubmission: boolean): Record<string, string | number> {
  const clean = {
    requestTitle: String(payload.requestTitle ?? '').trim(),
    purpose: String(payload.purpose ?? '').trim(),
    budgetAllocation: Number(payload.budgetAllocation ?? 0),
    targetDate: canonicalIsoDate(payload.targetDate),
    justification: String(payload.justification ?? '').trim()
  };
  if (forSubmission) {
    if (clean.requestTitle.length < 3) throw new Error('Project / Activity / Request Title is required.');
    if (clean.purpose.length < 10) throw new Error('Purpose must contain at least 10 characters.');
    if (!Number.isFinite(clean.budgetAllocation) || clean.budgetAllocation < 0) throw new Error('Budget Allocation must be a valid non-negative amount.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(clean.targetDate)) throw new Error('Target Date is required.');
    if (clean.justification.length < 10) throw new Error('Justification must contain at least 10 characters.');
  }
  return clean;
}

export function nextAssignedSection(counts: Record<ApprovalSection, number>, startIndex = 0): ApprovalSection | undefined {
  for (let index = Math.max(0, startIndex); index < APPROVAL_SECTIONS.length; index += 1) {
    const section = APPROVAL_SECTIONS[index];
    if (counts[section] > 0) return section;
  }
  return undefined;
}

export function isAssignedSectionComplete(assignedCount: number, approvedCount: number): boolean {
  return assignedCount > 0 && approvedCount === assignedCount;
}

/** Returns the current incomplete stage, the next stage, or undefined only after all assigned stages finish. */
export function nextAssignedStageAfterAction(
  assignedCounts: Record<ApprovalSection, number>,
  approvedCounts: Record<ApprovalSection, number>,
  currentIndex: number
): ApprovalSection | undefined {
  const current = APPROVAL_SECTIONS[currentIndex];
  if (current && !isAssignedSectionComplete(assignedCounts[current], approvedCounts[current])) return current;
  return nextAssignedSection(assignedCounts, currentIndex + 1);
}
