import { audit } from './audit';
import { requireCapability } from './auth';
import { centavosToPhp, parseCentavos, toBoolean } from './core';
import { all, findBy, insert, newId, nowIso, resetPerRequestCache, updateBy } from './store';
import type { BudgetTransactionRecord, DepartmentBudgetRecord, DepartmentRecord, ExpenseCategoryRecord, RfaRecord, SessionUser } from './types';

type Summary = { allocated: number; committed: number; actualSpent: number; available: number; utilization: number };
type PublicSummary = Summary & { budgetId: string; departmentId: string; fiscalYear: string; allowOverBudget: boolean; status: string };
const active = (transaction: BudgetTransactionRecord) => transaction.STATUS !== 'VOID';

function failure(message: string, code = 'INVALID_OPERATION'): never { const error = new Error(message) as Error & { code?: string }; error.code = code; throw error; }
function year(value: unknown): string { const result = String(value || new Date().getFullYear()).trim(); if (!/^\d{4}$/.test(result)) failure('Fiscal year must be a four-digit year.'); return result; }
function budgetFor(departmentId: string, fiscalYear: string): DepartmentBudgetRecord | undefined { return all<DepartmentBudgetRecord>('DEPARTMENT_BUDGETS').find((item) => item.DEPARTMENT_ID === departmentId && String(item.FISCAL_YEAR) === fiscalYear && item.STATUS !== 'INACTIVE'); }
function ledger(budgetId: string): BudgetTransactionRecord[] { return all<BudgetTransactionRecord>('BUDGET_TRANSACTIONS').filter((item) => item.BUDGET_ID === budgetId && active(item)); }

export function summarizeBudget(budget: DepartmentBudgetRecord, transactions = ledger(budget.BUDGET_ID)): Summary {
  let allocated = 0; let committed = 0; let actualSpent = 0;
  transactions.forEach((item) => {
    const amount = Number(item.AMOUNT || 0);
    if (item.TRANSACTION_TYPE === 'ALLOCATION' || item.TRANSACTION_TYPE === 'ADJUSTMENT_INCREASE') allocated += amount;
    if (item.TRANSACTION_TYPE === 'ADJUSTMENT_DECREASE') allocated -= amount;
    if (item.TRANSACTION_TYPE === 'COMMITMENT') committed += amount;
    if (item.TRANSACTION_TYPE === 'COMMITMENT_RELEASE') committed -= amount;
    if (item.TRANSACTION_TYPE === 'ACTUAL_EXPENSE') actualSpent += amount;
    if (item.TRANSACTION_TYPE === 'REVERSAL') actualSpent -= amount;
  });
  return { allocated, committed, actualSpent, available: allocated - committed - actualSpent, utilization: allocated > 0 ? (committed + actualSpent) / allocated : 0 };
}

function publicSummary(budget: DepartmentBudgetRecord, summary = summarizeBudget(budget)): PublicSummary {
  return { budgetId: budget.BUDGET_ID, departmentId: budget.DEPARTMENT_ID, fiscalYear: budget.FISCAL_YEAR, allowOverBudget: toBoolean(budget.ALLOW_OVER_BUDGET), status: budget.STATUS,
    allocated: centavosToPhp(summary.allocated), committed: centavosToPhp(summary.committed), actualSpent: centavosToPhp(summary.actualSpent), available: centavosToPhp(summary.available), utilization: summary.utilization };
}

function writeTransaction(user: SessionUser, budget: DepartmentBudgetRecord, type: string, amount: number, description: string, options: { rfaId?: string; categoryId?: string; reference?: string } = {}): void {
  const timestamp = nowIso();
  insert('BUDGET_TRANSACTIONS', { TRANSACTION_ID: newId('btx'), BUDGET_ID: budget.BUDGET_ID, DEPARTMENT_ID: budget.DEPARTMENT_ID, FISCAL_YEAR: budget.FISCAL_YEAR,
    RFA_ID: options.rfaId || '', CATEGORY_ID: options.categoryId || '', TRANSACTION_TYPE: type, AMOUNT: amount, DESCRIPTION: description.trim(), REFERENCE: options.reference || '', STATUS: 'POSTED', CREATED_BY: user.EMAIL, CREATED_AT: timestamp, UPDATED_BY: user.EMAIL, UPDATED_AT: timestamp });
}

export function requesterBudgetContext(user: SessionUser, fiscalYearValue: unknown): Record<string, unknown> {
  requireCapability(user, 'CAN_CREATE_RFA');
  if (!user.DEPARTMENT_ID) failure('Your account does not have a department.', 'CONFIGURATION_REQUIRED');
  const fiscalYear = year(fiscalYearValue);
  const budget = budgetFor(user.DEPARTMENT_ID, fiscalYear);
  return { fiscalYear, departmentId: user.DEPARTMENT_ID, departmentName: user.DEPARTMENT_NAME, budget: budget ? publicSummary(budget) : null,
    categories: all<ExpenseCategoryRecord>('EXPENSE_CATEGORIES').filter((category) => toBoolean(category.ACTIVE)).map((category) => ({ id: category.CATEGORY_ID, name: category.CATEGORY_NAME, description: category.DESCRIPTION })) };
}

export function financialRfaFields(user: SessionUser, payload: Record<string, unknown>, required: boolean): Record<string, string | number | boolean> {
  const isFinancial = toBoolean(payload.isBudgetRequest);
  if (!isFinancial) return { IS_BUDGET_REQUEST: false, EXPENSE_CATEGORY_ID: '', REQUESTED_AMOUNT: 0, APPROVED_AMOUNT: 0, ACTUAL_AMOUNT: 0, FISCAL_YEAR: '', ACTUAL_EXPENSE_RECORDED_AT: '' };
  const fiscalYear = year(payload.fiscalYear);
  const categoryId = String(payload.expenseCategoryId || '').trim();
  const amount = parseCentavos(payload.requestedAmount, 'Requested amount');
  const category = findBy<ExpenseCategoryRecord>('EXPENSE_CATEGORIES', 'CATEGORY_ID', categoryId);
  if (!category || !toBoolean(category.ACTIVE)) failure('Select an active expense category.', 'INVALID_CATEGORY');
  const budget = budgetFor(user.DEPARTMENT_ID, fiscalYear);
  if (required && !budget) failure(`No FY ${fiscalYear} budget has been configured for your department.`, 'BUDGET_NOT_CONFIGURED');
  return { IS_BUDGET_REQUEST: true, EXPENSE_CATEGORY_ID: categoryId, REQUESTED_AMOUNT: amount, APPROVED_AMOUNT: 0, ACTUAL_AMOUNT: 0, FISCAL_YEAR: fiscalYear, ACTUAL_EXPENSE_RECORDED_AT: '' };
}

/** Called under the API mutation lock immediately before final approval is persisted. */
export function commitApprovedFinancialRfa(rfa: RfaRecord, actor: SessionUser): Record<string, string | number> | null {
  if (!toBoolean(rfa.IS_BUDGET_REQUEST)) return null;
  resetPerRequestCache(); // authoritative ledger read while the ScriptLock is held
  const budget = budgetFor(rfa.DEPARTMENT_ID, String(rfa.FISCAL_YEAR));
  if (!budget) failure(`No FY ${rfa.FISCAL_YEAR} budget is configured for this department.`, 'BUDGET_NOT_CONFIGURED');
  const existing = ledger(budget.BUDGET_ID).find((item) => item.RFA_ID === rfa.RFA_ID && item.TRANSACTION_TYPE === 'COMMITMENT');
  if (existing) return { APPROVED_AMOUNT: Number(rfa.APPROVED_AMOUNT || existing.AMOUNT) || Number(existing.AMOUNT) };
  const approvedAmount = Number(rfa.APPROVED_AMOUNT || rfa.REQUESTED_AMOUNT);
  if (!Number.isSafeInteger(approvedAmount) || approvedAmount <= 0) failure('Financial RFA has an invalid requested amount.', 'INVALID_AMOUNT');
  const summary = summarizeBudget(budget);
  if (!toBoolean(budget.ALLOW_OVER_BUDGET) && approvedAmount > summary.available) failure('This RFA exceeds the department’s available budget and cannot be approved.', 'INSUFFICIENT_BUDGET');
  writeTransaction(actor, budget, 'COMMITMENT', approvedAmount, `Approved RFA ${rfa.RFA_NUMBER} commitment.`, { rfaId: rfa.RFA_ID, categoryId: rfa.EXPENSE_CATEGORY_ID, reference: rfa.RFA_NUMBER });
  audit('BUDGET_COMMITMENT_CREATED', actor, rfa.RFA_ID, rfa.STATUS, rfa.STATUS, `PHP ${centavosToPhp(approvedAmount).toFixed(2)} committed.`, { budgetId: budget.BUDGET_ID, fiscalYear: rfa.FISCAL_YEAR, amountCentavos: approvedAmount });
  return { APPROVED_AMOUNT: approvedAmount };
}

export function recordActualExpense(user: SessionUser, rfa: RfaRecord, payload: Record<string, unknown>): Record<string, unknown> {
  if (!toBoolean(user.CAN_IMPLEMENT_RFA) && !toBoolean(user.IS_ADMIN)) failure('You do not have implementation permission.', 'FORBIDDEN');
  if (!toBoolean(rfa.IS_BUDGET_REQUEST)) failure('This is not a financial RFA.');
  if (!['APPROVED', 'IMPLEMENTATION', 'CLOSED'].includes(rfa.STATUS)) failure('Actual expense may be recorded only after final approval.');
  resetPerRequestCache();
  const budget = budgetFor(rfa.DEPARTMENT_ID, String(rfa.FISCAL_YEAR));
  if (!budget) failure('The associated department budget is missing.', 'BUDGET_NOT_CONFIGURED');
  const actual = parseCentavos(payload.actualAmount, 'Actual amount', true);
  const transactions = ledger(budget.BUDGET_ID);
  const existingActual = transactions.find((item) => item.RFA_ID === rfa.RFA_ID && item.TRANSACTION_TYPE === 'ACTUAL_EXPENSE');
  if (existingActual) return { alreadyRecorded: true, actualAmount: centavosToPhp(existingActual.AMOUNT), budget: publicSummary(budget, summarizeBudget(budget, transactions)) };
  const commitment = transactions.find((item) => item.RFA_ID === rfa.RFA_ID && item.TRANSACTION_TYPE === 'COMMITMENT');
  if (!commitment) failure('No active budget commitment exists for this RFA.', 'CONFLICT');
  const releaseExists = transactions.some((item) => item.RFA_ID === rfa.RFA_ID && item.TRANSACTION_TYPE === 'COMMITMENT_RELEASE');
  if (!releaseExists) writeTransaction(user, budget, 'COMMITMENT_RELEASE', Number(commitment.AMOUNT), `Commitment released for ${rfa.RFA_NUMBER}.`, { rfaId: rfa.RFA_ID, categoryId: rfa.EXPENSE_CATEGORY_ID, reference: rfa.RFA_NUMBER });
  writeTransaction(user, budget, 'ACTUAL_EXPENSE', actual, String(payload.note || 'Actual expense recorded.'), { rfaId: rfa.RFA_ID, categoryId: rfa.EXPENSE_CATEGORY_ID, reference: String(payload.reference || rfa.RFA_NUMBER) });
  updateBy('RFA', 'RFA_ID', rfa.RFA_ID, { ACTUAL_AMOUNT: actual, ACTUAL_EXPENSE_RECORDED_AT: nowIso(), UPDATED_AT: nowIso(), VERSION: Number(rfa.VERSION) + 1 });
  audit('ACTUAL_EXPENSE_RECORDED', user, rfa.RFA_ID, rfa.STATUS, rfa.STATUS, `PHP ${centavosToPhp(actual).toFixed(2)} actual expense recorded.`, { budgetId: budget.BUDGET_ID, amountCentavos: actual });
  resetPerRequestCache();
  return { alreadyRecorded: false, actualAmount: centavosToPhp(actual), budget: publicSummary(budget) };
}

export function financialDetail(rfa: RfaRecord): Record<string, unknown> | null {
  if (!toBoolean(rfa.IS_BUDGET_REQUEST)) return null;
  const budget = budgetFor(rfa.DEPARTMENT_ID, String(rfa.FISCAL_YEAR));
  const category = findBy<ExpenseCategoryRecord>('EXPENSE_CATEGORIES', 'CATEGORY_ID', rfa.EXPENSE_CATEGORY_ID);
  const summary = budget ? publicSummary(budget) : null;
  return { fiscalYear: rfa.FISCAL_YEAR, categoryName: category?.CATEGORY_NAME || 'Historical category', requestedAmount: centavosToPhp(rfa.REQUESTED_AMOUNT), approvedAmount: centavosToPhp(rfa.APPROVED_AMOUNT || rfa.REQUESTED_AMOUNT), actualAmount: centavosToPhp(rfa.ACTUAL_AMOUNT), budget: summary, projectedAvailable: summary ? Number(summary.available) - centavosToPhp(rfa.APPROVED_AMOUNT || rfa.REQUESTED_AMOUNT) : null };
}

function budgetOverview(fiscalYear: string): { fiscalYear: string; departments: DepartmentRecord[]; rows: Array<Record<string, unknown>>; totals: { allocated: number; committed: number; actualSpent: number; available: number } } {
  const departments = all<DepartmentRecord>('DEPARTMENTS');
  const departmentById = new Map(departments.map((department) => [department.DEPARTMENT_ID, department]));
  const budgets = all<DepartmentBudgetRecord>('DEPARTMENT_BUDGETS').filter((budget) => String(budget.FISCAL_YEAR) === fiscalYear);
  const transactionsByBudget = new Map(budgets.map((budget) => [budget.BUDGET_ID, [] as BudgetTransactionRecord[]]));
  if (budgets.length) {
    for (const transaction of all<BudgetTransactionRecord>('BUDGET_TRANSACTIONS')) {
      if (active(transaction)) transactionsByBudget.get(transaction.BUDGET_ID)?.push(transaction);
    }
  }
  const rows = budgets.map((budget) => ({
    departmentName: departmentById.get(budget.DEPARTMENT_ID)?.DEPARTMENT_NAME || budget.DEPARTMENT_ID,
    ...publicSummary(budget, summarizeBudget(budget, transactionsByBudget.get(budget.BUDGET_ID) || []))
  }));
  const totals = rows.reduce((sum, row) => ({
    allocated: sum.allocated + Number(row.allocated), committed: sum.committed + Number(row.committed),
    actualSpent: sum.actualSpent + Number(row.actualSpent), available: sum.available + Number(row.available)
  }), { allocated: 0, committed: 0, actualSpent: 0, available: 0 });
  return { fiscalYear, departments: departments.filter((department) => toBoolean(department.ACTIVE)), rows, totals };
}

export function adminBudgetSummary(user: SessionUser, fiscalYearValue: unknown): Record<string, unknown> {
  requireCapability(user, 'IS_ADMIN');
  const { fiscalYear, rows, totals } = budgetOverview(year(fiscalYearValue));
  return { fiscalYear, rows, totals };
}

export function adminBudgetManagement(user: SessionUser, fiscalYearValue: unknown): Record<string, unknown> {
  requireCapability(user, 'IS_ADMIN');
  return budgetOverview(year(fiscalYearValue));
}

export function adminExpenseCategories(user: SessionUser): ExpenseCategoryRecord[] {
  requireCapability(user, 'IS_ADMIN');
  return all<ExpenseCategoryRecord>('EXPENSE_CATEGORIES');
}

export function adminBudgetOverview(user: SessionUser, fiscalYearValue: unknown): Record<string, unknown> {
  requireCapability(user, 'IS_ADMIN');
  return { ...budgetOverview(year(fiscalYearValue)), categories: all<ExpenseCategoryRecord>('EXPENSE_CATEGORIES') };
}

export function saveBudget(user: SessionUser, payload: Record<string, unknown>): Record<string, unknown> {
  requireCapability(user, 'IS_ADMIN'); const departmentId = String(payload.departmentId || ''); const fiscalYear = year(payload.fiscalYear);
  const department = findBy<DepartmentRecord>('DEPARTMENTS', 'DEPARTMENT_ID', departmentId); if (!department) failure('Select a valid department.');
  if (budgetFor(departmentId, fiscalYear)) failure('A budget already exists for this department and fiscal year.', 'CONFLICT');
  const amount = parseCentavos(payload.allocatedAmount, 'Allocated amount'); const timestamp = nowIso();
  const budget: DepartmentBudgetRecord = { BUDGET_ID: newId('bdg'), DEPARTMENT_ID: departmentId, FISCAL_YEAR: fiscalYear, ORIGINAL_ALLOCATED_AMOUNT: amount, ALLOW_OVER_BUDGET: toBoolean(payload.allowOverBudget), STATUS: 'ACTIVE', CREATED_BY: user.EMAIL, CREATED_AT: timestamp, UPDATED_BY: user.EMAIL, UPDATED_AT: timestamp };
  insert('DEPARTMENT_BUDGETS', budget); writeTransaction(user, budget, 'ALLOCATION', amount, 'Initial department budget allocation.');
  audit('BUDGET_CREATED', user, '', '', '', `FY ${fiscalYear} budget created for ${department.DEPARTMENT_NAME}.`, { budgetId: budget.BUDGET_ID, amountCentavos: amount }); return publicSummary(budget);
}

export function adjustBudget(user: SessionUser, payload: Record<string, unknown>): Record<string, unknown> {
  requireCapability(user, 'IS_ADMIN'); const budget = findBy<DepartmentBudgetRecord>('DEPARTMENT_BUDGETS', 'BUDGET_ID', String(payload.budgetId || '')); if (!budget) failure('Budget was not found.', 'NOT_FOUND');
  const change = parseCentavos(payload.changeAmount, 'Adjustment amount'); const direction = String(payload.direction || 'INCREASE'); const reason = String(payload.reason || '').trim(); if (reason.length < 3) failure('A reason is required for a budget adjustment.');
  const before = summarizeBudget(budget); const decrease = direction === 'DECREASE'; if (decrease && !toBoolean(budget.ALLOW_OVER_BUDGET) && before.available - change < 0) failure('This decrease would overdraw the department budget.', 'INSUFFICIENT_BUDGET');
  writeTransaction(user, budget, decrease ? 'ADJUSTMENT_DECREASE' : 'ADJUSTMENT_INCREASE', change, reason); updateBy('DEPARTMENT_BUDGETS', 'BUDGET_ID', budget.BUDGET_ID, { UPDATED_BY: user.EMAIL, UPDATED_AT: nowIso() });
  audit('BUDGET_ADJUSTED', user, '', '', '', reason, { budgetId: budget.BUDGET_ID, previousAllocationCentavos: before.allocated, changeCentavos: decrease ? -change : change }); resetPerRequestCache(); return publicSummary(budget);
}

export function setOverBudget(user: SessionUser, payload: Record<string, unknown>): void { requireCapability(user, 'IS_ADMIN'); const budget = findBy<DepartmentBudgetRecord>('DEPARTMENT_BUDGETS', 'BUDGET_ID', String(payload.budgetId || '')); if (!budget) failure('Budget was not found.', 'NOT_FOUND'); const allowed = toBoolean(payload.allowOverBudget); updateBy('DEPARTMENT_BUDGETS', 'BUDGET_ID', budget.BUDGET_ID, { ALLOW_OVER_BUDGET: allowed, UPDATED_BY: user.EMAIL, UPDATED_AT: nowIso() }); audit('BUDGET_OVERAGE_SETTING_CHANGED', user, '', '', '', allowed ? 'Over-budget requests enabled.' : 'Over-budget requests disabled.', { budgetId: budget.BUDGET_ID }); }

export function saveCategory(user: SessionUser, payload: Record<string, unknown>): Record<string, unknown> { requireCapability(user, 'IS_ADMIN'); const id = String(payload.categoryId || ''); const name = String(payload.name || '').trim(); if (name.length < 2) failure('Category name is required.'); const description = String(payload.description || '').trim(); const activeValue = payload.active === undefined ? true : toBoolean(payload.active); const timestamp = nowIso(); if (id) { const existing = findBy<ExpenseCategoryRecord>('EXPENSE_CATEGORIES', 'CATEGORY_ID', id); if (!existing) failure('Category was not found.', 'NOT_FOUND'); updateBy('EXPENSE_CATEGORIES', 'CATEGORY_ID', id, { CATEGORY_NAME: name, DESCRIPTION: description, ACTIVE: activeValue, UPDATED_BY: user.EMAIL, UPDATED_AT: timestamp }); audit('EXPENSE_CATEGORY_CHANGED', user, '', '', '', name, { categoryId: id, active: activeValue }); return { id, name, description, active: activeValue }; } const categoryId = newId('cat'); insert('EXPENSE_CATEGORIES', { CATEGORY_ID: categoryId, CATEGORY_NAME: name, DESCRIPTION: description, ACTIVE: activeValue, CREATED_BY: user.EMAIL, CREATED_AT: timestamp, UPDATED_BY: user.EMAIL, UPDATED_AT: timestamp }); audit('EXPENSE_CATEGORY_CREATED', user, '', '', '', name, { categoryId }); return { id: categoryId, name, description, active: activeValue }; }

function reportData(payload: Record<string, unknown>, loadedTransactions?: BudgetTransactionRecord[]): Record<string, unknown> {
  const fiscalYear = String(payload.fiscalYear || '').trim(); const departmentId = String(payload.departmentId || '').trim(); const categoryId = String(payload.categoryId || '').trim(); const query = String(payload.query || '').trim().toLowerCase(); const status = String(payload.status || '').trim(); const financialStatus = String(payload.financialStatus || '').trim(); const fromDate = String(payload.fromDate || '').trim(); const toDate = String(payload.toDate || '').trim();
  const categories = new Map(all<ExpenseCategoryRecord>('EXPENSE_CATEGORIES').map((item) => [item.CATEGORY_ID, item]));
  const departments = new Map(all<DepartmentRecord>('DEPARTMENTS').map((item) => [item.DEPARTMENT_ID, item]));
  const transactions = loadedTransactions ?? all<BudgetTransactionRecord>('BUDGET_TRANSACTIONS').filter(active);
  const transactionByRfa = new Map<string, { committed: number; hasCommitment: boolean; hasRelease: boolean }>();
  for (const item of transactions) {
    if (!item.RFA_ID) continue;
    const state = transactionByRfa.get(item.RFA_ID) || { committed: 0, hasCommitment: false, hasRelease: false };
    if (item.TRANSACTION_TYPE === 'COMMITMENT') { state.committed += Number(item.AMOUNT); state.hasCommitment = true; }
    if (item.TRANSACTION_TYPE === 'COMMITMENT_RELEASE') { state.committed -= Number(item.AMOUNT); state.hasRelease = true; }
    transactionByRfa.set(item.RFA_ID, state);
  }
  const rows = all<RfaRecord>('RFA').filter((rfa) => {
    if (!toBoolean(rfa.IS_BUDGET_REQUEST) || (fiscalYear && String(rfa.FISCAL_YEAR) !== fiscalYear) || (departmentId && rfa.DEPARTMENT_ID !== departmentId) || (categoryId && rfa.EXPENSE_CATEGORY_ID !== categoryId) || (status && rfa.STATUS !== status) || (fromDate && String(rfa.DATE_FILED) < fromDate) || (toDate && String(rfa.DATE_FILED) > toDate) || (query && ![rfa.RFA_NUMBER, rfa.PURPOSE, rfa.REQUEST_TITLE].join(' ').toLowerCase().includes(query))) return false;
    const state = transactionByRfa.get(rfa.RFA_ID);
    const financial = Number(rfa.ACTUAL_AMOUNT) > 0 ? 'ACTUAL_RECORDED' : state?.hasCommitment && !state.hasRelease ? 'COMMITTED' : 'UNCOMMITTED';
    return !financialStatus || financial === financialStatus;
  }).map((rfa) => { const commitmentCents = transactionByRfa.get(rfa.RFA_ID)?.committed || 0; return { rfaId: rfa.RFA_ID, rfaNumber: rfa.RFA_NUMBER, dateFiled: rfa.DATE_FILED, departmentId: rfa.DEPARTMENT_ID, department: rfa.DEPARTMENT_NAME, categoryId: rfa.EXPENSE_CATEGORY_ID, category: categories.get(rfa.EXPENSE_CATEGORY_ID)?.CATEGORY_NAME || 'Historical category', purpose: rfa.PURPOSE, requestedAmount: centavosToPhp(rfa.REQUESTED_AMOUNT), approvedAmount: centavosToPhp(rfa.APPROVED_AMOUNT || rfa.REQUESTED_AMOUNT), committedAmount: centavosToPhp(commitmentCents), actualAmount: centavosToPhp(rfa.ACTUAL_AMOUNT), financialStatus: Number(rfa.ACTUAL_AMOUNT) > 0 ? 'ACTUAL_RECORDED' : commitmentCents > 0 ? 'COMMITTED' : 'UNCOMMITTED', rfaStatus: rfa.STATUS }; });
  const matchingRfaIds = new Set(rows.map((row) => row.rfaId)); const totals = rows.reduce((sum, row) => ({ requested: sum.requested + row.requestedAmount, approved: sum.approved + row.approvedAmount, committed: sum.committed + row.committedAmount, actual: sum.actual + row.actualAmount }), { requested: 0, approved: 0, committed: 0, actual: 0 });
  const categorySummary = Array.from(rows.reduce((map, row) => { const current = map.get(row.categoryId) || { categoryId: row.categoryId, category: row.category, rfaCount: 0, committed: 0, actual: 0 }; current.rfaCount += 1; current.committed += row.committedAmount; current.actual += row.actualAmount; map.set(row.categoryId, current); return map; }, new Map<string, { categoryId: string; category: string; rfaCount: number; committed: number; actual: number }>()).values()).map((item) => ({ ...item, totalFinancialActivity: item.committed + item.actual }));
  const rfaNumberById = new Map(rows.map((row) => [row.rfaId, row.rfaNumber]));
  const history = transactions.filter((item) => (!departmentId || item.DEPARTMENT_ID === departmentId) && (!fiscalYear || String(item.FISCAL_YEAR) === fiscalYear) && (!categoryId || item.CATEGORY_ID === categoryId) && (!item.RFA_ID || matchingRfaIds.has(item.RFA_ID))).map((item) => ({ transactionId: item.TRANSACTION_ID, timestamp: item.CREATED_AT, department: departments.get(item.DEPARTMENT_ID)?.DEPARTMENT_NAME || item.DEPARTMENT_ID, fiscalYear: item.FISCAL_YEAR, type: item.TRANSACTION_TYPE, rfaId: item.RFA_ID, rfaNumber: rfaNumberById.get(item.RFA_ID) || '', category: categories.get(item.CATEGORY_ID)?.CATEGORY_NAME || '', amount: centavosToPhp(item.AMOUNT), description: item.DESCRIPTION, reference: item.REFERENCE, actor: item.CREATED_BY }));
  return { filters: { fiscalYear, departmentId, categoryId, fromDate, toDate, status, financialStatus, query }, rows, totals, categorySummary, transactions: history, departments: Array.from(departments.values()).filter((item) => toBoolean(item.ACTIVE)), categories: Array.from(categories.values()) };
}

export function budgetReport(user: SessionUser, payload: Record<string, unknown>): Record<string, unknown> { requireCapability(user, 'IS_ADMIN'); return reportData(payload); }

export function departmentFinancialDetail(user: SessionUser, payload: Record<string, unknown>): Record<string, unknown> {
  requireCapability(user, 'IS_ADMIN'); const departmentId = String(payload.departmentId || ''); const fiscalYear = year(payload.fiscalYear); if (!departmentId) failure('Select a department.'); const budget = budgetFor(departmentId, fiscalYear); const transactions = all<BudgetTransactionRecord>('BUDGET_TRANSACTIONS').filter(active); const result = reportData({ ...payload, departmentId, fiscalYear }, transactions); const adjustments = (result.transactions as Array<Record<string, unknown>>).filter((item) => String(item.type).startsWith('ADJUSTMENT_')); const budgetTransactions = transactions.filter((item) => item.BUDGET_ID === budget?.BUDGET_ID); const summary = budget ? summarizeBudget(budget, budgetTransactions) : null;
  return { ...result, budget: budget ? { ...publicSummary(budget, summary || undefined), originalAllocated: centavosToPhp(budget.ORIGINAL_ALLOCATED_AMOUNT), adjustments: centavosToPhp((summary?.allocated || 0) - Number(budget.ORIGINAL_ALLOCATED_AMOUNT)), effectiveBudget: centavosToPhp(summary?.allocated || 0) } : null, adjustments };
}
