import { describe, expect, it } from 'vitest';
import { parseCentavos } from '../src/core';
import { summarizeBudget } from '../src/budget';
import type { BudgetTransactionRecord, DepartmentBudgetRecord } from '../src/types';

const budget = { BUDGET_ID: 'budget-1', DEPARTMENT_ID: 'dept-1', FISCAL_YEAR: '2026', ORIGINAL_ALLOCATED_AMOUNT: 0, ALLOW_OVER_BUDGET: false, STATUS: 'ACTIVE', CREATED_BY: '', CREATED_AT: '', UPDATED_BY: '', UPDATED_AT: '' } as DepartmentBudgetRecord;
const transaction = (type: string, amount: number, rfaId = '') => ({ TRANSACTION_ID: `${type}-${amount}`, BUDGET_ID: 'budget-1', DEPARTMENT_ID: 'dept-1', FISCAL_YEAR: '2026', RFA_ID: rfaId, CATEGORY_ID: '', TRANSACTION_TYPE: type, AMOUNT: amount, DESCRIPTION: '', REFERENCE: '', STATUS: 'POSTED', CREATED_BY: '', CREATED_AT: '', UPDATED_BY: '', UPDATED_AT: '' } as BudgetTransactionRecord);

describe('budget ledger calculations', () => {
  it('derives allocated, committed, actual, and available balances without drift', () => {
    expect(summarizeBudget(budget, [transaction('ALLOCATION', 50_000_000), transaction('COMMITMENT', 7_500_000), transaction('ACTUAL_EXPENSE', 12_500_000)])).toMatchObject({ allocated: 50_000_000, committed: 7_500_000, actualSpent: 12_500_000, available: 30_000_000 });
  });
  it('releases a commitment before actual expense so it is not double counted', () => {
    expect(summarizeBudget(budget, [transaction('ALLOCATION', 5_000_000), transaction('COMMITMENT', 4_500_000, 'rfa-1'), transaction('COMMITMENT_RELEASE', 4_500_000, 'rfa-1'), transaction('ACTUAL_EXPENSE', 4_375_000, 'rfa-1')])).toMatchObject({ committed: 0, actualSpent: 4_375_000, available: 625_000 });
  });
  it('uses fixed centavos parsing and rejects unsafe values', () => {
    expect(parseCentavos('1,250.50')).toBe(125050);
    expect(() => parseCentavos('-1')).toThrow();
    expect(() => parseCentavos('1.999')).toThrow();
  });
});
