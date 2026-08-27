import { audit } from './audit';
import { normalizeEmail, toBoolean } from './core';
import { requireCapability } from './auth';
import { all, allTail, findBy, insert, newId, nowIso, updateBy } from './store';
import type { ApprovalStep, DepartmentRecord, MatrixRecord, SessionUser, SheetRecord, UserRecord } from './types';
import { APPROVAL_STEPS } from './constants';

function required(value: unknown, label: string): string {
  const clean = String(value ?? '').trim();
  if (!clean) throw new Error(`${label} is required.`);
  return clean;
}

export function adminData(user: SessionUser): Record<string, unknown> {
  requireCapability(user, 'IS_ADMIN');
  // Use tail read for large audit/log sheets — reads only last 500 rows instead of full scan
  return {
    users: all<UserRecord>('USERS'), departments: all<DepartmentRecord>('DEPARTMENTS'), matrix: all<MatrixRecord>('APPROVAL_MATRIX'),
    audit: allTail<SheetRecord>('RFA_AUDIT', 500).reverse(), notifications: allTail<SheetRecord>('NOTIFICATIONS', 500).reverse()
  };
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
    CAN_APPROVE_RFA: toBoolean(payload.canApproveRfa), IS_ADMIN: toBoolean(payload.isAdmin), ACTIVE: payload.active === undefined ? true : toBoolean(payload.active), UPDATED_AT: timestamp
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
  const values = { DEPARTMENT_NAME: name, DEPARTMENT_CODE: code, ACTIVE: payload.active === undefined ? true : toBoolean(payload.active), UPDATED_AT: timestamp };
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

export function saveMatrix(actor: SessionUser, payload: Record<string, unknown>): MatrixRecord {
  requireCapability(actor, 'IS_ADMIN');
  const timestamp = nowIso();
  const id = String(payload.matrixId ?? '');
  const departmentId = required(payload.departmentId, 'Department');
  const approverUserId = required(payload.approverUserId, 'Approver');
  const step = required(payload.approvalStep, 'Approval Step') as ApprovalStep;
  if (!APPROVAL_STEPS.includes(step) || step === 'PREPARED_BY') throw new Error('Approval Step must be Recommending Approval, Reviewed and Noted, or Approved By.');
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

