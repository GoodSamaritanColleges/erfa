import { APP_VERSION } from './constants';
import { timed } from './performance';
import { authenticate, requireCapability } from './auth';
import { adminData, saveDepartment, saveMatrix, saveUser } from './admin';
import { adjustBudget, adminBudgetManagement, adminBudgetOverview, adminBudgetSummary, adminExpenseCategories, budgetReport, departmentFinancialDetail, requesterBudgetContext, saveBudget, saveCategory, setOverBudget } from './budget';
import { getDatabase, resetPerRequestCache } from './store';
import { resetWorkflowCache } from './workflow';
import { createRfa, dashboardRfas, decideRfa, detailRfa, downloadAttachment, eligibleApprovers, listForApproval, listRfas, saveActualExpense, submitRfa, transitionCloseout, updateRfa, uploadAttachment } from './workflow';

export interface ApiRequest { action: string; idToken?: string; payload?: Record<string, unknown>; performance?: boolean }

export function dispatch(request: ApiRequest): unknown {
  return timed('dispatchMs', () => dispatchRequest(request));
}

function dispatchRequest(request: ApiRequest): unknown {
  resetPerRequestCache();
  resetWorkflowCache();
  if (request.action === 'health') return { version: APP_VERSION, status: 'ok', timestamp: new Date().toISOString() };
  const user = timed('authenticationMs', () => authenticate(String(request.idToken ?? '')));
  const payload = request.payload ?? {};
  return timed('handlerMs', () => {
  switch (request.action) {
    case 'session': return { user, version: APP_VERSION };
    case 'dashboard.rfas': return dashboardRfas(user);
    case 'rfa.list': return listRfas(user, payload);
    case 'rfa.forApproval': return listForApproval(user);
    case 'rfa.detail': return detailRfa(user, String(payload.rfaId ?? ''));
    case 'rfa.eligibleApprovers': return eligibleApprovers(user);
    case 'budget.context': return requesterBudgetContext(user, payload.fiscalYear);
    case 'rfa.create': return withLock(() => createRfa(user, payload));
    case 'rfa.update': return withLock(() => updateRfa(user, payload));
    case 'rfa.submit': return withLock(() => submitRfa(user, String(payload.rfaId ?? ''), false));
    case 'rfa.resubmit': return withLock(() => submitRfa(user, String(payload.rfaId ?? ''), true));
    case 'rfa.approve': return withLock(() => decideRfa(user, String(payload.rfaId ?? ''), 'APPROVED', String(payload.remarks ?? '')));
    case 'rfa.return': return withLock(() => decideRfa(user, String(payload.rfaId ?? ''), 'RETURNED', String(payload.remarks ?? '')));
    case 'rfa.disapprove': return withLock(() => decideRfa(user, String(payload.rfaId ?? ''), 'DISAPPROVED', String(payload.remarks ?? '')));
    case 'rfa.implementation': return withLock(() => transitionCloseout(user, String(payload.rfaId ?? ''), 'IMPLEMENTATION'));
    case 'rfa.close': return withLock(() => transitionCloseout(user, String(payload.rfaId ?? ''), 'CLOSED'));
    case 'rfa.cancel': return withLock(() => transitionCloseout(user, String(payload.rfaId ?? ''), 'CANCELLED'));
    case 'rfa.actualExpense': return withLock(() => saveActualExpense(user, String(payload.rfaId ?? ''), payload));
    case 'attachment.upload': return withLock(() => uploadAttachment(user, payload));
    case 'attachment.download': return downloadAttachment(user, String(payload.attachmentId ?? ''));
    case 'admin.data': return adminData(user);
    case 'admin.user.save': return withLock(() => saveUser(user, payload));
    case 'admin.department.save': return withLock(() => saveDepartment(user, payload));
    case 'admin.matrix.save': return withLock(() => saveMatrix(user, payload));
    case 'admin.budget.overview': return adminBudgetOverview(user, payload.fiscalYear);
    case 'admin.budget.management': return adminBudgetManagement(user, payload.fiscalYear);
    case 'admin.budget.summary': return adminBudgetSummary(user, payload.fiscalYear);
    case 'admin.budget.save': return withLock(() => saveBudget(user, payload));
    case 'admin.budget.adjust': return withLock(() => adjustBudget(user, payload));
    case 'admin.budget.overBudget': return withLock(() => setOverBudget(user, payload));
    case 'admin.category.save': return withLock(() => saveCategory(user, payload));
    case 'admin.category.list': return adminExpenseCategories(user);
    case 'admin.budget.report': return budgetReport(user, payload);
    case 'admin.budget.detail': return departmentFinancialDetail(user, payload);
    case 'admin.database': requireCapability(user, 'IS_ADMIN'); return { spreadsheetId: getDatabase().getId(), spreadsheetUrl: getDatabase().getUrl() };
    default: throw Object.assign(new Error('Unknown API action.'), { code: 'NOT_FOUND' });
  }
  });
}

function withLock<T>(operation: () => T): T {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw Object.assign(new Error('The system is busy. Please try again.'), { code: 'CONFLICT' });
  try { return operation(); } finally { lock.releaseLock(); }
}
