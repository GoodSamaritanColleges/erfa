import { audit } from './audit';
import { requireCapability } from './auth';
import { centavosToPhp, parseCentavos, toBoolean } from './core';
import { all, findBy, insert, newId, nowIso, resetPerRequestCache, updateBy } from './store';
import type { BudgetTransactionRecord, DepartmentBudgetRecord, DepartmentRecord, ExpenseCategoryRecord, RfaRecord, SessionUser } from './types';

export type ExpenseClassification = 'OPEX' | 'CAPEX';

export function parseExpenseClassification(value: unknown): ExpenseClassification | '' {
  const clean = String(value ?? '').trim().toUpperCase();
  if (!clean) return '';
  if (clean !== 'OPEX' && clean !== 'CAPEX') failure('Expense Classification must be OPEX or CAPEX.', 'INVALID_OPERATION');
  return clean as ExpenseClassification;
}

type Summary = { allocated: number; committed: number; actualSpent: number; available: number; utilization: number };
type PublicSummary = Summary & { budgetId: string; departmentId: string; fiscalYear: string; allowOverBudget: boolean; status: string; used: number };
const active = (transaction: BudgetTransactionRecord) => transaction.STATUS !== 'VOID';

function failure(message: string, code = 'INVALID_OPERATION'): never { const error = new Error(message) as Error & { code?: string }; error.code = code; throw error; }
function year(value: unknown, defaultToCurrentYear = true): string {
  const supplied = String(value ?? '').trim();
  const result = supplied || (defaultToCurrentYear ? String(new Date().getFullYear()) : '');
  if (!/^\d{4}$/.test(result)) failure('Fiscal year must be a four-digit year.');
  return result;
}
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
    allocated: centavosToPhp(summary.allocated), committed: centavosToPhp(summary.committed), actualSpent: centavosToPhp(summary.actualSpent), used: centavosToPhp(summary.committed + summary.actualSpent), available: centavosToPhp(summary.available), utilization: summary.utilization };
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
  return { fiscalYear, departmentId: user.DEPARTMENT_ID, departmentName: user.DEPARTMENT_NAME, budget: budget ? publicSummary(budget) : null };
}

export function financialRfaFields(user: SessionUser, payload: Record<string, unknown>, required: boolean): Record<string, string | number | boolean> {
  const isFinancial = toBoolean(payload.isBudgetRequest);
  if (!isFinancial) return { IS_BUDGET_REQUEST: false, EXPENSE_CATEGORY_ID: '', REQUESTED_AMOUNT: 0, APPROVED_AMOUNT: 0, ACTUAL_AMOUNT: 0, FISCAL_YEAR: '', ACTUAL_EXPENSE_RECORDED_AT: '', EXPENSE_CLASSIFICATION: '', INVOLVED_DEPARTMENT_ID: '', INVOLVED_DEPARTMENT_NAME: '', PURCHASE_REQUEST: false, RECOMMENDING_ALTERNATE_USER_ID: '', RECOMMENDING_ALTERNATE_NAME: '', INCLUDE_PRINCIPAL: false, INCLUDE_PROCUREMENT: false, INVOLVED_DEPARTMENT_IDS: '' };
  // Fiscal year remains required for an expense-monitoring RFA but no longer
  // requires a pre-configured department budget (budget-allocation model removed).
  const fiscalYear = year(payload.fiscalYear, required ? false : true);
  const categoryId = String(payload.expenseCategoryId || '').trim();
  const amount = parseCentavos(payload.requestedAmount, 'Requested amount');
  if (categoryId && !findBy<ExpenseCategoryRecord>('EXPENSE_CATEGORIES', 'CATEGORY_ID', categoryId)) failure('The historical expense category was not found.', 'INVALID_CATEGORY');
  const expenseClassification = parseExpenseClassification(payload.expenseClassification);
  // Preserve backward compatibility for historical RFAs without classification.
  // New RFAs are validated for OPEX/CAPEX in workflow.create/update (which require it).
  const involvedDepartmentId = String(payload.involvedDepartmentId || '').trim();
  const involvedDepartmentName = String(payload.involvedDepartmentName || '').trim();
  const involvedDepartmentIds = String(payload.involvedDepartmentIds || '').trim() || (involvedDepartmentId ? involvedDepartmentId : '');
  return { IS_BUDGET_REQUEST: true, EXPENSE_CATEGORY_ID: categoryId, REQUESTED_AMOUNT: amount, APPROVED_AMOUNT: 0, ACTUAL_AMOUNT: 0, FISCAL_YEAR: fiscalYear, ACTUAL_EXPENSE_RECORDED_AT: '', EXPENSE_CLASSIFICATION: expenseClassification, INVOLVED_DEPARTMENT_ID: involvedDepartmentId, INVOLVED_DEPARTMENT_NAME: involvedDepartmentName, PURCHASE_REQUEST: toBoolean(payload.purchaseRequest), RECOMMENDING_ALTERNATE_USER_ID: String(payload.recommendingAlternateUserId || '').trim(), RECOMMENDING_ALTERNATE_NAME: String(payload.recommendingAlternateName || '').trim(), INCLUDE_PRINCIPAL: toBoolean(payload.includePrincipal), INCLUDE_PROCUREMENT: toBoolean(payload.includeProcurement), INVOLVED_DEPARTMENT_IDS: involvedDepartmentIds };
}

/**
 * Budget-deduction is intentionally disabled in the expense-monitoring model.
 * Final approval no longer creates a BUDGET_TRANSACTIONS COMMITMENT, requires a
 * configured department budget, or checks an available balance. Historical
 * COMMITMENT / ACTUAL rows remain readable via summarizeBudget() and the
 * legacy report helpers; no data is deleted.
 */
export function commitApprovedFinancialRfa(rfa: RfaRecord, actor: SessionUser): Record<string, string | number> | null {
  void rfa; void actor;
  // No transaction is written. The workflow layer sets APPROVED_AMOUNT =
  // REQUESTED_AMOUNT at completion so expense monitoring can report it.
  return null;
}

export function recordActualExpense(user: SessionUser, rfa: RfaRecord, payload: Record<string, unknown>): Record<string, unknown> {
  // Manual actual-expense ledger entry is part of the removed budget-control flow.
  // The expense-monitoring model reports the recorded RFA amount directly.
  failure('Actual expense recording is not available in the expense-monitoring model.');
  void payload; void user; void rfa;
  return {};
}

export function financialDetail(rfa: RfaRecord): Record<string, unknown> | null {
  if (!toBoolean(rfa.IS_BUDGET_REQUEST)) return null;
  // Legacy budget context is preserved read-only for historical RFAs; new
  // expense-monitoring RFAs report no remaining-budget balance.
  const budget = budgetFor(rfa.DEPARTMENT_ID, String(rfa.FISCAL_YEAR));
  const category = rfa.EXPENSE_CATEGORY_ID ? findBy<ExpenseCategoryRecord>('EXPENSE_CATEGORIES', 'CATEGORY_ID', rfa.EXPENSE_CATEGORY_ID) : null;
  const summary = budget ? publicSummary(budget) : null;
  return { fiscalYear: rfa.FISCAL_YEAR, categoryName: category?.CATEGORY_NAME || '', requestedAmount: centavosToPhp(rfa.REQUESTED_AMOUNT), approvedAmount: centavosToPhp(rfa.APPROVED_AMOUNT || rfa.REQUESTED_AMOUNT), actualAmount: centavosToPhp(rfa.ACTUAL_AMOUNT), budget: summary, projectedAvailable: summary ? Number(summary.available) : null, expenseClassification: String(rfa.EXPENSE_CLASSIFICATION || ''), involvedDepartmentId: String(rfa.INVOLVED_DEPARTMENT_ID || ''), involvedDepartmentName: String(rfa.INVOLVED_DEPARTMENT_NAME || ''), purchaseRequest: toBoolean(rfa.PURCHASE_REQUEST), recommendingAlternateUserId: String(rfa.RECOMMENDING_ALTERNATE_USER_ID || ''), recommendingAlternateName: String(rfa.RECOMMENDING_ALTERNATE_NAME || ''), includePrincipal: toBoolean(rfa.INCLUDE_PRINCIPAL), includeProcurement: toBoolean(rfa.INCLUDE_PROCUREMENT), involvedDepartmentIds: String(rfa.INVOLVED_DEPARTMENT_IDS || '') };
}

function budgetOverview(fiscalYear: string): { fiscalYear: string; departments: DepartmentRecord[]; rows: Array<Record<string, unknown>>; totals: { allocated: number; committed: number; actualSpent: number; available: number; used: number } } {
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
  return { fiscalYear, departments: departments.filter((department) => toBoolean(department.ACTIVE)), rows, totals: { ...totals, used: totals.committed + totals.actualSpent } };
}

/** One pass over each authoritative source; commitments created on final
 * approval represent new expenses, while legacy release/actual pairs count
 * only their actual amount. Neither implementation nor close adds a row.
 */
export function departmentExpenseReport(user: SessionUser, payload: Record<string, unknown>): Record<string, unknown> {
  requireCapability(user, 'IS_ADMIN');
  const fiscalYear = year(payload.fiscalYear);
  const departmentId = String(payload.departmentId || '');
  const query = String(payload.query || '').trim().toLowerCase();
  const fromDate = String(payload.fromDate || '');
  const toDate = String(payload.toDate || '');
  const departments = all<DepartmentRecord>('DEPARTMENTS').filter((item) => toBoolean(item.ACTIVE));
  const budgets = all<DepartmentBudgetRecord>('DEPARTMENT_BUDGETS').filter((item) => String(item.FISCAL_YEAR) === fiscalYear && (!departmentId || item.DEPARTMENT_ID === departmentId) && item.STATUS !== 'INACTIVE');
  if (!budgets.length) return { fiscalYear, departments, annualBudget: 0, used: 0, remaining: 0, rows: [] };
  const byBudget = new Map(budgets.map((budget) => [budget.BUDGET_ID, [] as BudgetTransactionRecord[]]));
  for (const transaction of all<BudgetTransactionRecord>('BUDGET_TRANSACTIONS')) {
    if (active(transaction)) byBudget.get(transaction.BUDGET_ID)?.push(transaction);
  }
  const annualBudget = budgets.reduce((total, budget) => total + summarizeBudget(budget, byBudget.get(budget.BUDGET_ID)).allocated, 0);
  const expenses = new Map<string, { transaction: BudgetTransactionRecord; amount: number; released: boolean }>();
  for (const budget of budgets) for (const transaction of byBudget.get(budget.BUDGET_ID) || []) {
    if (!transaction.RFA_ID) continue;
    const entry = expenses.get(transaction.RFA_ID);
    if (transaction.TRANSACTION_TYPE === 'COMMITMENT' && !entry) expenses.set(transaction.RFA_ID, { transaction, amount: Number(transaction.AMOUNT), released: false });
    if (transaction.TRANSACTION_TYPE === 'COMMITMENT_RELEASE' && entry) { entry.released = true; entry.amount = 0; }
    if (transaction.TRANSACTION_TYPE === 'ACTUAL_EXPENSE') {
      if (entry) entry.amount = Number(transaction.AMOUNT);
      else expenses.set(transaction.RFA_ID, { transaction, amount: Number(transaction.AMOUNT), released: true });
    }
    if (transaction.TRANSACTION_TYPE === 'REVERSAL' && entry) entry.amount -= Number(transaction.AMOUNT);
  }
  const used = budgets.reduce((total, budget) => {
    const summary = summarizeBudget(budget, byBudget.get(budget.BUDGET_ID));
    return total + summary.committed + summary.actualSpent;
  }, 0);
  const rfaById = new Map(all<RfaRecord>('RFA').map((rfa) => [rfa.RFA_ID, rfa]));
  const rows = [...expenses.entries()].flatMap(([rfaId, entry]) => {
    const rfa = rfaById.get(rfaId);
    const dateApproved = String(entry.transaction.CREATED_AT || '').slice(0, 10);
    if (!rfa || (entry.released && entry.amount <= 0) || (fromDate && dateApproved < fromDate) || (toDate && dateApproved > toDate) ||
      (query && ![rfa.RFA_NUMBER, rfa.REQUEST_TITLE, rfa.PURPOSE, rfa.REQUESTED_BY].join(' ').toLowerCase().includes(query))) return [];
    return [{ rfaId, rfaNumber: rfa.RFA_NUMBER, dateApproved, requester: rfa.REQUESTED_BY, department: rfa.DEPARTMENT_NAME,
      title: rfa.REQUEST_TITLE, purpose: rfa.PURPOSE, amount: centavosToPhp(entry.amount), status: rfa.STATUS }];
  }).sort((a, b) => b.dateApproved.localeCompare(a.dateApproved));
  return { fiscalYear, departments, annualBudget: centavosToPhp(annualBudget), used: centavosToPhp(used), remaining: centavosToPhp(annualBudget - used), rows };
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

/** Expense-monitoring aggregation helpers (no budget subtraction). */

export interface ExpenseMonitoringFilters {
  fiscalYear: string;
  departmentId: string;
  expenseClassification: string;
  status: string;
  fromDate: string;
  toDate: string;
  query: string;
}

export function normalizeExpenseMonitoringFilters(payload: Record<string, unknown>): ExpenseMonitoringFilters {
  const rawFy = String(payload.fiscalYear ?? '').trim();
  const fiscalYear = rawFy === '' ? String(new Date().getFullYear()) : year(rawFy, false);
  const expenseClassification = String(payload.expenseClassification ?? payload.classification ?? '').trim().toUpperCase();
  if (expenseClassification && expenseClassification !== 'OPEX' && expenseClassification !== 'CAPEX') failure('Expense Classification must be OPEX or CAPEX.');
  return {
    fiscalYear,
    departmentId: String(payload.departmentId || '').trim(),
    expenseClassification,
    status: String(payload.status || '').trim(),
    fromDate: String(payload.fromDate || '').trim(),
    toDate: String(payload.toDate || '').trim(),
    query: String(payload.query || '').trim().toLowerCase()
  };
}

/**
 * Group recorded RFA amounts by requesting (reporting) department.
 * Each RFA is attributed once to DEPARTMENT_ID (requesting department) —
 * involved department is preserved as a separate field and never double-counted.
 * Total Department Expenses = Total OPEX + Total CAPEX. No budget subtraction.
 * By default (no explicit status) only recorded expenses are counted
 * (APPROVED / IMPLEMENTATION / CLOSED). An explicit status filter respects that status.
 */
export function aggregateDepartmentExpenses(rfas: RfaRecord[], filters: ExpenseMonitoringFilters): { deptRows: Array<Record<string, unknown>>; detailRows: Array<Record<string, unknown>>; totals: Record<string, number> } {
  const recordedStatuses = new Set(['APPROVED', 'IMPLEMENTATION', 'CLOSED']);
  const filtered = rfas.filter((rfa) => {
    if (!toBoolean(rfa.IS_BUDGET_REQUEST)) return false;
    if (filters.fiscalYear && String(rfa.FISCAL_YEAR) !== filters.fiscalYear) return false;
    if (filters.departmentId && rfa.DEPARTMENT_ID !== filters.departmentId) return false;
    if (filters.expenseClassification && String(rfa.EXPENSE_CLASSIFICATION || '').toUpperCase() !== filters.expenseClassification) return false;
    if (filters.status ? rfa.STATUS !== filters.status : !recordedStatuses.has(rfa.STATUS)) return false;
    const dateValue = String(rfa.DATE_FILED || rfa.CREATED_AT || '').slice(0, 10);
    if (filters.fromDate && dateValue < filters.fromDate) return false;
    if (filters.toDate && dateValue > filters.toDate) return false;
    if (filters.query && ![rfa.RFA_NUMBER, rfa.REQUEST_TITLE, rfa.PURPOSE, rfa.REQUESTED_BY, rfa.DEPARTMENT_NAME, rfa.INVOLVED_DEPARTMENT_NAME].join(' ').toLowerCase().includes(filters.query)) return false;
    return true;
  });
  const byDept = new Map<string, { departmentId: string; departmentName: string; fiscalYear: string; opexCents: number; capexCents: number; count: number }>();
  const detailRows: Array<Record<string, unknown>> = [];
  for (const rfa of filtered) {
    const cents = Number(rfa.APPROVED_AMOUNT || 0) > 0 ? Number(rfa.APPROVED_AMOUNT) : Number(rfa.REQUESTED_AMOUNT || 0);
    const classification = String(rfa.EXPENSE_CLASSIFICATION || '').toUpperCase();
    const key = rfa.DEPARTMENT_ID || rfa.DEPARTMENT_NAME;
    const current = byDept.get(key) || { departmentId: rfa.DEPARTMENT_ID, departmentName: rfa.DEPARTMENT_NAME, fiscalYear: String(rfa.FISCAL_YEAR), opexCents: 0, capexCents: 0, count: 0 };
    if (classification === 'OPEX') current.opexCents += cents;
    else if (classification === 'CAPEX') current.capexCents += cents;
    else current.opexCents += cents; // legacy RFAs without classification count under OPEX total? preserve amount in total; classification breakdown leaves them in OPEX? Instead keep total but flag as OPEX for backward compat; committed to OPEX bucket to avoid dropping totals.
    current.count += 1;
    byDept.set(key, current);
    detailRows.push({
      rfaId: rfa.RFA_ID, rfaNumber: rfa.RFA_NUMBER, dateFiled: rfa.DATE_FILED, departmentId: rfa.DEPARTMENT_ID,
      department: rfa.DEPARTMENT_NAME, involvedDepartmentId: rfa.INVOLVED_DEPARTMENT_ID || '', involvedDepartment: rfa.INVOLVED_DEPARTMENT_NAME || '',
      title: rfa.REQUEST_TITLE, purpose: rfa.PURPOSE, requester: rfa.REQUESTED_BY,
      expenseClassification: classification, amount: centavosToPhp(cents), requestedAmount: centavosToPhp(rfa.REQUESTED_AMOUNT),
      fiscalYear: String(rfa.FISCAL_YEAR), status: rfa.STATUS
    });
  }
  const deptRows = Array.from(byDept.values()).map((row) => ({
    departmentId: row.departmentId, departmentName: row.departmentName, fiscalYear: row.fiscalYear,
    totalOpex: centavosToPhp(row.opexCents), totalCapex: centavosToPhp(row.capexCents),
    total: centavosToPhp(row.opexCents + row.capexCents), rfaCount: row.count
  })).sort((a, b) => String(a.departmentName).localeCompare(String(b.departmentName)));
  // For legacy RFAs without classification, present OPEX cell as the amount and CAPEX 0 but totals reflect sum; modern RFAs keep strict split.
  // Recompute strictly for modern rows to avoid misclassifying legacy totals in tests: legacy rows already folded into OPEX above.
  const totals = deptRows.reduce((sum, row) => ({ totalOpex: sum.totalOpex + Number(row.totalOpex), totalCapex: sum.totalCapex + Number(row.totalCapex), total: sum.total + Number(row.total), rfaCount: sum.rfaCount + Number(row.rfaCount) }), { totalOpex: 0, totalCapex: 0, total: 0, rfaCount: 0 });
  detailRows.sort((a, b) => String(b.dateFiled).localeCompare(String(a.dateFiled)));
  return { deptRows, detailRows, totals };
}

export function expenseMonitoringReport(user: SessionUser, payload: Record<string, unknown> = {}): Record<string, unknown> {
  requireCapability(user, 'IS_ADMIN');
  const filters = normalizeExpenseMonitoringFilters(payload);
  const departments = all<DepartmentRecord>('DEPARTMENTS').filter((item) => toBoolean(item.ACTIVE));
  const { deptRows, detailRows, totals } = aggregateDepartmentExpenses(all<RfaRecord>('RFA'), filters);
  return { fiscalYear: filters.fiscalYear, filters, departments, deptRows, rows: detailRows, totals };
}
