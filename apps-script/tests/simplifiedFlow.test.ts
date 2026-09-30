import { beforeEach, describe, expect, it, vi } from 'vitest';
import { adjustBudget, commitApprovedFinancialRfa, departmentExpenseReport, financialDetail, financialRfaFields, recordActualExpense, summarizeBudget } from '../src/budget';
import { createRfa, decideRfa, detailRfa, notedByNotApplicable, submitRfa, transitionCloseout, updateRfa } from '../src/workflow';
import { audit } from '../src/audit';
import { notify } from '../src/notifications';
import type { BudgetTransactionRecord, DepartmentBudgetRecord, RfaRecord, SessionUser, SheetRecord } from '../src/types';

const sheets = new Map<string, SheetRecord[]>();
const settings = new Map<string, string>();
let sequence = 0;
const stamp = () => `2026-09-30T00:00:${String(++sequence).padStart(2, '0')}Z`;
vi.mock('../src/store', () => ({
  all: vi.fn((name: string) => (sheets.get(name) || []).map((row) => ({ ...row }))),
  findBy: vi.fn((name: string, key: string, value: string) => sheets.get(name)?.find((row) => String(row[key]) === value)),
  insert: vi.fn((name: string, row: SheetRecord) => { sheets.set(name, [...(sheets.get(name) || []), row]); }),
  updateBy: vi.fn((name: string, key: string, value: string, update: SheetRecord) => { const row = sheets.get(name)?.find((item) => String(item[key]) === value); if (!row) throw new Error('Missing test row'); Object.assign(row, update); }),
  getSetting: vi.fn((key: string) => settings.get(key) || ''),
  setSetting: vi.fn((key: string, value: string) => { settings.set(key, value); }),
  newId: vi.fn((prefix: string) => `${prefix}_${++sequence}`),
  nowIso: vi.fn(() => stamp()),
  resetPerRequestCache: vi.fn(),
  clearPendingRfaAssignments: vi.fn((rfaId: string) => { sheets.set('RFA_APPROVALS', (sheets.get('RFA_APPROVALS') || []).filter((row) => row.RFA_ID !== rfaId || row.ACTION !== '')); }),
  saveRfaSectionAssignments: vi.fn((rfaId: string, rfaNumber: string, section: string, assignments: Array<{ USER_ID: string; FULL_NAME: string; EMAIL: string }>) => {
    for (const person of assignments) sheets.set('RFA_APPROVALS', [...(sheets.get('RFA_APPROVALS') || []), { RFA_ID: rfaId, RFA_NUMBER: rfaNumber, STEP: section, APPROVER_USER_ID: person.USER_ID, APPROVER_NAME: person.FULL_NAME, APPROVER_EMAIL: person.EMAIL, ACTION: '', APPROVAL_ID: `${section}_${person.USER_ID}` }]);
  }),
  getAssignmentsBySection: vi.fn((rfaId: string, section: string) => (sheets.get('RFA_APPROVALS') || []).filter((row) => row.RFA_ID === rfaId && row.STEP === section && row.ACTION === ''))
}));
vi.mock('../src/audit', () => ({ audit: vi.fn((action: string, _actor: unknown, rfaId: string, _before: string, _after: string, remarks = '') => {
  sheets.set('RFA_AUDIT', [...(sheets.get('RFA_AUDIT') || []), { ACTION: action, RFA_ID: rfaId, REMARKS: remarks, TIMESTAMP: stamp() }]);
}) }));
vi.mock('../src/notifications', () => ({ notify: vi.fn() }));

const requester = { USER_ID: 'requester', FULL_NAME: 'Requester', EMAIL: 'requester@example.edu', DEPARTMENT_ID: 'it', DEPARTMENT_NAME: 'IT', ACTIVE: true, CAN_CREATE_RFA: true } as SessionUser;
const admin = { USER_ID: 'admin', FULL_NAME: 'Admin', EMAIL: 'admin@example.edu', IS_ADMIN: true, CAN_IMPLEMENT_RFA: true } as SessionUser;
const approver = (id: string) => ({ USER_ID: id, FULL_NAME: id, EMAIL: `${id}@example.edu`, ACTIVE: true, CAN_APPROVE_RFA: true, DEPARTMENT_ID: 'it' });
const budget = (id: string, department = 'it', fiscalYear = '2026', allowOverBudget = false) => ({ BUDGET_ID: id, DEPARTMENT_ID: department, FISCAL_YEAR: fiscalYear, STATUS: 'ACTIVE', ALLOW_OVER_BUDGET: allowOverBudget, ORIGINAL_ALLOCATED_AMOUNT: 50_000_000 } as DepartmentBudgetRecord);
const allocation = (id: string, department = 'it', fiscalYear = '2026') => ({ BUDGET_ID: id, DEPARTMENT_ID: department, FISCAL_YEAR: fiscalYear, STATUS: 'POSTED', TRANSACTION_TYPE: 'ALLOCATION', AMOUNT: 50_000_000 } as BudgetTransactionRecord);
const input = (notedByNotApplicable: boolean) => ({ requestTitle: 'Laboratory equipment', purpose: 'Improve the computer laboratory', budgetAllocation: 20000, targetDate: '2026-10-09', justification: 'Equipment is needed for students', isBudgetRequest: true, requestedAmount: '20000', fiscalYear: '2026', notedByNotApplicable,
  approvalAssignments: { RECOMMENDING_APPROVAL: ['a'], REVIEWED_BY: ['b'], NOTED_BY: notedByNotApplicable ? [] : ['c'], APPROVED_BY: ['d'] } });

beforeEach(() => {
  vi.clearAllMocks(); sheets.clear(); settings.clear(); sequence = 0;
  sheets.set('USERS', [requester, approver('a'), approver('b'), approver('c'), approver('d')] as SheetRecord[]);
  sheets.set('DEPARTMENTS', [{ DEPARTMENT_ID: 'it', DEPARTMENT_NAME: 'IT', ACTIVE: true }, { DEPARTMENT_ID: 'hr', DEPARTMENT_NAME: 'HR', ACTIVE: true }]);
  sheets.set('DEPARTMENT_BUDGETS', [budget('it26'), budget('hr26', 'hr'), budget('it27', 'it', '2027')]);
  sheets.set('BUDGET_TRANSACTIONS', [allocation('it26'), allocation('hr26', 'hr'), allocation('it27', 'it', '2027')]);
  sheets.set('RFA', []); sheets.set('RFA_APPROVALS', []); sheets.set('RFA_AUDIT', []); sheets.set('RFA_ATTACHMENTS', []); sheets.set('EXPENSE_CATEGORIES', []);
});

function acted(rfaId: string, id: string) { return decideRfa({ ...approver(id), FULL_NAME: id } as SessionUser, rfaId, 'APPROVED', ''); }
function commitments(rfaId: string) { return (sheets.get('BUDGET_TRANSACTIONS') || []).filter((row) => row.RFA_ID === rfaId && row.TRANSACTION_TYPE === 'COMMITMENT'); }

describe('Noted By selection and approval routing', () => {
  it.each([false, true])('persists %s N/A and routes without a fake assignment or email', (na) => {
    const draft = createRfa(requester, input(na));
    expect((sheets.get('RFA_APPROVALS') || []).filter((row) => row.STEP === 'NOTED_BY')).toHaveLength(na ? 0 : 1);
    expect(notedByNotApplicable((sheets.get('RFA_AUDIT') || []).filter((row) => row.RFA_ID === draft.RFA_ID))).toBe(na);
    expect(detailRfa(requester, draft.RFA_ID).notedByNotApplicable).toBe(na);
    submitRfa(requester, draft.RFA_ID);
    expect((sheets.get('RFA') || [])[0].CURRENT_STEP).toBe('RECOMMENDING_APPROVAL');
    acted(draft.RFA_ID, 'a'); expect((sheets.get('RFA') || [])[0].CURRENT_STEP).toBe('REVIEWED_BY');
    acted(draft.RFA_ID, 'b'); expect((sheets.get('RFA') || [])[0].CURRENT_STEP).toBe(na ? 'APPROVED_BY' : 'NOTED_BY');
    if (!na) acted(draft.RFA_ID, 'c');
    expect(vi.mocked(notify).mock.calls.filter(([, recipient, , , ,]) => (recipient as SheetRecord).EMAIL === 'c@example.edu')).toHaveLength(na ? 0 : 1);
    acted(draft.RFA_ID, 'd');
    expect((sheets.get('RFA') || [])[0].STATUS).toBe('APPROVED');
    expect(commitments(draft.RFA_ID)).toHaveLength(1);
  });

  it('rejects conflicting N/A assignments and permits changing the choice in a draft', () => {
    expect(() => createRfa(requester, { ...input(false), notedByNotApplicable: true })).toThrow('cannot contain approvers');
    const draft = createRfa(requester, input(false));
    updateRfa(requester, { ...input(true), rfaId: draft.RFA_ID });
    expect(detailRfa(requester, draft.RFA_ID).notedByNotApplicable).toBe(true);
    expect((sheets.get('RFA_APPROVALS') || []).filter((row) => row.STEP === 'NOTED_BY')).toHaveLength(0);
    expect(() => createRfa(requester, { ...input(true), approvalAssignments: { ...input(true).approvalAssignments, APPROVED_BY: ['requester'] } })).toThrow('yourself');
  });
});

describe('approved RFA expenditure ledger', () => {
  it('consumes once at approval, never on implementation/close or retry', () => {
    const draft = createRfa(requester, input(true)); submitRfa(requester, draft.RFA_ID);
    for (const id of ['a', 'b', 'd']) acted(draft.RFA_ID, id);
    const approved = (sheets.get('RFA') || [])[0] as RfaRecord;
    expect(commitments(draft.RFA_ID)).toHaveLength(1);
    expect(commitApprovedFinancialRfa(approved, admin)).toMatchObject({ APPROVED_AMOUNT: 2_000_000 });
    expect(commitments(draft.RFA_ID)).toHaveLength(1);
    transitionCloseout(admin, draft.RFA_ID, 'IMPLEMENTATION');
    transitionCloseout(admin, draft.RFA_ID, 'CLOSED');
    expect(commitments(draft.RFA_ID)).toHaveLength(1);
    expect(() => recordActualExpense(admin, approved, { actualAmount: '20000' })).toThrow('Manual expense entry is not available');
    expect(summarizeBudget(budget('it26'), (sheets.get('BUDGET_TRANSACTIONS') as BudgetTransactionRecord[]).filter((row) => row.BUDGET_ID === 'it26')).available).toBe(48_000_000);
  });

  it('blocks an overdraw, but honors Admin over-budget policy when enabled', () => {
    const rfa = { ...createRfa(requester, input(true)), REQUESTED_AMOUNT: 60_000_000 } as RfaRecord;
    expect(() => commitApprovedFinancialRfa(rfa, admin)).toThrow('exceeds');
    expect(commitments(rfa.RFA_ID)).toHaveLength(0);
    (sheets.get('DEPARTMENT_BUDGETS')![0] as DepartmentBudgetRecord).ALLOW_OVER_BUDGET = true;
    commitApprovedFinancialRfa(rfa, admin);
    expect(commitments(rfa.RFA_ID)).toHaveLength(1);
    expect(departmentExpenseReport(admin, { fiscalYear: '2026', departmentId: 'it' })).toMatchObject({ annualBudget: 500000, used: 600000, remaining: -100000 });
  });

  it('keeps department/FY isolation and reports Used/Remaining with linked RFA rows', () => {
    const draft = createRfa(requester, input(true)); submitRfa(requester, draft.RFA_ID);
    for (const id of ['a', 'b', 'd']) acted(draft.RFA_ID, id);
    const report = departmentExpenseReport(admin, { fiscalYear: '2026', departmentId: 'it' }) as { annualBudget: number; used: number; remaining: number; rows: Array<{ rfaId: string; amount: number }> };
    expect(report).toMatchObject({ annualBudget: 500000, used: 20000, remaining: 480000 });
    expect(report.rows).toEqual([expect.objectContaining({ rfaId: draft.RFA_ID, amount: 20000 })]);
    expect(departmentExpenseReport(admin, { fiscalYear: '2026', departmentId: 'hr' })).toMatchObject({ used: 0, remaining: 500000 });
    expect(departmentExpenseReport(admin, { fiscalYear: '2027', departmentId: 'it' })).toMatchObject({ used: 0, remaining: 500000 });
    expect(() => departmentExpenseReport(requester, { fiscalYear: '2026' })).toThrow('permission');
  });

  it('keeps historical category/actual data readable without requiring a category for new RFAs', () => {
    expect(financialRfaFields(requester, { isBudgetRequest: true, fiscalYear: '2026', requestedAmount: '100' }, true)).toMatchObject({ EXPENSE_CATEGORY_ID: '', REQUESTED_AMOUNT: 10000 });
    sheets.set('EXPENSE_CATEGORIES', [{ CATEGORY_ID: 'historical', CATEGORY_NAME: 'Equipment', ACTIVE: false }]);
    const legacy = { IS_BUDGET_REQUEST: true, EXPENSE_CATEGORY_ID: 'historical', DEPARTMENT_ID: 'it', FISCAL_YEAR: '2026', REQUESTED_AMOUNT: 10000, APPROVED_AMOUNT: 10000, ACTUAL_AMOUNT: 9500 } as RfaRecord;
    expect(financialDetail(legacy)).toMatchObject({ categoryName: 'Equipment', actualAmount: 95 });
    expect(summarizeBudget(budget('it26'), [allocation('it26'), { ...allocation('it26'), TRANSACTION_TYPE: 'COMMITMENT', AMOUNT: 10000 }, { ...allocation('it26'), TRANSACTION_TYPE: 'COMMITMENT_RELEASE', AMOUNT: 10000 }, { ...allocation('it26'), TRANSACTION_TYPE: 'ACTUAL_EXPENSE', AMOUNT: 9500 }]).available).toBe(49_990_500);
  });

  it('keeps adjustments reason-validated and audited', () => {
    expect(() => adjustBudget(admin, { budgetId: 'it26', changeAmount: '100', reason: '' })).toThrow('reason');
    adjustBudget(admin, { budgetId: 'it26', changeAmount: '100', direction: 'INCREASE', reason: 'Annual adjustment' });
    expect((sheets.get('BUDGET_TRANSACTIONS') || []).some((row) => row.TRANSACTION_TYPE === 'ADJUSTMENT_INCREASE' && row.DESCRIPTION === 'Annual adjustment')).toBe(true);
    expect(vi.mocked(audit).mock.calls.some(([action]) => action === 'BUDGET_ADJUSTED')).toBe(true);
  });
});
