import { audit } from './audit';
import { normalizeEmail, toBoolean } from './core';
import { requireCapability } from './auth';
import { all, insert, newId, nowIso, updateBy } from './store';
import type { DepartmentRecord, SessionUser, SheetRecord, UserRecord } from './types';

function emailIsValid(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export interface ImportDepartmentInput {
  departmentName: string;
  departmentCode: string;
  isAcademic?: boolean;
  active?: boolean;
}

export interface ImportUserInput {
  fullName: string;
  email: string;
  departmentCode?: string;
  departmentName?: string;
  position?: string;
  canCreateRfa?: boolean;
  canApproveRfa?: boolean;
  canImplementRfa?: boolean;
  active?: boolean;
}

export interface ImportHeadInput {
  departmentCode: string;
  userEmail: string;
}

/**
 * Admin import. Departments are insert-only; users are matched by email and
 * their department + designation (POSITION) are overwritten to match the file.
 * Capabilities/active are only updated when explicitly provided in the payload.
 * Never deletes. Missing/invalid emails are skipped for later manual entry.
 */
export function importUsersFromList(actor: SessionUser, payload: Record<string, unknown>): Record<string, unknown> {
  requireCapability(actor, 'IS_ADMIN');
  const departmentsIn = Array.isArray(payload.departments) ? payload.departments as ImportDepartmentInput[] : [];
  const usersIn = Array.isArray(payload.users) ? payload.users as ImportUserInput[] : [];
  const headsIn = Array.isArray(payload.heads) ? payload.heads as ImportHeadInput[] : [];
  if (!departmentsIn.length && !usersIn.length) throw new Error('Import payload must contain departments or users.');

  const deptByCode = new Map<string, DepartmentRecord>();
  const deptByName = new Map<string, DepartmentRecord>();
  for (const d of all<DepartmentRecord>('DEPARTMENTS')) {
    deptByCode.set(String(d.DEPARTMENT_CODE || '').toUpperCase(), d);
    deptByName.set(String(d.DEPARTMENT_NAME || '').toLowerCase(), d);
  }
  const createdDepartments: string[] = [];
  const skippedDepartments: string[] = [];
  const deptIdForCode = new Map<string, string>();

  for (const raw of departmentsIn) {
    const name = String(raw.departmentName || '').trim();
    const code = String(raw.departmentCode || '').trim().toUpperCase();
    if (!name || !code) { skippedDepartments.push(name || code || '(blank)'); continue; }
    const existing = deptByCode.get(code) || deptByName.get(name.toLowerCase());
    if (existing) {
      deptIdForCode.set(code, existing.DEPARTMENT_ID);
      skippedDepartments.push(code);
      continue;
    }
    const timestamp = nowIso();
    const record: DepartmentRecord = {
      DEPARTMENT_ID: newId('dep'), DEPARTMENT_NAME: name, DEPARTMENT_CODE: code,
      ACTIVE: raw.active === undefined ? true : toBoolean(raw.active),
      CREATED_AT: timestamp, UPDATED_AT: timestamp, DEPARTMENT_HEAD_USER_ID: '',
      IS_ACADEMIC: toBoolean(raw.isAcademic)
    } as DepartmentRecord;
    insert('DEPARTMENTS', record);
    createdDepartments.push(code);
    deptByCode.set(code, record);
    deptIdForCode.set(code, record.DEPARTMENT_ID);
  }
  // Resolve payload departments that existed via name only
  for (const d of all<DepartmentRecord>('DEPARTMENTS')) {
    deptByCode.set(String(d.DEPARTMENT_CODE || '').toUpperCase(), d);
  }

  const usersByEmail = new Map(all<UserRecord>('USERS').map((u) => [normalizeEmail(u.EMAIL), u]));
  const createdUsers: string[] = [];
  const skippedUsers: Array<{ email: string; reason: string }> = [];
  const userIdByEmail = new Map<string, string>();

  const updatedUsers: string[] = [];
  for (const raw of usersIn) {
    const fullName = String(raw.fullName || '').trim();
    const email = normalizeEmail(raw.email || '');
    if (!fullName) { skippedUsers.push({ email: email || '(blank)', reason: 'missing name' }); continue; }
    if (!emailIsValid(email)) { skippedUsers.push({ email: email || fullName, reason: 'missing/invalid email — add later in Users' }); continue; }
    if (usersByEmail.has(email)) {
      const existing = usersByEmail.get(email)!;
      userIdByEmail.set(email, existing.USER_ID);
      // OVERWRITE department + designation (POSITION) from file; keep USER_ID/history
      const code = String(raw.departmentCode || '').trim().toUpperCase();
      const deptName = String(raw.departmentName || '').trim().toLowerCase();
      const dept = (code && deptByCode.get(code)) || deptByName.get(deptName);
      const updates: SheetRecord = { UPDATED_AT: nowIso() };
      if (dept) updates.DEPARTMENT_ID = dept.DEPARTMENT_ID;
      if (String(raw.position || '').trim()) updates.POSITION = String(raw.position || '').trim();
      if (raw.canCreateRfa !== undefined) updates.CAN_CREATE_RFA = toBoolean(raw.canCreateRfa);
      if (raw.canApproveRfa !== undefined) updates.CAN_APPROVE_RFA = toBoolean(raw.canApproveRfa);
      if (Object.keys(updates).length > 1) {
        try { updateBy('USERS', 'USER_ID', existing.USER_ID, updates); updatedUsers.push(email); } catch { skippedUsers.push({ email, reason: 'update failed' }); }
      } else {
        updatedUsers.push(email);
      }
      continue;
    }
    let departmentId = '';
    const code = String(raw.departmentCode || '').trim().toUpperCase();
    const deptName = String(raw.departmentName || '').trim().toLowerCase();
    const dept = (code && deptByCode.get(code)) || deptByName.get(deptName);
    if (dept) departmentId = dept.DEPARTMENT_ID;
    const timestamp = nowIso();
    const record = {
      USER_ID: newId('usr'), FULL_NAME: fullName, EMAIL: email, DEPARTMENT_ID: departmentId,
      POSITION: String(raw.position || '').trim(),
      CAN_CREATE_RFA: raw.canCreateRfa === undefined ? true : toBoolean(raw.canCreateRfa),
      CAN_APPROVE_RFA: toBoolean(raw.canApproveRfa),
      CAN_IMPLEMENT_RFA: toBoolean(raw.canImplementRfa),
      IS_ADMIN: false, ACTIVE: raw.active === undefined ? true : toBoolean(raw.active),
      CREATED_AT: timestamp, UPDATED_AT: timestamp
    } as UserRecord;
    insert('USERS', record);
    createdUsers.push(email);
    usersByEmail.set(email, record);
    userIdByEmail.set(email, record.USER_ID);
  }

  const createdHeads: string[] = [];
  const skippedHeads: Array<{ key: string; reason: string }> = [];
  const existingHeads = all<SheetRecord>('DEPARTMENT_HEADS');
  for (const raw of headsIn) {
    const code = String(raw.departmentCode || '').trim().toUpperCase();
    const email = normalizeEmail(raw.userEmail || '');
    const dept = deptByCode.get(code);
    if (!dept) { skippedHeads.push({ key: `${code}/${email}`, reason: 'department not found' }); continue; }
    // Include users just created
    const fresh = all<UserRecord>('USERS').find((u) => normalizeEmail(u.EMAIL) === email);
    const userId = userIdByEmail.get(email) || fresh?.USER_ID || usersByEmail.get(email)?.USER_ID;
    if (!userId) { skippedHeads.push({ key: `${code}/${email}`, reason: 'user not found (missing email?)' }); continue; }
    const exists = existingHeads.some((h) => String(h.DEPARTMENT_ID) === dept.DEPARTMENT_ID && String(h.USER_ID) === userId && toBoolean(h.ACTIVE));
    if (exists) { skippedHeads.push({ key: `${code}/${email}`, reason: 'already a head' }); continue; }
    insert('DEPARTMENT_HEADS', { HEAD_ID: newId('head'), DEPARTMENT_ID: dept.DEPARTMENT_ID, USER_ID: userId, ACTIVE: true, CREATED_AT: nowIso(), UPDATED_AT: nowIso() });
    createdHeads.push(`${code}/${email}`);
  }

  audit('USERS_IMPORTED', actor, '', '', '', `departments=${createdDepartments.length} users=${createdUsers.length} updated=${updatedUsers.length} heads=${createdHeads.length}`, {
    createdDepartments, createdUsers, updatedUsers, createdHeads, skippedUsers, skippedHeads
  } as unknown as Record<string, unknown>);
  return {
    createdDepartments, skippedDepartments, createdUsers, updatedUsers, skippedUsers, createdHeads, skippedHeads,
    summary: `Departments created ${createdDepartments.length} (skipped ${skippedDepartments.length}); Users created ${createdUsers.length} updated ${updatedUsers.length} (skipped ${skippedUsers.length}); Heads created ${createdHeads.length} (skipped ${skippedHeads.length})`
  };
}
