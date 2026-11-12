import { beforeEach, describe, expect, it, vi } from 'vitest';
import { commitApprovedFinancialRfa, expenseMonitoringReport, financialDetail, financialRfaFields, summarizeBudget } from '../src/budget';
import { allRfasScope, createRfa, decideRfa, detailRfa, listAllRfas, listForApproval, listRfas, submitRfa, transitionCloseout } from '../src/workflow';
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
  settingBoolean: vi.fn((key: string) => (settings.get(key) || '').toUpperCase() === 'TRUE'),
  newId: vi.fn((prefix: string) => `${prefix}_${++sequence}`),
  nowIso: vi.fn(() => stamp()),
  resetPerRequestCache: vi.fn(),
  clearPendingRfaAssignments: vi.fn((rfaId: string) => { sheets.set('RFA_APPROVALS', (sheets.get('RFA_APPROVALS') || []).filter((row) => row.RFA_ID !== rfaId || row.ACTION !== '')); }),
  saveRfaSectionAssignments: vi.fn((rfaId: string, rfaNumber: string, section: string, assignments: Array<{ USER_ID: string; FULL_NAME: string; EMAIL: string }>) => {
    for (const person of assignments) sheets.set('RFA_APPROVALS', [...(sheets.get('RFA_APPROVALS') || []), { RFA_ID: rfaId, RFA_NUMBER: rfaNumber, STEP: section, APPROVER_USER_ID: person.USER_ID, APPROVER_NAME: person.FULL_NAME, APPROVER_EMAIL: person.EMAIL, ACTION: '', APPROVAL_ID: `${rfaId}_${section}_${person.USER_ID}` }]);
  }),
  getAssignmentsBySection: vi.fn((rfaId: string, section: string) => (sheets.get('RFA_APPROVALS') || []).filter((row) => row.RFA_ID === rfaId && row.STEP === section && row.ACTION === ''))
}));
vi.mock('../src/audit', () => ({ audit: vi.fn((action: string, _actor: unknown, rfaId: string, _before: string, _after: string, remarks = '') => {
  sheets.set('RFA_AUDIT', [...(sheets.get('RFA_AUDIT') || []), { ACTION: action, RFA_ID: rfaId, REMARKS: remarks, TIMESTAMP: stamp() }]);
}) }));
vi.mock('../src/notifications', () => ({ notify: vi.fn(), buildEmail: vi.fn(() => ({ subject: 'subject', body: 'body' })) }));

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
    const draft = createRfa(req, input({ requestedAmount: '10000', budgetAllocation: 10000 }));
    expect(draft.CURRENT_MATRIX_ID).toBe('RFA_FIXED_V3');
    expect(assignmentsFor(draft.RFA_ID, 'RECOMMENDING_APPROVAL')).toEqual(['itHead']);
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

  it('Approved By emails go out in order: Ma\'am Tago, then the VPs, then the President', async () => {
    const { notify } = await import('../src/notifications');
    seedOfficial({ requestingDeptId: 'acad', isAcademic: true, heads: { acad: ['acadHead'] } });
    const req = requesterFor('acad');
    const draft = createRfa(req, input({ requestedAmount: '60000', budgetAllocation: 60000 }));
    submitRfa(req, draft.RFA_ID);
    acted(draft.RFA_ID, userById('acadHead'));
    const emailedTo = () => vi.mocked(notify).mock.calls.filter((c) => c[0] === 'APPROVAL_REQUIRED').map((c) => (c[1] as { EMAIL: string }).EMAIL).sort();
    vi.mocked(notify).mockClear();
    acted(draft.RFA_ID, userById('ofelia'));
    expect(emailedTo()).toEqual(['ana@example.edu']);
    expect(detailRfa(userById('ana'), draft.RFA_ID).approvedByOrder).toEqual({ ana: 0, raquel: 1, jennelyn: 1, president: 2 });
    // VPs and the President cannot act, and do not see it in For My Action, until their turn.
    const canDecide = (id: string) => (detailRfa(userById(id), draft.RFA_ID).permissions as { canDecide: boolean }).canDecide;
    const inQueue = (id: string) => listForApproval(userById(id)).some((r) => r.RFA_ID === draft.RFA_ID);
    expect(canDecide('ana')).toBe(true); expect(inQueue('ana')).toBe(true);
    expect(canDecide('raquel')).toBe(false); expect(inQueue('raquel')).toBe(false);
    expect(inQueue('president')).toBe(false);
    expect(() => acted(draft.RFA_ID, userById('raquel'))).toThrow(/not yet your turn/);
    vi.mocked(notify).mockClear();
    acted(draft.RFA_ID, userById('ana'));
    expect(emailedTo()).toEqual(['jennelyn@example.edu', 'raquel@example.edu']);
    expect(inQueue('raquel')).toBe(true); expect(inQueue('jennelyn')).toBe(true);
    expect(inQueue('president')).toBe(false); expect(canDecide('president')).toBe(false);
    acted(draft.RFA_ID, userById('raquel'));
    vi.mocked(notify).mockClear();
    acted(draft.RFA_ID, userById('jennelyn'));
    expect(emailedTo()).toEqual(['president@example.edu']);
    expect(inQueue('president')).toBe(true);
    acted(draft.RFA_ID, userById('president'));
    expect(status(draft.RFA_ID)).toBe('APPROVED');
  });

  it('5. Department with two heads: both heads must approve recommending', () => {
    seedOfficial({ requestingDeptId: 'dual', isAcademic: false, heads: { dual: ['dualHead1', 'dualHead2'] } });
    const req = requesterFor('dual');
    const draft = createRfa(req, input({ requestedAmount: '10000', budgetAllocation: 10000 }));
    expect(assignmentsFor(draft.RFA_ID, 'RECOMMENDING_APPROVAL').sort()).toEqual(['dualHead1', 'dualHead2'].sort());
    submitRfa(req, draft.RFA_ID);
    expect(step(draft.RFA_ID)).toBe('RECOMMENDING_APPROVAL');
    // First head approves; stage stays pending until second head also approves
    acted(draft.RFA_ID, userById('dualHead2'));
    expect(step(draft.RFA_ID)).toBe('RECOMMENDING_APPROVAL');
    acted(draft.RFA_ID, userById('dualHead1'));
    expect(step(draft.RFA_ID)).toBe('REVIEWED_AND_NOTED');
  });

  it('6. Department with one head: head approves alone (alternate removed)', () => {
    const req = requesterFor('it');
    const draft = createRfa(req, input({ requestedAmount: '10000', budgetAllocation: 10000 }));
    expect(assignmentsFor(draft.RFA_ID, 'RECOMMENDING_APPROVAL')).toEqual(['itHead']);
    submitRfa(req, draft.RFA_ID);
    acted(draft.RFA_ID, userById('itHead'));
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

  it('9. Procurement Clerk is removed from the workflow', () => {
    const req = requesterFor('it');
    const draft = createRfa(req, input({ requestedAmount: '10000', budgetAllocation: 10000, includeProcurement: true }));
    expect(assignmentsFor(draft.RFA_ID, 'REVIEWED_AND_NOTED')).not.toContain('procurement');
    expect(assignmentsFor(draft.RFA_ID, 'REVIEWED_AND_NOTED')).toEqual(['ofelia']);
    submitRfa(req, draft.RFA_ID);
    acted(draft.RFA_ID, userById('itHead'));
    acted(draft.RFA_ID, userById('ofelia'));
    expect(step(draft.RFA_ID)).toBe('APPROVED_BY');
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

  it('validates inapplicable optionals (Principal guard)', () => {
    const req = requesterFor('it'); // not JHS/SHS
    expect(() => createRfa(req, input({ requestingDeptId: 'it', includePrincipal: true }))).toThrow(/JHS\/SHS/);
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

describe('confirmed approver emails (preconfigured)', () => {
  it('resolves Raquel and President by confirmed email without interchanging them', () => {
    // Users use surname-first names but confirmed emails; name-only lookup would miss them.
    const usersWithConfirmed = [
      ...users,
      { USER_ID: 'raquel2', FULL_NAME: 'BAQUIRAN, RAQUEL L.', EMAIL: 'vp.finance@example.edu', ACTIVE: true, CAN_APPROVE_RFA: true, DEPARTMENT_ID: 'it' },
      { USER_ID: 'president2', FULL_NAME: 'DE GUZMAN-VALINO, ALESSANDRA L.', EMAIL: 'president@example.edu', ACTIVE: true, CAN_APPROVE_RFA: true, DEPARTMENT_ID: 'it' }
    ];
    sheets.set('USERS', usersWithConfirmed as SheetRecord[]);
    seedOfficial({ requestingDeptId: 'it', isAcademic: false, heads: { it: ['itHead'] }, involvedHeads: { hr: ['hrHead'] } });
    // Override the previously seeded official users with surname-first confirmed accounts and clear matrix so fallback must use email
    sheets.set('USERS', usersWithConfirmed as SheetRecord[]);
    sheets.set('APPROVAL_MATRIX', [matrixRow('it', 'REVIEWED_AND_NOTED', 'ofelia', 1), matrixRow('it', 'APPROVED_BY', 'ana', 1)]);
    settings.set('VP_ADMIN_FINANCE_EMAIL', 'vp.finance@example.edu');
    settings.set('PRESIDENT_EMAIL', 'president@example.edu');
    settings.set('APPROVED_MANDATORY_USER_IDS', '');
    settings.set('PRESIDENT_USER_ID', '');
    const req = requesterFor('it');
    const draft = createRfa(req, input({ requestedAmount: '60000', budgetAllocation: 60000, recommendingAlternateUserId: 'hrHead' }));
    // Raquel should be included via confirmed email fallback, President via email
    expect(assignmentsFor(draft.RFA_ID, 'APPROVED_BY')).toContain('raquel2');
    expect(assignmentsFor(draft.RFA_ID, 'APPROVED_BY')).toContain('president2');
    // Distinct accounts
    const raquelAssignment = (sheets.get('RFA_APPROVALS') || []).find((r) => r.STEP === 'APPROVED_BY' && r.APPROVER_USER_ID === 'raquel2');
    const presidentAssignment = (sheets.get('RFA_APPROVALS') || []).find((r) => r.STEP === 'APPROVED_BY' && r.APPROVER_USER_ID === 'president2');
    expect(raquelAssignment?.APPROVER_EMAIL).toBe('vp.finance@example.edu');
    expect(presidentAssignment?.APPROVER_EMAIL).toBe('president@example.edu');
  });
});

describe('procurement view-only access', () => {
  it('procurement users can view approved RFAs but cannot approve', () => {
    const req = requesterFor('it');
    const procurementUser = { ...userById('procurement'), DEPARTMENT_ID: 'ppu' } as SessionUser;
    // Add a PPU department so the procurement check resolves
    const deps = (sheets.get('DEPARTMENTS') || []) as SheetRecord[];
    sheets.set('DEPARTMENTS', [...deps, { DEPARTMENT_ID: 'ppu', DEPARTMENT_NAME: 'Procurement Unit', DEPARTMENT_CODE: 'PPU', ACTIVE: true, DEPARTMENT_HEAD_USER_ID: 'procurement', IS_ACADEMIC: false }]);
    const all = (sheets.get('USERS') || []) as SheetRecord[];
    const idx = all.findIndex((u) => String(u.USER_ID) === 'procurement');
    if (idx >= 0) { (all[idx] as Record<string, unknown>).DEPARTMENT_ID = 'ppu'; sheets.set('USERS', all); }
    const draft = createRfa(req, input({}));
    submitRfa(req, draft.RFA_ID);
    // Pending: procurement cannot view, and it is not in their All RFAs register
    expect(() => detailRfa(procurementUser, draft.RFA_ID)).toThrow('do not have access');
    expect(allRfasScope(procurementUser)).toBe('approved');
    expect(listAllRfas(procurementUser, {}).map((r) => r.RFA_ID)).not.toContain(draft.RFA_ID);
    acted(draft.RFA_ID, userById('itHead'));
    acted(draft.RFA_ID, userById('ofelia'));
    acted(draft.RFA_ID, userById('ana')); acted(draft.RFA_ID, userById('raquel'));
    expect(status(draft.RFA_ID)).toBe('APPROVED');
    // Approved: can view via list and detail, but cannot approve (not assigned)
    expect(listAllRfas(procurementUser, {}).map((r) => r.RFA_ID)).toContain(draft.RFA_ID);
    expect(listRfas(procurementUser, {}).map((r) => r.RFA_ID)).not.toContain(draft.RFA_ID); // My RFAs = own requests only
    expect(detailRfa(procurementUser, draft.RFA_ID).rfa).toMatchObject({ RFA_ID: draft.RFA_ID });
    expect(() => acted(draft.RFA_ID, procurementUser)).toThrow('not assigned');
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

describe('My RFAs and All RFAs visibility', () => {
  it('My RFAs lists only the requests a user filed, even for approvers', () => {
    const req = requesterFor('it');
    const draft = createRfa(req, input({}));
    submitRfa(req, draft.RFA_ID);
    expect(listRfas(req, {}).map((r) => r.RFA_ID)).toContain(draft.RFA_ID);
    expect(listRfas(userById('itHead'), {}).map((r) => r.RFA_ID)).not.toContain(draft.RFA_ID);
    // The assigned approver can still open it from their queue
    expect(detailRfa(userById('itHead'), draft.RFA_ID).rfa).toMatchObject({ RFA_ID: draft.RFA_ID });
  });

  it('officials see every submitted RFA in All RFAs; regular staff cannot open the register', () => {
    const req = requesterFor('it');
    const draft = createRfa(req, input({}));
    submitRfa(req, draft.RFA_ID);
    const unsent = createRfa(req, input({}));
    for (const official of ['ofelia', 'ana', 'raquel', 'jennelyn', 'president']) {
      expect(allRfasScope(userById(official))).toBe('all');
      const ids = listAllRfas(userById(official), {}).map((r) => r.RFA_ID);
      expect(ids).toContain(draft.RFA_ID);
      expect(ids).not.toContain(unsent.RFA_ID); // drafts stay private to the requester
    }
    expect(allRfasScope(req)).toBe('none');
    expect(allRfasScope(userById('itHead'))).toBe('none');
    expect(() => listAllRfas(userById('itHead'), {})).toThrow('do not have access');
  });
});

describe('official roles: the person can change, the role stays the same', () => {
  function addUser(user: SessionUser) {
    sheets.set('USERS', [...((sheets.get('USERS') || []) as SheetRecord[]), user as unknown as SheetRecord]);
    users.push(user as unknown as SheetRecord);
  }

  it('routes Approved By to the newly assigned AVP for Finance and moves access and email order with the role', () => {
    addUser(namedUser('newAvp', 'Maria Santos'));
    settings.set('APPROVED_MANDATORY_USER_IDS', 'newAvp,raquel');
    const req = requesterFor('it');
    const draft = createRfa(req, input({}));
    submitRfa(req, draft.RFA_ID);
    expect(assignmentsFor(draft.RFA_ID, 'APPROVED_BY')).toEqual(expect.arrayContaining(['newAvp', 'raquel']));
    expect(assignmentsFor(draft.RFA_ID, 'APPROVED_BY')).not.toContain('ana');
    expect(allRfasScope(userById('newAvp'))).toBe('all');
    expect(allRfasScope(userById('ana'))).toBe('none'); // previous holder loses the role's access
    // The new holder is emailed first in Approved By, exactly as the role says.
    acted(draft.RFA_ID, userById('itHead'));
    acted(draft.RFA_ID, userById('ofelia'));
    expect(() => acted(draft.RFA_ID, userById('raquel'))).toThrow();
    acted(draft.RFA_ID, userById('newAvp'));
    acted(draft.RFA_ID, userById('raquel'));
    expect(status(draft.RFA_ID)).toBe('APPROVED');
  });

  it('a replaced President or Reviewed and Noted official no longer routes or sees All RFAs', () => {
    addUser(namedUser('newPresident', 'Jose Rizal'));
    addUser(namedUser('newReviewer', 'Andres Bonifacio'));
    settings.set('PRESIDENT_USER_ID', 'newPresident');
    settings.set('REVIEWED_MANDATORY_USER_ID', 'newReviewer');
    const req = requesterFor('it');
    const draft = createRfa(req, input({ requestedAmount: '60000', budgetAllocation: 60000 }));
    submitRfa(req, draft.RFA_ID);
    expect(assignmentsFor(draft.RFA_ID, 'REVIEWED_AND_NOTED')).toContain('newReviewer');
    expect(assignmentsFor(draft.RFA_ID, 'REVIEWED_AND_NOTED')).not.toContain('ofelia');
    expect(assignmentsFor(draft.RFA_ID, 'APPROVED_BY')).toContain('newPresident');
    expect(assignmentsFor(draft.RFA_ID, 'APPROVED_BY')).not.toContain('president');
    expect(allRfasScope(userById('president'))).toBe('none');
    expect(allRfasScope(userById('ofelia'))).toBe('none');
    expect(allRfasScope(userById('newPresident'))).toBe('all');
  });
});

describe('RFA numbering', () => {
  it('gives numbers at submission from one shared counter: in submit order, no gaps, no duplicates', () => {
    const year = new Date().getFullYear();
    settings.set('LAST_RFA_YEAR', String(year));
    settings.set('LAST_RFA_SEQUENCE', '0');
    const it1 = requesterFor('it');
    const first = createRfa(it1, input({}));
    const neverSent = createRfa(it1, input({}));
    const third = createRfa(it1, input({}));
    // Drafts have no number and use none up.
    expect([first.RFA_NUMBER, neverSent.RFA_NUMBER, third.RFA_NUMBER]).toEqual(['', '', '']);
    expect(settings.get('LAST_RFA_SEQUENCE')).toBe('0');

    // Numbers follow the order RFAs are actually submitted.
    submitRfa(it1, third.RFA_ID);
    submitRfa(it1, first.RFA_ID);
    const numberOf = (id: string) => String((sheets.get('RFA') || []).find((row) => row.RFA_ID === id)?.RFA_NUMBER);
    expect(numberOf(third.RFA_ID)).toBe(`RFA-${year}-0001`);
    expect(numberOf(first.RFA_ID)).toBe(`RFA-${year}-0002`);
    expect(numberOf(neverSent.RFA_ID)).toBe('');

    // A rejected submit does not use a number.
    expect(() => submitRfa(it1, first.RFA_ID)).toThrow();
    expect(settings.get('LAST_RFA_SEQUENCE')).toBe('2');

    // The approval route rows carry the new number.
    const routeNumbers = (sheets.get('RFA_APPROVALS') || []).filter((row) => row.RFA_ID === first.RFA_ID).map((row) => String(row.RFA_NUMBER));
    expect(routeNumbers.length).toBeGreaterThan(0);
    expect(new Set(routeNumbers)).toEqual(new Set([`RFA-${year}-0002`]));
  });

  it('keeps the same number when a returned RFA is resubmitted', () => {
    const req = requesterFor('it');
    const draft = createRfa(req, input({}));
    submitRfa(req, draft.RFA_ID);
    const numbered = String((sheets.get('RFA') || []).find((row) => row.RFA_ID === draft.RFA_ID)?.RFA_NUMBER);
    expect(numbered).toMatch(/^RFA-\d{4}-\d{4}$/);
    decideRfa(userById('itHead'), draft.RFA_ID, 'RETURNED', 'Please attach the quotation.');
    submitRfa(req, draft.RFA_ID, true);
    expect(String((sheets.get('RFA') || []).find((row) => row.RFA_ID === draft.RFA_ID)?.RFA_NUMBER)).toBe(numbered);
  });
});

describe('configurable approval roles', () => {
  const role = (over: Record<string, unknown>) => ({ ROLE_ID: 'R', TITLE: 'Role', STAGE: 'APPROVED_BY', CONDITION: 'ALWAYS', EMAIL_ORDER: 1, ALL_RFAS_ACCESS: true, USER_ID: '', ACTIVE: true, SORT: 10, ...over });
  function addUser(user: SessionUser) {
    sheets.set('USERS', [...((sheets.get('USERS') || []) as SheetRecord[]), user as unknown as SheetRecord]);
    users.push(user as unknown as SheetRecord);
  }
  const baseRoles = () => [
    role({ ROLE_ID: 'REVIEWED', TITLE: 'Reviewed and Noted By', STAGE: 'REVIEWED_AND_NOTED', USER_ID: 'ofelia', SORT: 10 }),
    role({ ROLE_ID: 'APPROVED_FIRST', TITLE: 'AVP for Finance', EMAIL_ORDER: 0, USER_ID: 'ana', SORT: 20 }),
    role({ ROLE_ID: 'VP_FINANCE', TITLE: 'VP for Admin and Finance', USER_ID: 'raquel', SORT: 30 }),
    role({ ROLE_ID: 'VP_ACADEMIC', TITLE: 'VP for Academic Affairs', CONDITION: 'ACADEMIC', USER_ID: 'jennelyn', SORT: 40 }),
    role({ ROLE_ID: 'PRESIDENT', TITLE: 'President', CONDITION: 'AT_OR_ABOVE_THRESHOLD', EMAIL_ORDER: 2, USER_ID: 'president', SORT: 50 }),
    role({ ROLE_ID: 'PRINCIPAL', TITLE: 'JHS/SHS Principal', STAGE: 'REVIEWED_AND_NOTED', CONDITION: 'JHS_SHS_OPTIONAL', ALL_RFAS_ACCESS: false, USER_ID: 'principal', SORT: 60 })
  ];

  it('routes a newly added role and gives it its email order and All RFAs access', () => {
    addUser(namedUser('director', 'Finance Director'));
    sheets.set('ROLES', [...baseRoles(), role({ ROLE_ID: 'FIN_DIR', TITLE: 'Finance Director', EMAIL_ORDER: 2, USER_ID: 'director', SORT: 35 })] as SheetRecord[]);
    const req = requesterFor('it');
    const draft = createRfa(req, input({}));
    submitRfa(req, draft.RFA_ID);
    expect(assignmentsFor(draft.RFA_ID, 'APPROVED_BY')).toEqual(expect.arrayContaining(['ana', 'raquel', 'director']));
    expect(allRfasScope(userById('director'))).toBe('all');
    acted(draft.RFA_ID, userById('itHead'));
    acted(draft.RFA_ID, userById('ofelia'));
    // Emailed last: cannot act before the AVP (first) and the VP (middle) have approved.
    expect(() => acted(draft.RFA_ID, userById('director'))).toThrow();
    acted(draft.RFA_ID, userById('ana'));
    acted(draft.RFA_ID, userById('raquel'));
    acted(draft.RFA_ID, userById('director'));
    expect(status(draft.RFA_ID)).toBe('APPROVED');
  });

  it('applies conditional roles only when their condition holds, and skips switched-off roles', () => {
    sheets.set('ROLES', baseRoles().map((r) => (r.ROLE_ID === 'VP_FINANCE' ? { ...r, ACTIVE: false } : r)) as SheetRecord[]);
    const req = requesterFor('it');
    const small = createRfa(req, input({ requestedAmount: '20000', budgetAllocation: 20000 }));
    submitRfa(req, small.RFA_ID);
    expect(assignmentsFor(small.RFA_ID, 'APPROVED_BY')).toEqual(['ana']); // VP off, no President below threshold, not academic
    const large = createRfa(req, input({ requestedAmount: '60000', budgetAllocation: 60000 }));
    submitRfa(req, large.RFA_ID);
    expect(assignmentsFor(large.RFA_ID, 'APPROVED_BY')).toEqual(expect.arrayContaining(['ana', 'president']));
    expect(allRfasScope(userById('raquel'))).toBe('none'); // switched-off role gives no access
  });

  it('names the role when an applicable role has no person', () => {
    sheets.set('ROLES', baseRoles().map((r) => (r.ROLE_ID === 'PRESIDENT' ? { ...r, USER_ID: 'nobody' } : r)) as SheetRecord[]);
    const req = requesterFor('it');
    const draft = createRfa(req, input({ requestedAmount: '60000', budgetAllocation: 60000 }));
    expect(() => submitRfa(req, draft.RFA_ID)).toThrow('The approval role "President" has no person assigned');
  });
});

describe('keeping RFAs moving: hand over, reminders, email retries', () => {
  const admin = () => ({ ...userById('itHead'), IS_ADMIN: true }) as SessionUser;
  function addUser(user: SessionUser) {
    sheets.set('USERS', [...((sheets.get('USERS') || []) as SheetRecord[]), user as unknown as SheetRecord]);
    users.push(user as unknown as SheetRecord);
  }
  const submitted = () => {
    const req = requesterFor('it');
    const draft = createRfa(req, input({}));
    submitRfa(req, draft.RFA_ID);
    return draft.RFA_ID;
  };

  it('hands one RFA from an approver on leave to a stand-in, who can then approve', async () => {
    const { reassignApprovals } = await import('../src/workflow');
    addUser(namedUser('standIn', 'Stand In Reviewer'));
    const rfaId = submitted();
    acted(rfaId, userById('itHead')); // now waiting on Reviewed and Noted (ofelia)
    const result = reassignApprovals(admin(), { rfaId, fromUserId: 'ofelia', toUserId: 'standIn', reason: 'On leave until June' });
    expect(result).toMatchObject({ count: 1 });
    expect(assignmentsFor(rfaId, 'REVIEWED_AND_NOTED')).toEqual(['standIn']);
    expect(() => acted(rfaId, userById('ofelia'))).toThrow();
    acted(rfaId, userById('standIn'));
    expect(status(rfaId)).toBe('PENDING_AUTHORITY_APPROVAL');
    expect((sheets.get('RFA_AUDIT') || []).some((row) => row.ACTION === 'APPROVER_REASSIGNED' && row.RFA_ID === rfaId)).toBe(true);
  });

  it('previews and then hands over every waiting RFA of a person, without touching given approvals', async () => {
    const { reassignApprovals } = await import('../src/workflow');
    addUser(namedUser('newAvp', 'New AVP'));
    const first = submitted();
    const second = submitted();
    const preview = reassignApprovals(admin(), { fromUserId: 'ana', preview: true }) as { count: number };
    expect(preview.count).toBe(2);
    expect(assignmentsFor(first, 'APPROVED_BY')).toContain('ana'); // preview changed nothing
    reassignApprovals(admin(), { fromUserId: 'ana', toUserId: 'newAvp', reason: 'Resigned' });
    for (const id of [first, second]) {
      expect(assignmentsFor(id, 'APPROVED_BY')).toContain('newAvp');
      expect(assignmentsFor(id, 'APPROVED_BY')).not.toContain('ana');
    }
  });

  it('refuses unsafe hand-overs', async () => {
    const { reassignApprovals } = await import('../src/workflow');
    const rfaId = submitted();
    expect(() => reassignApprovals(userById('itHead'), { rfaId, fromUserId: 'itHead', toUserId: 'ofelia', reason: 'x leave' })).toThrow('Only an administrator');
    expect(() => reassignApprovals(admin(), { rfaId, fromUserId: 'itHead', toUserId: 'ofelia', reason: '' })).toThrow('short reason');
    // The new approver is already in that step: skipped, not duplicated.
    const result = reassignApprovals(admin(), { fromUserId: 'ana', toUserId: 'raquel', reason: 'Testing clash' }) as { count: number; skipped: unknown[] };
    expect(result.count).toBe(0);
    expect(result.skipped.length).toBe(1);
  });

  it('reminds only the approvers an RFA is waiting on, after the reminder period, and not twice in a row', async () => {
    const { sendReminders } = await import('../src/followups');
    const { notify } = await import('../src/notifications');
    settings.set('EMAIL_ENABLED', 'TRUE');
    const rfaId = submitted();
    const submittedAt = Date.parse(String(rfaRow(rfaId).SUBMITTED_AT));
    vi.mocked(notify).mockClear();
    expect(sendReminders(new Date(submittedAt + 2 * 86400000)).reminders).toBe(0); // only 2 days
    const result = sendReminders(new Date(submittedAt + 4 * 86400000));
    expect(result.reminders).toBe(1);
    expect(vi.mocked(notify).mock.calls[0][0]).toBe('APPROVAL_REMINDER');
    expect(vi.mocked(notify).mock.calls[0][1]).toMatchObject({ EMAIL: 'itHead@example.edu' }); // the department head, not later steps
    sheets.set('NOTIFICATIONS', [{ NOTIFICATION_TYPE: 'APPROVAL_REMINDER', STATUS: 'SENT', RFA_ID: rfaId, RECIPIENT_EMAIL: 'itHead@example.edu', SENT_AT: new Date(submittedAt + 4 * 86400000).toISOString() }]);
    expect(sendReminders(new Date(submittedAt + 5 * 86400000)).reminders).toBe(0); // reminded yesterday
  });

  it('retries a failed approval email only while that approver is still being waited on', async () => {
    const { retryFailedEmails } = await import('../src/followups');
    settings.set('EMAIL_ENABLED', 'TRUE');
    const sent: string[] = [];
    vi.stubGlobal('MailApp', { sendEmail: (m: { to: string }) => { sent.push(m.to); } });
    const rfaId = submitted();
    sheets.set('NOTIFICATIONS', [
      { NOTIFICATION_ID: 'n1', NOTIFICATION_TYPE: 'APPROVAL_REQUIRED', STATUS: 'FAILED', RFA_ID: rfaId, RECIPIENT: 'IT Head', RECIPIENT_EMAIL: 'itHead@example.edu', RETRY_COUNT: 0 },
      { NOTIFICATION_ID: 'n2', NOTIFICATION_TYPE: 'APPROVAL_REQUIRED', STATUS: 'FAILED', RFA_ID: rfaId, RECIPIENT: 'Ana', RECIPIENT_EMAIL: 'ana@example.edu', RETRY_COUNT: 0 }
    ]);
    const result = retryFailedEmails(new Date());
    expect(result).toEqual({ retried: 1, sent: 1 });
    expect(sent).toEqual(['itHead@example.edu']); // Ana's step has not started: not resent
    expect((sheets.get('NOTIFICATIONS') || []).find((row) => row.NOTIFICATION_ID === 'n1')).toMatchObject({ STATUS: 'SENT', RETRY_COUNT: 1 });
  });
});

describe('approval matrix leftovers', () => {
  it('turns off only rows whose department or person no longer exists, and routing is unchanged', async () => {
    const { turnOffLeftoverMatrixRows } = await import('../src/admin');
    const admin = { ...userById('itHead'), IS_ADMIN: true } as SessionUser;
    const matrix = (sheets.get('APPROVAL_MATRIX') || []) as SheetRecord[];
    const working = matrix.length;
    sheets.set('APPROVAL_MATRIX', [...matrix,
      { MATRIX_ID: 'gone_dept', DEPARTMENT_ID: 'deleted', APPROVAL_STEP: 'RECOMMENDING_APPROVAL', APPROVER_USER_ID: 'itHead', SEQUENCE: 1, REQUIRED: true, ACTIVE: true },
      { MATRIX_ID: 'gone_user', DEPARTMENT_ID: 'it', APPROVAL_STEP: 'APPROVED_BY', APPROVER_USER_ID: 'deleted_user', SEQUENCE: 1, REQUIRED: true, ACTIVE: true }
    ] as SheetRecord[]);
    const result = turnOffLeftoverMatrixRows(admin) as { turnedOff: number };
    expect(result.turnedOff).toBe(2);
    const rows = (sheets.get('APPROVAL_MATRIX') || []) as SheetRecord[];
    expect(rows.filter((row) => row.ACTIVE === true)).toHaveLength(working);
    expect(rows.find((row) => row.MATRIX_ID === 'gone_dept')).toMatchObject({ ACTIVE: false });
    // A normal RFA still routes exactly as before.
    const req = requesterFor('it');
    const draft = createRfa(req, input({}));
    submitRfa(req, draft.RFA_ID);
    expect(assignmentsFor(draft.RFA_ID, 'RECOMMENDING_APPROVAL')).toEqual(['itHead']);
  });
});

describe('hand-over keeps the email order', () => {
  it("a stand-in for the AVP for Finance keeps the AVP's place: emailed first, the VP still waits", async () => {
    const { reassignApprovals } = await import('../src/workflow');
    const { notify } = await import('../src/notifications');
    const extra = namedUser('standIn', 'Stand In');
    sheets.set('USERS', [...((sheets.get('USERS') || []) as SheetRecord[]), extra as unknown as SheetRecord]);
    users.push(extra as unknown as SheetRecord);
    const req = requesterFor('it');
    const draft = createRfa(req, input({}));
    submitRfa(req, draft.RFA_ID);
    acted(draft.RFA_ID, userById('itHead'));
    acted(draft.RFA_ID, userById('ofelia')); // now Approved By: AVP (ana) first, then the VP (raquel)
    vi.mocked(notify).mockClear();
    reassignApprovals({ ...userById('itHead'), IS_ADMIN: true } as SessionUser, { rfaId: draft.RFA_ID, fromUserId: 'ana', toUserId: 'standIn', reason: 'On leave' });
    expect(vi.mocked(notify).mock.calls.map((call) => (call[1] as { EMAIL: string }).EMAIL)).toEqual(['standIn@example.edu']);
    expect(() => acted(draft.RFA_ID, userById('raquel'))).toThrow(); // still waits for the AVP's stand-in
    acted(draft.RFA_ID, userById('standIn'));
    acted(draft.RFA_ID, userById('raquel'));
    expect(status(draft.RFA_ID)).toBe('APPROVED');
  });
});
