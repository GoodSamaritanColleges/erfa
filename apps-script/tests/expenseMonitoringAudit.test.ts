import { beforeEach, describe, expect, it, vi } from 'vitest';
import { adminAudit } from '../src/admin';
import { aggregateDepartmentExpenses, expenseMonitoringReport } from '../src/budget';
import type { RfaRecord, SessionUser, SheetRecord } from '../src/types';

const sheets = new Map<string, SheetRecord[]>();
vi.mock('../src/store', () => ({
  all: vi.fn((name: string) => (sheets.get(name) || []).map((row) => ({ ...row }))),
  allTail: vi.fn((name: string, limit: number) => (sheets.get(name) || []).slice(-limit).map((row) => ({ ...row }))),
  findBy: vi.fn((name: string, key: string, value: string) => sheets.get(name)?.find((row) => String(row[key]) === value)),
  insert: vi.fn(),
  updateBy: vi.fn(),
  newId: vi.fn(() => 'id'),
  nowIso: vi.fn(() => '2026-09-30T00:00:00Z'),
  resetPerRequestCache: vi.fn()
}));
vi.mock('../src/auth', () => ({
  requireCapability: vi.fn((user: SessionUser) => { if (!(user as unknown as { IS_ADMIN: boolean }).IS_ADMIN) throw new Error('permission'); })
}));

const admin = { USER_ID: 'admin', FULL_NAME: 'Admin', EMAIL: 'admin@example.edu', IS_ADMIN: true } as SessionUser;
const requester = { USER_ID: 'r', FULL_NAME: 'R', EMAIL: 'r@example.edu' } as SessionUser;

const rfa = (overrides: Partial<RfaRecord> = {}): RfaRecord => ({
  RFA_ID: 'rfa1', RFA_NUMBER: 'RFA-2026-0001', DATE_FILED: '2026-09-01', DEPARTMENT_ID: 'it', DEPARTMENT_NAME: 'IT',
  REQUESTED_BY: 'Requester', REQUESTER_EMAIL: 'requester@example.edu', POSITION: '', REQUEST_TITLE: 'Lab equipment', PURPOSE: 'Lab',
  BUDGET_ALLOCATION: 10000, TARGET_DATE: '2026-10-01', JUSTIFICATION: 'Needed', STATUS: 'APPROVED', CURRENT_STEP: 'APPROVED_BY',
  CURRENT_APPROVER_USER_ID: '', CURRENT_APPROVER_EMAIL: '', CURRENT_MATRIX_ID: 'RFA_FIXED_V2', RESUME_MATRIX_ID: '',
  CREATED_AT: '2026-09-01T00:00:00Z', UPDATED_AT: '2026-09-02T00:00:00Z', SUBMITTED_AT: '', COMPLETED_AT: '', VERSION: 1,
  IS_BUDGET_REQUEST: true, EXPENSE_CATEGORY_ID: '', REQUESTED_AMOUNT: 1000000, APPROVED_AMOUNT: 1000000, ACTUAL_AMOUNT: 0,
  FISCAL_YEAR: '2026', ACTUAL_EXPENSE_RECORDED_AT: '', EXPENSE_CLASSIFICATION: 'OPEX', INVOLVED_DEPARTMENT_ID: '', INVOLVED_DEPARTMENT_NAME: '',
  ...overrides
} as RfaRecord);

beforeEach(() => {
  vi.clearAllMocks();
  sheets.clear();
  sheets.set('DEPARTMENTS', [{ DEPARTMENT_ID: 'it', DEPARTMENT_NAME: 'IT', ACTIVE: true }, { DEPARTMENT_ID: 'hr', DEPARTMENT_NAME: 'HR', ACTIVE: true }]);
  sheets.set('RFA', []);
  sheets.set('RFA_APPROVALS', []);
  sheets.set('RFA_AUDIT', []);
});

describe('admin audit filtering', () => {
  it('retains who/what/when and which RFA, with multi-field filters', () => {
    sheets.set('RFA', [rfa(), rfa({ RFA_ID: 'rfa2', RFA_NUMBER: 'RFA-2026-0002', EXPENSE_CLASSIFICATION: 'CAPEX', REQUESTED_AMOUNT: 500000, APPROVED_AMOUNT: 500000, STATUS: 'IMPLEMENTATION', INVOLVED_DEPARTMENT_ID: 'hr', INVOLVED_DEPARTMENT_NAME: 'HR', DEPARTMENT_NAME: 'IT' })]);
    sheets.set('RFA_APPROVALS', [{ RFA_ID: 'rfa1', STEP: 'REVIEWED_BY', APPROVER_USER_ID: 'b', APPROVER_NAME: 'b', APPROVER_EMAIL: 'b@example.edu', ACTION: 'APPROVED', TIMESTAMP: '2026-09-02T00:00:00Z' }]);
    sheets.set('RFA_AUDIT', [
      { LOG_ID: '1', RFA_ID: 'rfa1', ACTOR_NAME: 'b', ACTOR_EMAIL: 'b@example.edu', ACTION: 'APPROVED', PREVIOUS_STATUS: 'PENDING_REVIEW', NEW_STATUS: 'PENDING_REVIEW', REMARKS: 'ok', TIMESTAMP: '2026-09-02T10:00:00Z', METADATA_JSON: '{"step":"REVIEWED_BY"}' },
      { LOG_ID: '2', RFA_ID: 'rfa2', ACTOR_NAME: 'hrHead', ACTOR_EMAIL: 'hrhead@example.edu', ACTION: 'APPROVED', PREVIOUS_STATUS: 'PENDING_REVIEW', NEW_STATUS: 'PENDING_AUTHORITY_APPROVAL', REMARKS: '', TIMESTAMP: '2026-09-03T10:00:00Z', METADATA_JSON: '{"step":"INVOLVED_DEPARTMENT_HEAD"}' }
    ]);
    const all = adminAudit(admin, {}) as { rows: Array<Record<string, unknown>> };
    expect(all.rows).toHaveLength(2);
    expect(all.rows[0]).toMatchObject({ rfaNumber: 'RFA-2026-0002', involvedDepartment: 'HR' });
    expect(all.rows[1]).toMatchObject({ rfaNumber: 'RFA-2026-0001', expenseClassification: 'OPEX' });
    // classification filter
    expect(adminAudit(admin, { expenseClassification: 'CAPEX' })).toMatchObject({ rows: [expect.objectContaining({ rfaNumber: 'RFA-2026-0002' })] });
    // involved filter
    expect(adminAudit(admin, { involvedDepartmentId: 'hr' })).toMatchObject({ rows: [expect.objectContaining({ rfaNumber: 'RFA-2026-0002' })] });
    // stage filter
    expect(adminAudit(admin, { stage: 'INVOLVED_DEPARTMENT_HEAD' })).toMatchObject({ rows: [expect.objectContaining({ rfaNumber: 'RFA-2026-0002' })] });
    // amount range
    expect(adminAudit(admin, { minAmount: '6000' })).toMatchObject({ rows: [expect.objectContaining({ rfaNumber: 'RFA-2026-0001' })] });
    expect(adminAudit(admin, { maxAmount: '6000' })).toMatchObject({ rows: [expect.objectContaining({ rfaNumber: 'RFA-2026-0002' })] });
    // date range
    expect(adminAudit(admin, { fromDate: '2026-09-03', toDate: '2026-09-03' })).toMatchObject({ rows: [expect.objectContaining({ rfaNumber: 'RFA-2026-0002' })] });
    expect(() => adminAudit(requester, {})).toThrow('permission');
  });
});

describe('expense monitoring edge cases', () => {
  it('does not double-count cross-department RFAs in institutional totals', () => {
    const rows = [
      rfa({ RFA_ID: 'a', DEPARTMENT_ID: 'it', DEPARTMENT_NAME: 'IT', REQUESTED_AMOUNT: 1000000, APPROVED_AMOUNT: 1000000, EXPENSE_CLASSIFICATION: 'OPEX' }),
      rfa({ RFA_ID: 'b', DEPARTMENT_ID: 'it', DEPARTMENT_NAME: 'IT', REQUESTED_AMOUNT: 1000000, APPROVED_AMOUNT: 1000000, EXPENSE_CLASSIFICATION: 'OPEX', INVOLVED_DEPARTMENT_ID: 'hr', INVOLVED_DEPARTMENT_NAME: 'HR' })
    ];
    const result = aggregateDepartmentExpenses(rows, { fiscalYear: '2026', departmentId: '', expenseClassification: '', status: '', fromDate: '', toDate: '', query: '' });
    expect(result.totals).toMatchObject({ total: 20000, rfaCount: 2 });
    expect(result.deptRows).toHaveLength(1);
    expect(result.detailRows).toHaveLength(2);
  });

  it('requires admin for reporting', () => {
    expect(() => expenseMonitoringReport(requester, { fiscalYear: '2026' })).toThrow('permission');
  });
});
