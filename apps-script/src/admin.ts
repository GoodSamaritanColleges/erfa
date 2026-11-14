import { audit } from './audit';
import { normalizeEmail, parsePresidentThresholdCents, toBoolean } from './core';
import { requireCapability } from './auth';
import { all, allTail, findBy, getDatabase, getSetting, insert, newId, nowIso, resetPerRequestCache, setSetting, updateBy } from './store';
import type { ApprovalStep, DepartmentHeadRecord, DepartmentRecord, MatrixRecord, RfaRecord, SessionUser, SheetRecord, UserRecord } from './types';
import { APPROVAL_STEPS, SHEETS } from './constants';
import { loadRoles, saveRoles } from './roles';

function required(value: unknown, label: string): string {
  const clean = String(value ?? '').trim();
  if (!clean) throw new Error(`${label} is required.`);
  return clean;
}

export function adminData(user: SessionUser): Record<string, unknown> {
  requireCapability(user, 'IS_ADMIN');
  // Use tail read for large audit/log sheets — reads only last 500 rows instead of full scan
  let heads: DepartmentHeadRecord[] = [];
  try { heads = all<DepartmentHeadRecord>('DEPARTMENT_HEADS'); } catch { heads = []; }
  return {
    users: all<UserRecord>('USERS'), departments: all<DepartmentRecord>('DEPARTMENTS'), matrix: all<MatrixRecord>('APPROVAL_MATRIX'), heads,
    roles: loadRoles(),
    settings: {
      presidentThresholdPhp: getSetting('PRESIDENT_THRESHOLD_PHP') || '50000',
      reviewedMandatoryUserId: getSetting('REVIEWED_MANDATORY_USER_ID') || '',
      approvedMandatoryUserIds: getSetting('APPROVED_MANDATORY_USER_IDS') || '',
      vpAcademicUserId: getSetting('VP_ACADEMIC_USER_ID') || '',
      presidentUserId: getSetting('PRESIDENT_USER_ID') || '',
      principalUserId: getSetting('PRINCIPAL_USER_ID') || '',
      procurementUserId: getSetting('PROCUREMENT_USER_ID') || ''
    },
    audit: allTail<SheetRecord>('RFA_AUDIT', 500).reverse(), notifications: allTail<SheetRecord>('NOTIFICATIONS', 500).reverse()
  };
}

export function saveDepartmentHead(actor: SessionUser, payload: Record<string, unknown>): DepartmentHeadRecord {
  requireCapability(actor, 'IS_ADMIN');
  const departmentId = required(payload.departmentId, 'Department');
  const userId = required(payload.userId, 'User');
  const department = findBy<DepartmentRecord>('DEPARTMENTS', 'DEPARTMENT_ID', departmentId);
  if (!department || !toBoolean(department.ACTIVE)) throw new Error('Department is missing or inactive.');
  const target = findBy<UserRecord>('USERS', 'USER_ID', userId);
  if (!target || !toBoolean(target.ACTIVE) || !toBoolean(target.CAN_APPROVE_RFA)) throw new Error('Department head must be an active user with approval permission.');
  const timestamp = nowIso();
  const existing = all<DepartmentHeadRecord>('DEPARTMENT_HEADS').find((r) => r.DEPARTMENT_ID === departmentId && String(r.USER_ID) === userId);
  if (existing) {
    updateBy('DEPARTMENT_HEADS', 'HEAD_ID', String(existing.HEAD_ID), { ACTIVE: true, UPDATED_AT: timestamp });
    audit('DEPARTMENT_HEAD_CHANGED', actor, '', '', '', `${department.DEPARTMENT_NAME} head`, { departmentId, userId });
    return { ...existing, ACTIVE: true, UPDATED_AT: timestamp } as DepartmentHeadRecord;
  }
  const record = { HEAD_ID: newId('head'), DEPARTMENT_ID: departmentId, USER_ID: userId, ACTIVE: true, CREATED_AT: timestamp, UPDATED_AT: timestamp } as DepartmentHeadRecord;
  insert('DEPARTMENT_HEADS', record);
  audit('DEPARTMENT_HEAD_CHANGED', actor, '', '', '', `${department.DEPARTMENT_NAME} head`, { departmentId, userId });
  return record;
}

export function removeDepartmentHead(actor: SessionUser, payload: Record<string, unknown>): void {
  requireCapability(actor, 'IS_ADMIN');
  const headId = required(payload.headId, 'Head');
  const existing = findBy<DepartmentHeadRecord>('DEPARTMENT_HEADS', 'HEAD_ID', headId);
  if (!existing) throw new Error('Department head was not found.');
  updateBy('DEPARTMENT_HEADS', 'HEAD_ID', headId, { ACTIVE: false, UPDATED_AT: nowIso() });
  audit('DEPARTMENT_HEAD_CHANGED', actor, '', '', '', 'head deactivated', { headId });
}

/** Save the full list of approval roles (title, person, stage, when it applies, email order, access, on/off). */
export function saveApprovalRoles(actor: SessionUser, payload: Record<string, unknown>): Record<string, unknown> {
  requireCapability(actor, 'IS_ADMIN');
  const usersById = new Map(all<UserRecord>('USERS').map((u) => [u.USER_ID, u]));
  const roles = saveRoles(payload.roles, usersById);
  audit('APPROVAL_ROLES_CHANGED', actor, '', '', '', `${roles.length} approval roles saved`, { roles: roles.map((r) => ({ id: r.ROLE_ID, title: r.TITLE, userId: r.USER_ID, stage: r.STAGE, condition: r.CONDITION, active: r.ACTIVE })) });
  return adminData(actor);
}

export function saveApprovalSettings(actor: SessionUser, payload: Record<string, unknown>): Record<string, unknown> {
  requireCapability(actor, 'IS_ADMIN');
  const thresholdRaw = String(payload.presidentThresholdPhp ?? '').trim();
  if (thresholdRaw) {
    // Validate via core parser (throws on invalid)
    parsePresidentThresholdCents(thresholdRaw);
    setSetting('PRESIDENT_THRESHOLD_PHP', String(Number(thresholdRaw.replace(/,/g, ''))), 'Presidential approval threshold in PHP (inclusive)');
  }
  // Roles are now saved with admin.roles.save. Only touch the older role settings when a caller
  // still sends them, so saving the threshold alone can never clear anyone's role.
  const roleFields = ['reviewedMandatoryUserId', 'approvedMandatoryUserIds', 'vpAcademicUserId', 'presidentUserId', 'principalUserId', 'procurementUserId'];
  if (!roleFields.some((field) => Object.prototype.hasOwnProperty.call(payload, field))) {
    audit('APPROVAL_SETTINGS_CHANGED', actor, '', '', '', 'threshold updated', { thresholdPhp: thresholdRaw });
    return adminData(actor);
  }
  // Each official role is a fixed function; the person is whoever is selected here.
  // APPROVED_MANDATORY_USER_IDS is positional: [0] AVP for Finance (emailed first), [1] VP for Admin and Finance.
  const approvedIds = String(payload.approvedMandatoryUserIds ?? '').split(',').map((s) => s.trim());
  const presidentId = String(payload.presidentUserId || '').trim();
  const approvedRoleHolders = [approvedIds[0], approvedIds[1], presidentId].filter(Boolean);
  if (new Set(approvedRoleHolders).size !== approvedRoleHolders.length) throw new Error('One person cannot hold two Approved By roles. Choose a different person for AVP for Finance, VP for Admin and Finance, and President.');
  const setters: Array<[string, string, string]> = [
    ['REVIEWED_MANDATORY_USER_ID', String(payload.reviewedMandatoryUserId || ''), 'Role: Reviewed and Noted By (mandatory) - user ID'],
    ['APPROVED_MANDATORY_USER_IDS', approvedIds.some(Boolean) ? approvedIds.join(',') : '', 'Roles: Approved By - AVP for Finance (first), VP for Admin and Finance (second) - user IDs, in this order'],
    ['VP_ACADEMIC_USER_ID', String(payload.vpAcademicUserId || ''), 'Role: VP for Academic Affairs - user ID'],
    ['PRESIDENT_USER_ID', presidentId, 'Role: President - user ID'],
    ['PRINCIPAL_USER_ID', String(payload.principalUserId || ''), 'Role: JHS/SHS Principal - user ID'],
    ['PROCUREMENT_USER_ID', String(payload.procurementUserId || ''), 'Role: Procurement - user ID']
  ];
  for (const [key, value, description] of setters) {
    const trimmed = value.trim();
    if (trimmed) {
      // Validate each ID refers to an active approver (comma list for mandatory approved)
      for (const id of trimmed.split(',').map((s) => s.trim()).filter(Boolean)) {
        const target = findBy<UserRecord>('USERS', 'USER_ID', id);
        if (!target || !toBoolean(target.ACTIVE) || !toBoolean(target.CAN_APPROVE_RFA)) throw new Error(`Configured approver ${id} must be an active user with approval permission.`);
      }
    }
    setSetting(key, trimmed, description);
  }
  // Keep the older email settings in step with whoever now holds those roles, so nothing
  // keeps pointing at a previous person.
  const emailOf = (id: string) => (id ? normalizeEmail(String(findBy<UserRecord>('USERS', 'USER_ID', id)?.EMAIL || '')) : '');
  if (emailOf(approvedIds[1] || '')) setSetting('VP_ADMIN_FINANCE_EMAIL', emailOf(approvedIds[1] || ''), 'Email of the VP for Admin and Finance role (follows Approval settings)');
  if (emailOf(presidentId)) setSetting('PRESIDENT_EMAIL', emailOf(presidentId), 'Email of the President role (follows Approval settings)');
  audit('APPROVAL_SETTINGS_CHANGED', actor, '', '', '', 'approval settings updated', { reviewed: String(payload.reviewedMandatoryUserId || ''), approved: approvedIds.join(','), vpAcademic: String(payload.vpAcademicUserId || ''), president: presidentId, principal: String(payload.principalUserId || '') });
  return adminData(actor);
}

function deleteSheetRows(sheetName: keyof typeof SHEETS, keep: (row: SheetRecord) => boolean): number {
  const sheet = getDatabase().getSheetByName(sheetName);
  if (!sheet) return 0;
  const headers = [...SHEETS[sheetName]] as string[];
  if (sheet.getLastRow() < 2) return 0;
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues();
  let deleted = 0;
  for (let i = values.length - 1; i >= 0; i -= 1) {
    const row: SheetRecord = {};
    headers.forEach((h, idx) => { row[h] = values[i][idx] as string; });
    if (!keep(row)) { sheet.deleteRow(i + 2); deleted += 1; }
  }
  if (deleted) resetPerRequestCache(); // rows moved: drop this request's copies
  return deleted;
}

/** Wipe imported users/departments/heads, keep admins + approval rules + RFAs/audit. */
export function cleanImportedData(actor: SessionUser, payload: Record<string, unknown>): Record<string, unknown> {
  requireCapability(actor, 'IS_ADMIN');
  if (String(payload.confirm || '').trim().toUpperCase() !== 'DELETE') throw new Error('Type DELETE to confirm cleaning. This deletes non-admin users, departments and heads (keeps Approval Matrix, Settings, RFAs and audit).');
  const adminEmails = new Set(all<UserRecord>('USERS').filter((u) => toBoolean(u.IS_ADMIN)).map((u) => normalizeEmail(u.EMAIL)));
  adminEmails.add(normalizeEmail(actor.EMAIL));
  const usersDeleted = deleteSheetRows('USERS', (row) => adminEmails.has(normalizeEmail(row.EMAIL)) || toBoolean(row.IS_ADMIN));
  const headsDeleted = (() => { try { return deleteSheetRows('DEPARTMENT_HEADS', () => false); } catch { return 0; } })();
  const departmentsDeleted = deleteSheetRows('DEPARTMENTS', () => false);
  audit('IMPORT_CLEANED', actor, '', '', '', `users=${usersDeleted} departments=${departmentsDeleted} heads=${headsDeleted}`, { usersDeleted, departmentsDeleted, headsDeleted });
  return { usersDeleted, departmentsDeleted, headsDeleted, message: `Cleaned ${usersDeleted} users, ${departmentsDeleted} departments, ${headsDeleted} heads. Approval rules kept.` };
}

export function saveUser(actor: SessionUser, payload: Record<string, unknown>): UserRecord {
  requireCapability(actor, 'IS_ADMIN');
  const timestamp = nowIso();
  const id = String(payload.userId ?? '');
  const email = normalizeEmail(required(payload.email, 'Email'));
  const duplicate = all<UserRecord>('USERS').find((user) => normalizeEmail(user.EMAIL) === email && user.USER_ID !== id);
  if (duplicate) throw new Error('A user with this email already exists.');
  const departmentId = String(payload.departmentId ?? '');
  if (departmentId && !findBy<DepartmentRecord>('DEPARTMENTS', 'DEPARTMENT_ID', departmentId)) throw new Error('Selected department does not exist.');
  const values = {
    FULL_NAME: required(payload.fullName, 'Full Name'), EMAIL: email, DEPARTMENT_ID: departmentId,
    POSITION: String(payload.position ?? '').trim(), CAN_CREATE_RFA: toBoolean(payload.canCreateRfa),
    CAN_APPROVE_RFA: toBoolean(payload.canApproveRfa), CAN_IMPLEMENT_RFA: toBoolean(payload.canImplementRfa), IS_ADMIN: toBoolean(payload.isAdmin), ACTIVE: payload.active === undefined ? true : toBoolean(payload.active), UPDATED_AT: timestamp
  };
  if (id) {
    const existing = findBy<UserRecord>('USERS', 'USER_ID', id);
    if (!existing) throw new Error('User was not found.');
    if (existing.USER_ID === actor.USER_ID && !values.ACTIVE) throw new Error('You cannot deactivate your own account.');
    updateBy('USERS', 'USER_ID', id, values);
    audit(values.ACTIVE ? 'USER_UPDATED' : 'USER_DEACTIVATED', actor, '', '', '', values.FULL_NAME, { userId: id });
    return { ...existing, ...values } as UserRecord;
  }
  const record = { USER_ID: newId('usr'), ...values, CREATED_AT: timestamp } as UserRecord;
  insert('USERS', record);
  audit('USER_CREATED', actor, '', '', '', record.FULL_NAME, { userId: record.USER_ID });
  return record;
}

export function saveDepartment(actor: SessionUser, payload: Record<string, unknown>): DepartmentRecord {
  requireCapability(actor, 'IS_ADMIN');
  const timestamp = nowIso();
  const id = String(payload.departmentId ?? '');
  const name = required(payload.departmentName, 'Department Name');
  const code = required(payload.departmentCode, 'Department Code').toUpperCase();
  const duplicate = all<DepartmentRecord>('DEPARTMENTS').find((department) => (department.DEPARTMENT_NAME.toLowerCase() === name.toLowerCase() || department.DEPARTMENT_CODE.toUpperCase() === code) && department.DEPARTMENT_ID !== id);
  if (duplicate) throw new Error('A department with this name or code already exists.');
  const headUserId = String(payload.departmentHeadUserId ?? '').trim();
  if (headUserId) {
    const head = findBy<UserRecord>('USERS', 'USER_ID', headUserId);
    if (!head || !toBoolean(head.ACTIVE) || !toBoolean(head.CAN_APPROVE_RFA)) throw new Error('Department head must be an active user with approval permission.');
  }
  const values = { DEPARTMENT_NAME: name, DEPARTMENT_CODE: code, ACTIVE: payload.active === undefined ? true : toBoolean(payload.active), DEPARTMENT_HEAD_USER_ID: headUserId, IS_ACADEMIC: payload.isAcademic === undefined ? false : toBoolean(payload.isAcademic), UPDATED_AT: timestamp };
  if (id) {
    const existing = findBy<DepartmentRecord>('DEPARTMENTS', 'DEPARTMENT_ID', id);
    if (!existing) throw new Error('Department was not found.');
    updateBy('DEPARTMENTS', 'DEPARTMENT_ID', id, values);
    audit('DEPARTMENT_UPDATED', actor, '', '', '', name, { departmentId: id });
    return { ...existing, ...values } as DepartmentRecord;
  }
  const record = { DEPARTMENT_ID: newId('dep'), ...values, CREATED_AT: timestamp } as DepartmentRecord;
  insert('DEPARTMENTS', record);
  audit('DEPARTMENT_CREATED', actor, '', '', '', name, { departmentId: record.DEPARTMENT_ID });
  return record;
}

/**
 * Turn off Approval Matrix rows whose department or approver no longer exists (left over after
 * a data clean-up). They could never route anything; switching them off keeps the matrix simple.
 * Rows are kept (inactive) for history, never deleted.
 */
export function turnOffLeftoverMatrixRows(actor: SessionUser): Record<string, unknown> {
  requireCapability(actor, 'IS_ADMIN');
  const departmentIds = new Set(all<DepartmentRecord>('DEPARTMENTS').map((d) => String(d.DEPARTMENT_ID)));
  const userIds = new Set(all<UserRecord>('USERS').map((u) => String(u.USER_ID)));
  const leftovers = all<MatrixRecord>('APPROVAL_MATRIX').filter((row) => toBoolean(row.ACTIVE) && (!departmentIds.has(String(row.DEPARTMENT_ID)) || !userIds.has(String(row.APPROVER_USER_ID))));
  const timestamp = nowIso();
  for (const row of leftovers) updateBy('APPROVAL_MATRIX', 'MATRIX_ID', String(row.MATRIX_ID), { ACTIVE: false, UPDATED_AT: timestamp });
  if (leftovers.length) audit('MATRIX_LEFTOVERS_TURNED_OFF', actor, '', '', '', `${leftovers.length} leftover matrix rows turned off`, { matrixIds: leftovers.map((row) => row.MATRIX_ID) });
  return { ...adminData(actor), turnedOff: leftovers.length };
}

export function saveMatrix(actor: SessionUser, payload: Record<string, unknown>): MatrixRecord {
  requireCapability(actor, 'IS_ADMIN');
  const timestamp = nowIso();
  const id = String(payload.matrixId ?? '');
  const departmentId = required(payload.departmentId, 'Department');
  const approverUserId = required(payload.approverUserId, 'Approver');
  const step = required(payload.approvalStep, 'Approval Step') as ApprovalStep;
  const allowed: ApprovalStep[] = ['RECOMMENDING_APPROVAL', 'REVIEWED_AND_NOTED', 'APPROVED_BY', 'REVIEWED_BY', 'NOTED_BY', 'INVOLVED_DEPARTMENT_HEAD'];
  if (!APPROVAL_STEPS.includes(step) || !allowed.includes(step)) throw new Error('Approval Step must be Recommending Approval, Reviewed and Noted By, Approved By, or a legacy step.');
  const department = findBy<DepartmentRecord>('DEPARTMENTS', 'DEPARTMENT_ID', departmentId);
  const approver = findBy<UserRecord>('USERS', 'USER_ID', approverUserId);
  if (!department || !toBoolean(department.ACTIVE)) throw new Error('Department is missing or inactive.');
  if (!approver || !toBoolean(approver.ACTIVE) || !toBoolean(approver.CAN_APPROVE_RFA)) throw new Error('Approver must be an active user with approval permission.');
  const values = {
    DEPARTMENT_ID: departmentId, APPROVAL_STEP: step, APPROVER_USER_ID: approverUserId,
    SEQUENCE: Math.max(1, Number(payload.sequence ?? 1)), REQUIRED: payload.required === undefined ? true : toBoolean(payload.required),
    ACTIVE: payload.active === undefined ? true : toBoolean(payload.active), UPDATED_AT: timestamp
  };
  if (id) {
    const existing = findBy<MatrixRecord>('APPROVAL_MATRIX', 'MATRIX_ID', id);
    if (!existing) throw new Error('Approval matrix entry was not found.');
    updateBy('APPROVAL_MATRIX', 'MATRIX_ID', id, values);
    audit('APPROVAL_MATRIX_CHANGED', actor, '', '', '', step, { matrixId: id });
    return { ...existing, ...values } as MatrixRecord;
  }
  const record = { MATRIX_ID: newId('mat'), ...values, CREATED_AT: timestamp } as MatrixRecord;
  insert('APPROVAL_MATRIX', record);
  audit('APPROVAL_MATRIX_CHANGED', actor, '', '', '', step, { matrixId: record.MATRIX_ID });
  return record;
}

export interface AuditFilters {
  fromDate: string; toDate: string; rfaNumber: string; requester: string;
  requestingDepartmentId: string; involvedDepartmentId: string; approver: string;
  stage: string; status: string; expenseClassification: string; minAmount: string; maxAmount: string; action: string;
}

export function normalizeAuditFilters(payload: Record<string, unknown>): AuditFilters {
  return {
    fromDate: String(payload.fromDate || ''), toDate: String(payload.toDate || ''),
    rfaNumber: String(payload.rfaNumber || '').trim().toLowerCase(),
    requester: String(payload.requester || '').trim().toLowerCase(),
    requestingDepartmentId: String(payload.requestingDepartmentId || payload.departmentId || '').trim(),
    involvedDepartmentId: String(payload.involvedDepartmentId || '').trim(),
    approver: String(payload.approver || '').trim().toLowerCase(),
    stage: String(payload.stage || payload.approvalStep || '').trim(),
    status: String(payload.status || '').trim(),
    expenseClassification: String(payload.expenseClassification || '').trim().toUpperCase(),
    minAmount: String(payload.minAmount || ''), maxAmount: String(payload.maxAmount || ''),
    action: String(payload.action || '').trim()
  };
}

/**
 * Recent Audit with multi-field filtering. Joins audit rows to RFA + approval
 * rows so filters retain who/what/when/RFA. Retains actor, action, timestamps, RFA.
 */
export function adminAudit(user: SessionUser, payload: Record<string, unknown> = {}): Record<string, unknown> {
  requireCapability(user, 'IS_ADMIN');
  const filters = normalizeAuditFilters(payload);
  const rfaById = new Map(all<RfaRecord>('RFA').map((rfa) => [rfa.RFA_ID, rfa]));
  const approvals = all<SheetRecord>('RFA_APPROVALS');
  const approvalsByRfa = new Map<string, SheetRecord[]>();
  for (const row of approvals) {
    const list = approvalsByRfa.get(String(row.RFA_ID)) || [];
    list.push(row);
    approvalsByRfa.set(String(row.RFA_ID), list);
  }
  const minCents = filters.minAmount === '' ? null : Number(String(filters.minAmount).replace(/,/g, '')) * 100;
  const maxCents = filters.maxAmount === '' ? null : Number(String(filters.maxAmount).replace(/,/g, '')) * 100;
  if ((minCents !== null && (!Number.isFinite(minCents) || minCents < 0)) || (maxCents !== null && (!Number.isFinite(maxCents) || maxCents < 0))) {
    throw new Error('Amount range must be a valid non-negative amount.');
  }
  const rows = allTail<SheetRecord>('RFA_AUDIT', 2000).reverse().flatMap((entry) => {
    const rfaId = String(entry.RFA_ID || '');
    const rfa = rfaId ? rfaById.get(rfaId) : undefined;
    const timestamp = String(entry.TIMESTAMP || '');
    const stageFromMeta = (() => {
      try {
        const meta = String(entry.METADATA_JSON || '');
        if (!meta) return '';
        const parsed = JSON.parse(meta) as Record<string, unknown>;
        return String(parsed.step || parsed.section || '');
      } catch { return ''; }
    })();
    const rfaApprovals = rfaId ? approvalsByRfa.get(rfaId) || [] : [];
    const stage = stageFromMeta || rfaApprovals.find((row) => String(row.APPROVER_EMAIL || '').toLowerCase() === String(entry.ACTOR_EMAIL || '').toLowerCase())?.STEP as string || '';
    if (filters.fromDate && timestamp.slice(0, 10) < filters.fromDate) return [];
    if (filters.toDate && timestamp.slice(0, 10) > filters.toDate) return [];
    if (filters.action && String(entry.ACTION) !== filters.action) return [];
    if (filters.rfaNumber && !(rfa && String(rfa.RFA_NUMBER).toLowerCase().includes(filters.rfaNumber))) return [];
    if (filters.requester && !(rfa && String(rfa.REQUESTED_BY).toLowerCase().includes(filters.requester))) return [];
    if (filters.requestingDepartmentId && !(rfa && rfa.DEPARTMENT_ID === filters.requestingDepartmentId)) return [];
    if (filters.involvedDepartmentId && !(rfa && String(rfa.INVOLVED_DEPARTMENT_ID || '') === filters.involvedDepartmentId)) return [];
    if (filters.status && !(rfa && rfa.STATUS === filters.status) && String(entry.NEW_STATUS || '') !== filters.status) return [];
    if (filters.expenseClassification && !(rfa && String(rfa.EXPENSE_CLASSIFICATION || '').toUpperCase() === filters.expenseClassification)) return [];
    if (filters.approver) {
      const actorMatch = String(entry.ACTOR_NAME || '').toLowerCase().includes(filters.approver) || String(entry.ACTOR_EMAIL || '').toLowerCase().includes(filters.approver);
      const approvalMatch = rfaApprovals.some((row) => String(row.APPROVER_NAME || '').toLowerCase().includes(filters.approver) || String(row.APPROVER_EMAIL || '').toLowerCase().includes(filters.approver));
      if (!actorMatch && !approvalMatch) return [];
    }
    if (filters.stage) {
      const hasStage = stage === filters.stage || rfaApprovals.some((row) => String(row.STEP) === filters.stage);
      if (!hasStage) return [];
    }
    if (minCents !== null || maxCents !== null) {
      const cents = Number(rfa?.REQUESTED_AMOUNT || 0);
      if (minCents !== null && cents < minCents) return [];
      if (maxCents !== null && cents > maxCents) return [];
    }
    return [{
      logId: String(entry.LOG_ID), rfaId, rfaNumber: rfa?.RFA_NUMBER || '', actorName: String(entry.ACTOR_NAME), actorEmail: String(entry.ACTOR_EMAIL),
      action: String(entry.ACTION), previousStatus: String(entry.PREVIOUS_STATUS || ''), newStatus: String(entry.NEW_STATUS || ''),
      remarks: String(entry.REMARKS || ''), timestamp,
      requester: rfa?.REQUESTED_BY || '', requestingDepartment: rfa?.DEPARTMENT_NAME || '', requestingDepartmentId: rfa?.DEPARTMENT_ID || '',
      involvedDepartment: rfa?.INVOLVED_DEPARTMENT_NAME || '', involvedDepartmentId: String(rfa?.INVOLVED_DEPARTMENT_ID || ''),
      approverName: String(entry.ACTOR_NAME || ''), stage, rfaStatus: rfa?.STATUS || String(entry.NEW_STATUS || ''),
      expenseClassification: String(rfa?.EXPENSE_CLASSIFICATION || ''), amount: rfa ? Number(rfa.REQUESTED_AMOUNT) / 100 : 0,
      fiscalYear: String(rfa?.FISCAL_YEAR || '')
    }];
  });
  return { filters, rows };
}
