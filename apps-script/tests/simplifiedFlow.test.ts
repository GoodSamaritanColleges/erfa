import { beforeEach, describe, expect, it, vi } from 'vitest';
import { commitApprovedFinancialRfa, expenseMonitoringReport, financialDetail, financialRfaFields, summarizeBudget } from '../src/budget';
import { createRfa, decideRfa, detailRfa, listRfas, submitRfa, transitionCloseout } from '../src/workflow';
import type { BudgetTransactionRecord, DepartmentBudgetRecord, RfaRecord, SessionUser, SheetRecord } from '../src/types';

const sheets = new Map<string, SheetRecord[]>();
const settings = new Map<string, string>();
let sequence = 0;
const stamp = () => { const s = ++sequence; const mm = String(Math.floor(s / 60)).padStart(2, '0'); const ss = String(s % 60).padStart(2, '0'); return `2026-09-30T00:${mm}:${ss}Z`; };
vi.mock('../src/store', () => ({
  all: vi.fn((name: string) => (sheets.get(name) || []).map((row) => ({ ...row }))),
  allTail: vi.fn((name: string, limit: number) => (sheets.get(name) || []).slice(-limit).map((row) => ({ ...row }))),
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

const admin = { USER_ID: 'admin', FULL_NAME: 'Admin', EMAIL: 'admin@example.edu', IS_ADMIN: true, CAN_IMPLEMENT_RFA: true } as SessionUser;

function namedUser(id: string, fullName: string, dept = 'it'): SessionUser {
  return { USER_ID: id, FULL_NAME: fullName, EMAIL: `${id}@example.edu`, ACTIVE: true, CAN_APPROVE_RFA: true, DEPARTMENT_ID: dept } as SessionUser;
}

function requesterFor(deptId: string): SessionUser {
  return { USER_ID: `req_${deptId}`, FULL_NAME: `Requester ${deptId}`, EMAIL: `req_${deptId}@example.edu`, DEPARTMENT_ID: deptId, DEPARTMENT_NAME: deptId.toUpperCase(), ACTIVE: true, CAN_CREATE_RFA: true } as SessionUser;
}

const budget = (id: string, department = 'it', fiscalYear = '2026') => ({ BUDGET_ID: id, DEPARTMENT_ID: department, FISCAL_YEAR: fiscalYear, STATUS: 'ACTIVE', ALLOW_OVER_BUDGET: false, ORIGINAL_ALLOCATED_AMOUNT: 50_000_000 } as DepartmentBudgetRecord);
const allocation = (id: string, department = 'it', fiscalYear = '2026') => ({ BUDGET_ID: id, DEPARTMENT_ID: department, FISCAL_YEAR: fiscalYear, STATUS: 'POSTED', TRANSACTION_TYPE: 'ALLOCATION', AMOUNT: 50_000_000 } as BudgetTransactionRecord);
const matrixRow = (departmentId: string, step: string, approverId: string, seq = 1) => ({ MATRIX_ID: `mat_${departmentId}_${step}_${seq}`, DEPARTMENT_ID: departmentId, APPROVAL_STEP: step, APPROVER_USER_ID: approverId, SEQUENCE: seq, REQUIRED: true, ACTIVE: true });

let users: SheetRecord[] = [];
const ofelia = () => namedUser('ofelia', 'Ofelia Hocson', 'it');
const ana = () => namedUser('ana', 'Ana Liza Tago', 'it');
const raquel = () => namedUser('raquel', 'Raquel Baquiran', 'it');
const jennelyn = () => namedUser('jennelyn', 'Jennelyn De Guzman', 'it');
const president = () => namedUser('president', 'Alessandra De Guzman-Valino', 'it');
const principal = () => namedUser('principal', 'Noliver Garcia', 'jhs');
const procurement = () => namedUser('procurement', 'Marjorie Valdez', 'it');

function seedOfficial(opts: {
  requestingDeptId: string;
  requestingCode?: string;
  isAcademic?: boolean;
  heads: Record<string, string[]>; // deptId -> userIds
  involvedHeads?: Record<string, string[]>;
}) {
  const allUsers = [
    ...['it', 'hr', 'acad', 'jhs', 'shs', 'dual', 'alpha'].map((d) => requesterFor(d)),
    ofelia(), ana(), raquel(), jennelyn(), president(), principal(), procurement(),
    namedUser('itHead', 'IT Head', 'it'),
    namedUser('hrHead', 'HR Head', 'hr'),
    namedUser('acadHead', 'Acad Head', 'acad'),
    namedUser('jhsHead', 'JHS Head', 'jhs'),
    namedUser('dualHead1', 'Dual Head One', 'dual'),
    namedUser('dualHead2', 'Dual Head Two', 'dual'),
    namedUser('alphaHead', 'Alpha Head', 'alpha'),
    namedUser('stranger', 'Stranger', 'it')
  ];
  sheets.set('USERS', allUsers as SheetRecord[]);
  users = allUsers as SheetRecord[];
  const allDepts = [
    { DEPARTMENT_ID: 'it', DEPARTMENT_NAME: 'IT', DEPARTMENT_CODE: opts.requestingCode || 'IT', ACTIVE: true, DEPARTMENT_HEAD_USER_ID: opts.heads['it']?.[0] || '', IS_ACADEMIC: !!opts.isAcademic },
    { DEPARTMENT_ID: 'hr', DEPARTMENT_NAME: 'HR', DEPARTMENT_CODE: 'HR', ACTIVE: true, DEPARTMENT_HEAD_USER_ID: (opts.involvedHeads?.['hr'] || ['hrHead'])[0], IS_ACADEMIC: false },
    { DEPARTMENT_ID: 'acad', DEPARTMENT_NAME: 'Academy', DEPARTMENT_CODE: 'ACAD', ACTIVE: true, DEPARTMENT_HEAD_USER_ID: (opts.heads['acad']?.[0] || 'acadHead'), IS_ACADEMIC: true },
    { DEPARTMENT_ID: 'jhs', DEPARTMENT_NAME: 'Junior High School', DEPARTMENT_CODE: 'JHS', ACTIVE: true, DEPARTMENT_HEAD_USER_ID: (opts.heads['jhs']?.[0] || 'jhsHead'), IS_ACADEMIC: true },
    { DEPARTMENT_ID: 'shs', DEPARTMENT_NAME: 'Senior High School', DEPARTMENT_CODE: 'SHS', ACTIVE: true, DEPARTMENT_HEAD_USER_ID: (opts.heads['shs']?.[0] || 'jhsHead'), IS_ACADEMIC: true },
    { DEPARTMENT_ID: 'dual', DEPARTMENT_NAME: 'Dual', DEPARTMENT_CODE: 'DUAL', ACTIVE: true, DEPARTMENT_HEAD_USER_ID: (opts.heads['dual']?.[0] || 'dualHead1'), IS_ACADEMIC: false },
    { DEPARTMENT_ID: 'alpha', DEPARTMENT_NAME: 'Alpha', DEPARTMENT_CODE: 'ALPHA', ACTIVE: true, DEPARTMENT_HEAD_USER_ID: (opts.heads['alpha']?.[0] || 'alphaHead'), IS_ACADEMIC: false }
  ];
  // Apply requesting dept academic override
  const req = allDepts.find((d) => d.DEPARTMENT_ID === opts.requestingDeptId);
  if (req) {
    req.DEPARTMENT_CODE = opts.requestingCode || req.DEPARTMENT_CODE;
    req.IS_ACADEMIC = !!opts.isAcademic;
    if (opts.heads[opts.requestingDeptId]) req.DEPARTMENT_HEAD_USER_ID = opts.heads[opts.requestingDeptId][0];
  }
  sheets.set('DEPARTMENTS', allDepts);
  // Heads sheet: build from opts.heads + defaults
  const headsRows: SheetRecord[] = [];
  const addHeads = (deptId: string, userIds: string[]) => {
    for (const userId of userIds) headsRows.push({ HEAD_ID: `head_${deptId}_${userId}`, DEPARTMENT_ID: deptId, USER_ID: userId, ACTIVE: true });
  };
  for (const [deptId, ids] of Object.entries(opts.heads)) addHeads(deptId, ids);
  if (opts.involvedHeads) for (const [deptId, ids] of Object.entries(opts.involvedHeads)) addHeads(deptId, ids);
  // Ensure HR always has hrHead for involved tests unless overridden
  if (!opts.involvedHeads?.['hr']) addHeads('hr', ['hrHead']);
  sheets.set('DEPARTMENT_HEADS', headsRows);
  // Matrix: mandatory rows for requesting dept
  sheets.set('APPROVAL_MATRIX', [
    matrixRow(opts.requestingDeptId, 'REVIEWED_AND_NOTED', 'ofelia', 1),
    matrixRow(opts.requestingDeptId, 'APPROVED_BY', 'ana', 1),
    matrixRow(opts.requestingDeptId, 'APPROVED_BY', 'raquel', 2)
  ]);
  settings.set('PRESIDENT_THRESHOLD_PHP', '50000');
  settings.set('VP_ACADEMIC_USER_ID', 'jennelyn');
  settings.set('PRESIDENT_USER_ID', 'president');
  settings.set('PRINCIPAL_USER_ID', 'principal');
  settings.set('PROCUREMENT_USER_ID', 'procurement');
  settings.set('REVIEWED_MANDATORY_USER_ID', 'ofelia');
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    requestTitle: 'Laboratory equipment', purpose: 'Improve the computer laboratory', budgetAllocation: 20000,
    targetDate: '2026-10-09', justification: 'Equipment is needed for students',
    fiscalYear: '2026', requestedAmount: '20000', expenseClassification: 'OPEX',
    purchaseRequest: false, involvedDepartmentIds: [], recommendingAlternateUserId: '', includePrincipal: false, includeProcurement: false,
    ...overrides
  };
}

beforeEach(() => {
  vi.clearAllMocks(); sheets.clear(); settings.clear(); sequence = 0;
  sheets.set('DEPARTMENT_BUDGETS', []);
  sheets.set('BUDGET_TRANSACTIONS', []);
  sheets.set('RFA', []); sheets.set('RFA_APPROVALS', []); sheets.set('RFA_AUDIT', []); sheets.set('RFA_ATTACHMENTS', []); sheets.set('EXPENSE_CATEGORIES', []);
  seedOfficial({ requestingDeptId: 'it', isAcademic: false, heads: { it: ['itHead'] }, involvedHeads: { hr: ['hrHead'] } });
});

function acted(rfaId: string, user: SessionUser) {
  return decideRfa(user, rfaId, 'APPROVED', '');
}
function rfaRow(rfaId: string) { return (sheets.get('RFA') || []).find((r) => r.RFA_ID === rfaId) as unknown as RfaRecord; }
function step(rfaId: string) { return rfaRow(rfaId).CURRENT_STEP; }
function status(rfaId: string) { return rfaRow(rfaId).STATUS; }
function assignmentsFor(rfaId: string, section: string) {
  return (sheets.get('RFA_APPROVALS') || []).filter((r) => r.RFA_ID === rfaId && r.STEP === section && r.ACTION === '').map((r) => String(r.APPROVER_USER_ID));
}
function commitments(rfaId: string) { return (sheets.get('BUDGET_TRANSACTIONS') || []).filter((row) => row.RFA_ID === rfaId && row.TRANSACTION_TYPE === 'COMMITMENT'); }

// Helpers to resolve official user objects for acting
function userById(id: string): SessionUser {
  return (users.find((u) => String(u.USER_ID) === id) as unknown as SessionUser);
}

describe('official matrix — 12 scenarios', () => {
  it('1. Non-academic, below threshold, no optionals', () => {
    const req = requesterFor('it');
    const draft = createRfa(req, input({ requestedAmount: '10000', budgetAllocation: 10000, recommendingAlternateUserId: 'hrHead' }));
    expect(draft.CURRENT_MATRIX_ID).toBe('RFA_FIXED_V3');
    expect(assignmentsFor(draft.RFA_ID, 'RECOMMENDING_APPROVAL')).toEqual(expect.arrayContaining(['itHead', 'hrHead']));
    expect(assignmentsFor(draft.RFA_ID, 'REVIEWED_AND_NOTED')).toEqual(['ofelia']);
    expect(assignmentsFor(draft.RFA_ID, 'APPROVED_BY')).toEqual(expect.arrayContaining(['ana', 'raquel']));
    expect(assignmentsFor(draft.RFA_ID, 'APPROVED_BY')).not.toContain('jennelyn');
    expect(assignmentsFor(draft.RFA_ID, 'APPROVED_BY')).not.toContain('president');
    submitRfa(req, draft.RFA_ID);
    expect(step(draft.RFA_ID)).toBe('RECOMMENDING_APPROVAL');
    acted(draft.RFA_ID, userById('itHead')); // either head succeeds (OR)
    expect(step(draft.RFA_ID)).toBe('REVIEWED_AND_NOTED');
    acted(draft.RFA_ID, userById('ofelia'));
    expect(step(draft.RFA_ID)).toBe('APPROVED_BY');
    acted(draft.RFA_ID, userById('ana')); acted(draft.RFA_ID, userById('raquel'));
    expect(status(draft.RFA_ID)).toBe('APPROVED');
  });

  it('2. Academic department, below threshold includes VP but not President', () => {
    seedOfficial({ requestingDeptId: 'acad', isAcademic: true, heads: { acad: ['acadHead'] } });
    const req = requesterFor('acad');
    const draft = createRfa(req, input({ requestedAmount: '10000', budgetAllocation: 10000, recommendingAlternateUserId: 'hrHead' }));
    expect(assignmentsFor(draft.RFA_ID, 'APPROVED_BY')).toEqual(expect.arrayContaining(['ana', 'raquel', 'jennelyn']));
    expect(assignmentsFor(draft.RFA_ID, 'APPROVED_BY')).not.toContain('president');
    submitRfa(req, draft.RFA_ID);
    acted(draft.RFA_ID, userById('acadHead'));
    acted(draft.RFA_ID, userById('ofelia'));
    acted(draft.RFA_ID, userById('ana')); acted(draft.RFA_ID, userById('raquel')); acted(draft.RFA_ID, userById('jennelyn'));
    expect(status(draft.RFA_ID)).toBe('APPROVED');
  });

  it('3. Non-academic, exactly threshold requires President', () => {
    const req = requesterFor('it');
    const draft = createRfa(req, input({ requestedAmount: '50000', budgetAllocation: 50000, recommendingAlternateUserId: 'hrHead' }));
    expect(assignmentsFor(draft.RFA_ID, 'APPROVED_BY')).toContain('president');
    submitRfa(req, draft.RFA_ID);
    acted(draft.RFA_ID, userById('itHead'));
    acted(draft.RFA_ID, userById('ofelia'));
    acted(draft.RFA_ID, userById('ana')); acted(draft.RFA_ID, userById('raquel'));
    expect(step(draft.RFA_ID)).toBe('APPROVED_BY');
    acted(draft.RFA_ID, userById('president'));
    expect(status(draft.RFA_ID)).toBe('APPROVED');
  });

  it('4. Academic, above threshold requires VP and President', () => {
    seedOfficial({ requestingDeptId: 'acad', isAcademic: true, heads: { acad: ['acadHead'] } });
    const req = requesterFor('acad');
    const draft = createRfa(req, input({ requestedAmount: '60000', budgetAllocation: 60000, recommendingAlternateUserId: 'hrHead' }));
    expect(assignmentsFor(draft.RFA_ID, 'APPROVED_BY')).toEqual(expect.arrayContaining(['ana', 'raquel', 'jennelyn', 'president']));
    submitRfa(req, draft.RFA_ID);
    acted(draft.RFA_ID, userById('acadHead'));
    acted(draft.RFA_ID, userById('ofelia'));
    acted(draft.RFA_ID, userById('ana')); acted(draft.RFA_ID, userById('raquel')); acted(draft.RFA_ID, userById('jennelyn')); acted(draft.RFA_ID, userById('president'));
    expect(status(draft.RFA_ID)).toBe('APPROVED');
  });

  it('5. Department with two heads: either head can provide recommending approval', () => {
    seedOfficial({ requestingDeptId: 'dual', isAcademic: false, heads: { dual: ['dualHead1', 'dualHead2'] } });
    const req = requesterFor('dual');
    const draft = createRfa(req, input({ requestedAmount: '10000', budgetAllocation: 10000 }));
    expect(assignmentsFor(draft.RFA_ID, 'RECOMMENDING_APPROVAL').sort()).toEqual(['dualHead1', 'dualHead2'].sort());
    // No alternate required
    submitRfa(req, draft.RFA_ID);
    expect(step(draft.RFA_ID)).toBe('RECOMMENDING_APPROVAL');
    // First head approves; stage completes without second head
    acted(draft.RFA_ID, userById('dualHead2'));
    expect(step(draft.RFA_ID)).toBe('REVIEWED_AND_NOTED');
    // Second head can no longer act (moved on)
    expect(() => acted(draft.RFA_ID, userById('dualHead1'))).toThrow('not assigned');
  });

  it('6. Department with one head: alternate selection is required', () => {
    const req = requesterFor('it');
    // Without alternate, submit must fail
    const missing = createRfa(req, input({ requestedAmount: '10000', budgetAllocation: 10000 }));
    expect(() => submitRfa(req, missing.RFA_ID)).toThrow(/alternate/);
    // With alternate, succeeds and records it
    const draft = createRfa(req, input({ requestedAmount: '10000', budgetAllocation: 10000, recommendingAlternateUserId: 'hrHead' }));
    expect(rfaRow(draft.RFA_ID).RECOMMENDING_ALTERNATE_NAME).toBeTruthy();
    submitRfa(req, draft.RFA_ID);
    expect(assignmentsFor(draft.RFA_ID, 'RECOMMENDING_APPROVAL')).toContain('hrHead');
    acted(draft.RFA_ID, userById('hrHead'));
    expect(step(draft.RFA_ID)).toBe('REVIEWED_AND_NOTED');
  });

  it('7. RFA involving another department adds involved head to Reviewed and Noted', () => {
    const req = requesterFor('it');
    const draft = createRfa(req, input({ requestedAmount: '10000', budgetAllocation: 10000, recommendingAlternateUserId: 'hrHead', involvedDepartmentIds: ['hr'] }));
    expect(assignmentsFor(draft.RFA_ID, 'REVIEWED_AND_NOTED')).toEqual(expect.arrayContaining(['ofelia', 'hrHead']));
    submitRfa(req, draft.RFA_ID);
    acted(draft.RFA_ID, userById('itHead'));
    expect(step(draft.RFA_ID)).toBe('REVIEWED_AND_NOTED');
    acted(draft.RFA_ID, userById('ofelia'));
    expect(step(draft.RFA_ID)).toBe('REVIEWED_AND_NOTED'); // still waiting for involved head (AND)
    acted(draft.RFA_ID, userById('hrHead'));
    expect(step(draft.RFA_ID)).toBe('APPROVED_BY');
  });

  it('8. JHS/SHS requests with Principal selected', () => {
    seedOfficial({ requestingDeptId: 'jhs', isAcademic: true, heads: { jhs: ['jhsHead'] } });
    const req = requesterFor('jhs');
    const draft = createRfa(req, input({ requestedAmount: '10000', budgetAllocation: 10000, recommendingAlternateUserId: 'hrHead', includePrincipal: true }));
    expect(assignmentsFor(draft.RFA_ID, 'REVIEWED_AND_NOTED')).toEqual(expect.arrayContaining(['ofelia', 'principal']));
    submitRfa(req, draft.RFA_ID);
    acted(draft.RFA_ID, userById('jhsHead'));
    acted(draft.RFA_ID, userById('ofelia')); acted(draft.RFA_ID, userById('principal'));
    expect(step(draft.RFA_ID)).toBe('APPROVED_BY');
  });

  it('9. Purchase request with Procurement Clerk selected', () => {
    const req = requesterFor('it');
    const draft = createRfa(req, input({ requestedAmount: '10000', budgetAllocation: 10000, recommendingAlternateUserId: 'hrHead', purchaseRequest: true, includeProcurement: true }));
    expect(assignmentsFor(draft.RFA_ID, 'REVIEWED_AND_NOTED')).toContain('procurement');
    submitRfa(req, draft.RFA_ID);
    acted(draft.RFA_ID, userById('itHead'));
    acted(draft.RFA_ID, userById('ofelia')); acted(draft.RFA_ID, userById('procurement'));
    expect(step(draft.RFA_ID)).toBe('APPROVED_BY');
  });

  it('10. Purchase request without Procurement Clerk selected', () => {
    const req = requesterFor('it');
    const draft = createRfa(req, input({ requestedAmount: '10000', budgetAllocation: 10000, recommendingAlternateUserId: 'hrHead', purchaseRequest: true, includeProcurement: false }));
    expect(assignmentsFor(draft.RFA_ID, 'REVIEWED_AND_NOTED')).not.toContain('procurement');
    expect(assignmentsFor(draft.RFA_ID, 'REVIEWED_AND_NOTED')).toEqual(['ofelia']);
  });

  it('11. All mandatory approvers remain required (cannot skip)', () => {
    const req = requesterFor('it');
    const draft = createRfa(req, input({ requestedAmount: '60000', budgetAllocation: 60000, recommendingAlternateUserId: 'hrHead' }));
    submitRfa(req, draft.RFA_ID);
    // Cannot jump to Approved from Recommending
    expect(() => acted(draft.RFA_ID, userById('ofelia'))).toThrow('not assigned');
    acted(draft.RFA_ID, userById('itHead'));
    // Ofelia must approve before Approved; Ana cannot act early
    expect(() => acted(draft.RFA_ID, userById('ana'))).toThrow('not assigned');
    acted(draft.RFA_ID, userById('ofelia'));
    // Both Ana and Raquel required, plus President for above-threshold
    acted(draft.RFA_ID, userById('ana'));
    expect(step(draft.RFA_ID)).toBe('APPROVED_BY');
    acted(draft.RFA_ID, userById('raquel'));
    expect(step(draft.RFA_ID)).toBe('APPROVED_BY');
    acted(draft.RFA_ID, userById('president'));
    expect(status(draft.RFA_ID)).toBe('APPROVED');
  });

  it('12. Unauthorized users cannot approve or bypass a stage', () => {
    const req = requesterFor('it');
    const draft = createRfa(req, input({ requestedAmount: '10000', budgetAllocation: 10000, recommendingAlternateUserId: 'hrHead' }));
    submitRfa(req, draft.RFA_ID);
    expect(() => acted(draft.RFA_ID, userById('stranger'))).toThrow('not assigned');
    expect(() => acted(draft.RFA_ID, userById('ofelia'))).toThrow('not assigned');
    expect(() => decideRfa({ ...userById('itHead'), EMAIL: req.EMAIL } as SessionUser, draft.RFA_ID, 'APPROVED', '')).toThrow(/own RFA|permission/);
    // Duplicate processing prevented
    acted(draft.RFA_ID, userById('itHead'));
    expect(() => acted(draft.RFA_ID, userById('itHead'))).toThrow('not assigned');
  });

  it('validates inapplicable optionals (Principal and Procurement guards)', () => {
    const req = requesterFor('it'); // not JHS/SHS
    expect(() => createRfa(req, input({ requestingDeptId: 'it', includePrincipal: true }))).toThrow(/JHS\/SHS/);
    expect(() => createRfa(req, input({ includeProcurement: true, purchaseRequest: false }))).toThrow(/purchase/);
  });
});

describe('expense classification and budget removal (preserved)', () => {
  it('creates an RFA without any configured department budget', () => {
    const req = requesterFor('it');
    const draft = createRfa(req, input({ requestedAmount: '20000', budgetAllocation: 20000, recommendingAlternateUserId: 'hrHead' }));
    expect(draft).toMatchObject({ EXPENSE_CLASSIFICATION: 'OPEX', FISCAL_YEAR: '2026', REQUESTED_AMOUNT: 2_000_000 });
    expect(draft.CURRENT_MATRIX_ID).toBe('RFA_FIXED_V3');
  });

  it('requires OPEX or CAPEX and validates fiscal year without budget gate', () => {
    expect(() => createRfa(requesterFor('it'), input({ expenseClassification: '' }))).toThrow('OPEX or CAPEX');
    expect(financialRfaFields(requesterFor('it'), { isBudgetRequest: true, fiscalYear: '2026', requestedAmount: '100', expenseClassification: 'OPEX' }, true)).toMatchObject({ REQUESTED_AMOUNT: 10000 });
    expect(() => financialRfaFields(requesterFor('it'), { isBudgetRequest: true, fiscalYear: '202', requestedAmount: '100' }, true)).toThrow('four-digit year');
    expect(financialRfaFields(requesterFor('it'), { isBudgetRequest: true, fiscalYear: '2026', requestedAmount: '99999999', expenseClassification: 'CAPEX' }, true).REQUESTED_AMOUNT).toBe(9999999900);
  });

  it('does not deduct budget after approval', () => {
    sheets.set('DEPARTMENT_BUDGETS', [budget('it26')]);
    sheets.set('BUDGET_TRANSACTIONS', [allocation('it26')]);
    seedOfficial({ requestingDeptId: 'it', isAcademic: false, heads: { it: ['itHead'] }, involvedHeads: { hr: ['hrHead'] } });
    const req = requesterFor('it');
    const draft = createRfa(req, input({ requestedAmount: '9999999', budgetAllocation: 9999999, recommendingAlternateUserId: 'hrHead' }));
    submitRfa(req, draft.RFA_ID);
    acted(draft.RFA_ID, userById('itHead'));
    acted(draft.RFA_ID, userById('ofelia'));
    acted(draft.RFA_ID, userById('ana')); acted(draft.RFA_ID, userById('raquel')); acted(draft.RFA_ID, userById('president'));
    expect(status(draft.RFA_ID)).toBe('APPROVED');
    expect(commitments(draft.RFA_ID)).toHaveLength(0);
    expect(commitApprovedFinancialRfa(rfaRow(draft.RFA_ID), admin)).toBeNull();
    expect(summarizeBudget(budget('it26'), (sheets.get('BUDGET_TRANSACTIONS') as BudgetTransactionRecord[]).filter((row) => row.BUDGET_ID === 'it26')).available).toBe(50_000_000);
  });
});

describe('department expense monitoring (preserved)', () => {
  it('groups by requesting department as OPEX + CAPEX without double counting', () => {
    const req = requesterFor('it');
    const opex = createRfa(req, input({ expenseClassification: 'OPEX', requestedAmount: '10000', budgetAllocation: 10000, recommendingAlternateUserId: 'hrHead', involvedDepartmentIds: ['hr'] }));
    const capex = createRfa(req, input({ expenseClassification: 'CAPEX', requestedAmount: '5000', budgetAllocation: 5000, recommendingAlternateUserId: 'hrHead' }));
    for (const draft of [opex, capex]) {
      submitRfa(req, draft.RFA_ID);
      acted(draft.RFA_ID, userById('itHead'));
      acted(draft.RFA_ID, userById('ofelia'));
      if (assignmentsFor(draft.RFA_ID, 'REVIEWED_AND_NOTED').includes('hrHead')) acted(draft.RFA_ID, userById('hrHead'));
      acted(draft.RFA_ID, userById('ana')); acted(draft.RFA_ID, userById('raquel'));
    }
    const report = expenseMonitoringReport(admin, { fiscalYear: '2026' }) as { deptRows: Array<{ departmentName: string; totalOpex: number; totalCapex: number; total: number; rfaCount: number }>; totals: { totalOpex: number; totalCapex: number; total: number; rfaCount: number }; rows: Array<{ rfaId: string }> };
    expect(report.deptRows).toHaveLength(1);
    expect(report.deptRows[0]).toMatchObject({ departmentName: 'IT', totalOpex: 10000, totalCapex: 5000, total: 15000, rfaCount: 2 });
    expect(report.totals).toMatchObject({ totalOpex: 10000, totalCapex: 5000, total: 15000, rfaCount: 2 });
  });

  it('listing filters by expense classification and fiscal year', () => {
    const req = requesterFor('it');
    const opex = createRfa(req, input({ expenseClassification: 'OPEX', recommendingAlternateUserId: 'hrHead' }));
    const capex = createRfa(req, input({ expenseClassification: 'CAPEX', requestedAmount: '3000', budgetAllocation: 3000, recommendingAlternateUserId: 'hrHead' }));
    expect(listRfas(req, { expenseClassification: 'OPEX' }).map((r) => r.RFA_ID)).toEqual([opex.RFA_ID]);
    expect(listRfas(req, { expenseClassification: 'CAPEX' }).map((r) => r.RFA_ID)).toEqual([capex.RFA_ID]);
  });
});

describe('history, lifecycle, and backward compatibility (preserved)', () => {
  it('writes no commitment on implementation/close and keeps audit history', () => {
    const req = requesterFor('it');
    const draft = createRfa(req, input({ recommendingAlternateUserId: 'hrHead' }));
    submitRfa(req, draft.RFA_ID);
    acted(draft.RFA_ID, userById('itHead'));
    acted(draft.RFA_ID, userById('ofelia'));
    acted(draft.RFA_ID, userById('ana')); acted(draft.RFA_ID, userById('raquel'));
    transitionCloseout(admin, draft.RFA_ID, 'IMPLEMENTATION');
    transitionCloseout(admin, draft.RFA_ID, 'CLOSED');
    expect(commitments(draft.RFA_ID)).toHaveLength(0);
    expect((sheets.get('RFA_AUDIT') || []).filter((row) => row.RFA_ID === draft.RFA_ID).length).toBeGreaterThan(0);
    expect((sheets.get('RFA_APPROVALS') || []).filter((row) => row.RFA_ID === draft.RFA_ID && row.ACTION === 'APPROVED').length).toBeGreaterThan(0);
  });

  it('keeps historical budget data readable via financialDetail and summarizeBudget', () => {
    sheets.set('DEPARTMENT_BUDGETS', [budget('it26')]);
    sheets.set('BUDGET_TRANSACTIONS', [allocation('it26')]);
    sheets.set('EXPENSE_CATEGORIES', [{ CATEGORY_ID: 'historical', CATEGORY_NAME: 'Equipment', ACTIVE: false }]);
    const legacy = { IS_BUDGET_REQUEST: true, EXPENSE_CATEGORY_ID: 'historical', DEPARTMENT_ID: 'it', FISCAL_YEAR: '2026', REQUESTED_AMOUNT: 10000, APPROVED_AMOUNT: 10000, ACTUAL_AMOUNT: 9500, EXPENSE_CLASSIFICATION: '' } as RfaRecord;
    expect(financialDetail(legacy)).toMatchObject({ categoryName: 'Equipment', actualAmount: 95 });
    expect(summarizeBudget(budget('it26'), [allocation('it26'), { ...allocation('it26'), TRANSACTION_TYPE: 'COMMITMENT', AMOUNT: 10000 }, { ...allocation('it26'), TRANSACTION_TYPE: 'COMMITMENT_RELEASE', AMOUNT: 10000 }, { ...allocation('it26'), TRANSACTION_TYPE: 'ACTUAL_EXPENSE', AMOUNT: 9500 }]).available).toBe(49_990_500);
  });

  it('keeps RFA readable via detailRfa', () => {
    const req = requesterFor('it');
    const draft = createRfa(req, input({ recommendingAlternateUserId: 'hrHead' }));
    expect(detailRfa(req, draft.RFA_ID)).toMatchObject({ rfa: { EXPENSE_CLASSIFICATION: 'OPEX' } });
  });
});
