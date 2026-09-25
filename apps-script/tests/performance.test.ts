import { beforeEach, describe, expect, it, vi } from 'vitest';
import { adminBudgetManagement, adminBudgetOverview, adminBudgetSummary, adminExpenseCategories, budgetReport } from '../src/budget';
import { dashboardRfas, detailRfa, listForApproval } from '../src/workflow';
import { all } from '../src/store';
import type { BudgetTransactionRecord, DepartmentBudgetRecord, DepartmentRecord, ExpenseCategoryRecord, RfaRecord, SessionUser, SheetRecord } from '../src/types';

vi.mock('../src/store', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/store')>();
  return { ...original, all: vi.fn(), findBy: vi.fn((name: string, key: string, value: string) => sheets.get(name)?.find((row) => String(row[key]) === value)) };
});
vi.mock('../src/audit', () => ({ audit: vi.fn() }));

const sheets = new Map<string, SheetRecord[]>();
const admin = { USER_ID: 'admin', EMAIL: 'admin@example.edu', IS_ADMIN: true, CAN_APPROVE_RFA: false } as SessionUser;
const budget = (id: string, departmentId: string, fiscalYear = '2026') => ({ BUDGET_ID: id, DEPARTMENT_ID: departmentId, FISCAL_YEAR: fiscalYear, ORIGINAL_ALLOCATED_AMOUNT: 0, ALLOW_OVER_BUDGET: false, STATUS: 'ACTIVE' } as DepartmentBudgetRecord);
const transaction = (id: string, budgetId: string, type: string, amount: number, rfaId = '') => ({ TRANSACTION_ID: id, BUDGET_ID: budgetId, DEPARTMENT_ID: budgetId === 'b1' ? 'd1' : 'd2', FISCAL_YEAR: '2026', RFA_ID: rfaId, CATEGORY_ID: 'cat1', TRANSACTION_TYPE: type, AMOUNT: amount, STATUS: 'POSTED', CREATED_AT: '2026-09-01', CREATED_BY: 'admin@example.edu' } as BudgetTransactionRecord);

beforeEach(() => {
  sheets.clear();
  vi.mocked(all).mockClear();
  vi.mocked(all).mockImplementation(((name: string) => sheets.get(name) || []) as typeof all);
  sheets.set('DEPARTMENTS', [{ DEPARTMENT_ID: 'd1', DEPARTMENT_NAME: 'ITS', ACTIVE: true }, { DEPARTMENT_ID: 'd2', DEPARTMENT_NAME: 'Finance', ACTIVE: true }] as DepartmentRecord[]);
  sheets.set('DEPARTMENT_BUDGETS', [budget('b1', 'd1'), budget('b2', 'd2')]);
  sheets.set('BUDGET_TRANSACTIONS', [transaction('t1', 'b1', 'ALLOCATION', 50_000_000), transaction('t2', 'b1', 'COMMITMENT', 7_500_000, 'r1'), transaction('t3', 'b2', 'ALLOCATION', 30_000_000)]);
  sheets.set('EXPENSE_CATEGORIES', [{ CATEGORY_ID: 'cat1', CATEGORY_NAME: 'Equipment', ACTIVE: true }] as ExpenseCategoryRecord[]);
});

describe('read-only request performance', () => {
  it('summarizes multiple budgets from one ledger read and omits categories for dashboard metrics', () => {
    const summary = adminBudgetSummary(admin, '2026') as { totals: { allocated: number; committed: number; available: number } };
    expect(summary.totals).toMatchObject({ allocated: 800000, committed: 75000, available: 725000 });
    expect(vi.mocked(all).mock.calls.filter(([name]) => name === 'BUDGET_TRANSACTIONS')).toHaveLength(1);
    expect(vi.mocked(all).mock.calls.some(([name]) => name === 'EXPENSE_CATEGORIES' || name === 'RFA')).toBe(false);

    vi.mocked(all).mockClear();
    const overview = adminBudgetOverview(admin, '2026') as { categories: ExpenseCategoryRecord[] };
    expect(overview.categories).toHaveLength(1);
    expect(vi.mocked(all).mock.calls.filter(([name]) => name === 'BUDGET_TRANSACTIONS')).toHaveLength(1);
  });

  it('does not read the transaction sheet when the selected fiscal year has no budget', () => {
    const summary = adminBudgetSummary(admin, '2027') as { rows: unknown[]; totals: { allocated: number } };
    expect(summary.rows).toEqual([]);
    expect(summary.totals.allocated).toBe(0);
    expect(vi.mocked(all).mock.calls.some(([name]) => name === 'BUDGET_TRANSACTIONS')).toBe(false);
  });

  it('loads budget management without categories and reads categories only when opened', () => {
    const management = adminBudgetManagement(admin, '2026') as { departments: DepartmentRecord[]; rows: unknown[] };
    expect(management.departments).toHaveLength(2);
    expect(management.rows).toHaveLength(2);
    expect(vi.mocked(all).mock.calls.map(([name]) => name)).toEqual(['DEPARTMENTS', 'DEPARTMENT_BUDGETS', 'BUDGET_TRANSACTIONS']);

    vi.mocked(all).mockClear();
    expect(adminExpenseCategories(admin)).toHaveLength(1);
    expect(vi.mocked(all).mock.calls.map(([name]) => name)).toEqual(['EXPENSE_CATEGORIES']);
  });

  it('keeps both budget-management reads restricted to administrators', () => {
    const requester = { USER_ID: 'requester', EMAIL: 'requester@example.edu', IS_ADMIN: false } as SessionUser;
    expect(() => adminBudgetManagement(requester, '2026')).toThrow('You do not have permission');
    expect(() => adminExpenseCategories(requester)).toThrow('You do not have permission');
    expect(vi.mocked(all)).not.toHaveBeenCalled();
  });

  it('indexes report transactions once while retaining filtered totals and RFA links', () => {
    sheets.set('RFA', [
      { RFA_ID: 'r1', RFA_NUMBER: 'RFA-2026-0001', IS_BUDGET_REQUEST: true, FISCAL_YEAR: '2026', DEPARTMENT_ID: 'd1', DEPARTMENT_NAME: 'ITS', EXPENSE_CATEGORY_ID: 'cat1', REQUEST_TITLE: 'Equipment', PURPOSE: 'Replace devices', DATE_FILED: '2026-09-01', STATUS: 'APPROVED', REQUESTED_AMOUNT: 8_000_000, APPROVED_AMOUNT: 7_500_000, ACTUAL_AMOUNT: 0 },
      { RFA_ID: 'r2', RFA_NUMBER: 'RFA-2027-0001', IS_BUDGET_REQUEST: true, FISCAL_YEAR: '2027', DEPARTMENT_ID: 'd1', DEPARTMENT_NAME: 'ITS', EXPENSE_CATEGORY_ID: 'cat1', REQUEST_TITLE: 'Equipment', PURPOSE: 'New devices', DATE_FILED: '2027-09-01', STATUS: 'DRAFT', REQUESTED_AMOUNT: 1_000_000, APPROVED_AMOUNT: 0, ACTUAL_AMOUNT: 0 }
    ] as RfaRecord[]);
    const report = budgetReport(admin, { fiscalYear: '2026', departmentId: 'd1', categoryId: 'cat1' }) as { rows: Array<{ rfaId: string; rfaNumber: string }>; totals: { requested: number; approved: number; committed: number }; transactions: unknown[] };
    expect(report.rows.map((row) => row.rfaNumber)).toEqual(['RFA-2026-0001']);
    expect(report.totals).toMatchObject({ requested: 80000, approved: 75000, committed: 75000 });
    expect(report.transactions).toHaveLength(2);
    expect(vi.mocked(all).mock.calls.filter(([name]) => name === 'BUDGET_TRANSACTIONS')).toHaveLength(1);
    expect(vi.mocked(all).mock.calls.filter(([name]) => name === 'RFA')).toHaveLength(1);
  });

  it('keeps ordinary dashboard reads away from every Phase 9 sheet', () => {
    sheets.set('RFA', [{ RFA_ID: 'r1', REQUESTER_EMAIL: 'requester@example.edu', STATUS: 'DRAFT', UPDATED_AT: '2026-09-01' }] as RfaRecord[]);
    sheets.set('RFA_APPROVALS', []);
    const result = dashboardRfas({ USER_ID: 'requester', EMAIL: 'requester@example.edu', IS_ADMIN: false, CAN_APPROVE_RFA: false } as SessionUser);
    expect(result.rfas).toHaveLength(1);
    expect(result.approvals).toHaveLength(0);
    expect(vi.mocked(all).mock.calls.map(([name]) => name)).toEqual(['RFA_APPROVALS', 'RFA']);
  });

  it('loads a non-financial legacy RFA detail without financial-sheet reads', () => {
    sheets.set('RFA', [{ RFA_ID: 'legacy', REQUESTER_EMAIL: 'requester@example.edu', STATUS: 'DRAFT', CURRENT_MATRIX_ID: '', CURRENT_STEP: '', IS_BUDGET_REQUEST: false }] as RfaRecord[]);
    sheets.set('RFA_APPROVALS', []);
    sheets.set('RFA_ATTACHMENTS', []);
    sheets.set('RFA_AUDIT', []);
    const detail = detailRfa({ USER_ID: 'requester', EMAIL: 'requester@example.edu', IS_ADMIN: false } as SessionUser, 'legacy');
    expect(detail.financial).toBeNull();
    expect(vi.mocked(all).mock.calls.map(([name]) => name)).toEqual(['RFA_APPROVALS', 'RFA_ATTACHMENTS', 'RFA_AUDIT']);
  });

  it('indexes assigned approvals without scanning approval rows per RFA', () => {
    const actor = { USER_ID: 'approver', EMAIL: 'approver@example.edu', CAN_APPROVE_RFA: true } as SessionUser;
    sheets.set('RFA', [
      { RFA_ID: 'r1', CURRENT_MATRIX_ID: 'RFA_ASSIGNMENTS_V1', CURRENT_STEP: 'RECOMMENDING_APPROVAL', SUBMITTED_AT: '2026-09-01T00:00:00Z' },
      { RFA_ID: 'r2', CURRENT_MATRIX_ID: 'RFA_ASSIGNMENTS_V1', CURRENT_STEP: 'RECOMMENDING_APPROVAL', SUBMITTED_AT: '2026-09-01T00:00:00Z' }
    ] as RfaRecord[]);
    sheets.set('RFA_APPROVALS', [
      { RFA_ID: 'r1', STEP: 'RECOMMENDING_APPROVAL', APPROVER_USER_ID: 'approver', ACTION: '' },
      { RFA_ID: 'r2', STEP: 'RECOMMENDING_APPROVAL', APPROVER_USER_ID: 'approver', ACTION: '' },
      { RFA_ID: 'r2', STEP: 'RECOMMENDING_APPROVAL', APPROVER_USER_ID: 'approver', ACTION: 'APPROVED', TIMESTAMP: '2026-09-02T00:00:00Z' }
    ]);
    expect(listForApproval(actor).map((rfa) => rfa.RFA_ID)).toEqual(['r1']);
    expect(vi.mocked(all).mock.calls.filter(([name]) => name === 'RFA_APPROVALS')).toHaveLength(1);
  });
});
