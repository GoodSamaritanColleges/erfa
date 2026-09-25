import { describe, expect, it } from 'vitest';
import { RESET_SHEETS, auditRowIsTestTransaction, validateResetAllowlist } from '../src/maintenance';

describe('production test-data reset plan', () => {
  it('limits full-sheet deletion to the six verified transactional sheets', () => {
    expect(RESET_SHEETS).toEqual(['RFA', 'RFA_APPROVALS', 'RFA_ATTACHMENTS', 'NOTIFICATIONS', 'DEPARTMENT_BUDGETS', 'BUDGET_TRANSACTIONS']);
    expect(() => validateResetAllowlist(RESET_SHEETS)).not.toThrow();
    for (const protectedName of ['USERS', 'DEPARTMENTS', 'APPROVAL_MATRIX', 'SETTINGS', 'EXPENSE_CATEGORIES', 'RFA_AUDIT']) {
      expect(() => validateResetAllowlist([...RESET_SHEETS, protectedName])).toThrow();
    }
  });

  it('selectively clears only RFA-linked and budget audit entries', () => {
    expect(auditRowIsTestTransaction('rfa_1', 'APPROVED')).toBe(true);
    expect(auditRowIsTestTransaction('', 'BUDGET_CREATED')).toBe(true);
    expect(auditRowIsTestTransaction('', 'BUDGET_ADJUSTED')).toBe(true);
    expect(auditRowIsTestTransaction('', 'USER_CREATED')).toBe(false);
    expect(auditRowIsTestTransaction('', 'DEPARTMENT_UPDATED')).toBe(false);
    expect(auditRowIsTestTransaction('', 'ACCESS_DENIED')).toBe(false);
  });
});
