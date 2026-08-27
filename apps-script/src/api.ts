import { APP_VERSION } from './constants';
import { authenticate, requireCapability } from './auth';
import { adminData, saveDepartment, saveMatrix, saveUser } from './admin';
import { getDatabase, resetPerRequestCache } from './store';
import { resetWorkflowCache } from './workflow';
import { createRfa, decideRfa, detailRfa, downloadAttachment, listForApproval, listRfas, submitRfa, transitionCloseout, updateRfa, uploadAttachment } from './workflow';

export interface ApiRequest { action: string; idToken?: string; payload?: Record<string, unknown> }

export function dispatch(request: ApiRequest): unknown {
  resetPerRequestCache();
  resetWorkflowCache();
  if (request.action === 'health') return { version: APP_VERSION, status: 'ok', timestamp: new Date().toISOString() };
  const user = authenticate(String(request.idToken ?? ''));
  const payload = request.payload ?? {};
  switch (request.action) {
    case 'session': return { user, version: APP_VERSION };
    case 'rfa.list': return listRfas(user, payload);
    case 'rfa.forApproval': return listForApproval(user);
    case 'rfa.detail': return detailRfa(user, String(payload.rfaId ?? ''));
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
    case 'attachment.upload': return withLock(() => uploadAttachment(user, payload));
    case 'attachment.download': return downloadAttachment(user, String(payload.attachmentId ?? ''));
    case 'admin.data': return adminData(user);
    case 'admin.user.save': return withLock(() => saveUser(user, payload));
    case 'admin.department.save': return withLock(() => saveDepartment(user, payload));
    case 'admin.matrix.save': return withLock(() => saveMatrix(user, payload));
    case 'admin.database': requireCapability(user, 'IS_ADMIN'); return { spreadsheetId: getDatabase().getId(), spreadsheetUrl: getDatabase().getUrl() };
    default: throw Object.assign(new Error('Unknown API action.'), { code: 'NOT_FOUND' });
  }
}

function withLock<T>(operation: () => T): T {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw Object.assign(new Error('The system is busy. Please try again.'), { code: 'CONFLICT' });
  try { return operation(); } finally { lock.releaseLock(); }
}

