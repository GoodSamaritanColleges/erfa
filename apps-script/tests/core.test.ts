import { describe, expect, it } from 'vitest';
import { formatRfaNumber, isAssignedSectionComplete, nextAssignedSection, selectNextApprover, validateRfaInput } from '../src/core';
import type { MatrixRecord, UserRecord } from '../src/types';

const baseUser = (id: string, email: string, overrides: Partial<UserRecord> = {}): UserRecord => ({
  USER_ID: id, FULL_NAME: id, EMAIL: email, DEPARTMENT_ID: 'dep', POSITION: '', CAN_CREATE_RFA: true,
  CAN_APPROVE_RFA: true, IS_ADMIN: false, ACTIVE: true, CREATED_AT: '', UPDATED_AT: '', ...overrides
});
const matrix = (id: string, userId: string, step: MatrixRecord['APPROVAL_STEP'], sequence: number): MatrixRecord => ({
  MATRIX_ID: id, DEPARTMENT_ID: 'dep', APPROVAL_STEP: step, APPROVER_USER_ID: userId, SEQUENCE: sequence,
  REQUIRED: true, ACTIVE: true, CREATED_AT: '', UPDATED_AT: ''
});

describe('eRFA workflow core', () => {
  it('formats concurrency-managed RFA numbers', () => expect(formatRfaNumber(2026, 7)).toBe('RFA-2026-0007'));

  it('orders approval steps and skips self approval', () => {
    const rows = [matrix('m2', 'reviewer', 'REVIEWED_AND_NOTED', 1), matrix('m1', 'requester', 'RECOMMENDING_APPROVAL', 1), matrix('m3', 'authority', 'APPROVED_BY', 1)];
    const users = [baseUser('requester', 'juan@example.edu'), baseUser('reviewer', 'reviewer@example.edu'), baseUser('authority', 'authority@example.edu')];
    const result = selectNextApprover(rows, users, 'juan@example.edu');
    expect(result.skipped[0].reason).toBe('Self-approval conflict.');
    expect(result.next?.user.USER_ID).toBe('reviewer');
  });

  it('skips inactive and unauthorized approvers', () => {
    const rows = [matrix('m1', 'inactive', 'RECOMMENDING_APPROVAL', 1), matrix('m2', 'valid', 'RECOMMENDING_APPROVAL', 2)];
    const users = [baseUser('inactive', 'a@example.edu', { ACTIVE: false }), baseUser('valid', 'b@example.edu')];
    expect(selectNextApprover(rows, users, 'owner@example.edu').next?.user.USER_ID).toBe('valid');
  });

  it('reports no route when every candidate conflicts', () => {
    const rows = [matrix('m1', 'owner', 'RECOMMENDING_APPROVAL', 1)];
    const result = selectNextApprover(rows, [baseUser('owner', 'owner@example.edu')], 'owner@example.edu');
    expect(result.next).toBeUndefined();
    expect(result.skipped).toHaveLength(1);
  });

  it('validates institutional RFA submission fields', () => {
    expect(() => validateRfaInput({ requestTitle: 'Lab equipment', purpose: 'Replace broken equipment', budgetAllocation: 1000, targetDate: '2026-09-01', justification: 'Required for safe classes' }, true)).not.toThrow();
    expect(() => validateRfaInput({ requestTitle: '', purpose: '', targetDate: '' }, true)).toThrow();
  });

  it('skips zero-assignment sections and finishes when none are assigned', () => {
    expect(nextAssignedSection({ RECOMMENDING_APPROVAL: 0, REVIEWED_BY: 1, NOTED_BY: 1, APPROVED_BY: 1 })).toBe('REVIEWED_BY');
    expect(nextAssignedSection({ RECOMMENDING_APPROVAL: 1, REVIEWED_BY: 0, NOTED_BY: 0, APPROVED_BY: 2 }, 1)).toBe('APPROVED_BY');
    expect(nextAssignedSection({ RECOMMENDING_APPROVAL: 0, REVIEWED_BY: 0, NOTED_BY: 0, APPROVED_BY: 0 })).toBeUndefined();
  });

  it('requires every selected approver before a section is complete', () => {
    expect(isAssignedSectionComplete(3, 0)).toBe(false);
    expect(isAssignedSectionComplete(3, 1)).toBe(false);
    expect(isAssignedSectionComplete(3, 2)).toBe(false);
    expect(isAssignedSectionComplete(3, 3)).toBe(true);
    expect(isAssignedSectionComplete(0, 0)).toBe(true);
  });
});
