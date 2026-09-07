import { ALLOWED_ATTACHMENT_TYPES, APPROVAL_SECTIONS, ASSIGNMENT_WORKFLOW_MARKER, STEP_STATUS } from './constants';
import { audit } from './audit';
import { formatRfaNumber, nextAssignedSection, nextAssignedStageAfterAction, normalizeEmail, orderedMatrix, selectNextApprover, toBoolean, validateRfaInput } from './core';
import { notify } from './notifications';
import { all, clearPendingRfaAssignments, findBy, getAssignmentsBySection, getSetting, insert, newId, nowIso, saveRfaSectionAssignments, setSetting, updateBy } from './store';
import type { ApprovalSection, DepartmentRecord, EligibleApprover, MatrixRecord, RfaRecord, RfaSectionAssignments, SessionUser, SheetRecord, UserRecord } from './types';

function businessError(message: string, code = 'INVALID_OPERATION'): never {
  const error = new Error(message) as Error & { code?: string };
  error.code = code;
  throw error;
}

function isAssignmentWorkflow(rfa: RfaRecord): boolean {
  return rfa.CURRENT_MATRIX_ID === ASSIGNMENT_WORKFLOW_MARKER;
}

function currentAssignmentSection(rfa: RfaRecord): ApprovalSection | null {
  return APPROVAL_SECTIONS.includes(rfa.CURRENT_STEP as ApprovalSection) ? rfa.CURRENT_STEP as ApprovalSection : null;
}

function getApprovedAssignments(rfa: RfaRecord, section: ApprovalSection): SheetRecord[] {
  const submittedAt = Date.parse(String(rfa.SUBMITTED_AT || ''));
  return approvalRows(rfa.RFA_ID).filter((row) => row.STEP === section && row.ACTION === 'APPROVED' && (!Number.isFinite(submittedAt) || Date.parse(String(row.TIMESTAMP || '')) >= submittedAt));
}

function getRfa(id: string): RfaRecord {
  const record = findBy<RfaRecord>('RFA', 'RFA_ID', id);
  if (!record) businessError('RFA was not found.', 'NOT_FOUND');
  return record;
}

function approvalRows(rfaId: string): SheetRecord[] {
  return all<SheetRecord>('RFA_APPROVALS').filter((row) => row.RFA_ID === rfaId);
}

function attachmentRows(rfaId: string): SheetRecord[] {
  return all<SheetRecord>('RFA_ATTACHMENTS').filter((row) => row.RFA_ID === rfaId);
}

function auditRows(rfaId: string): SheetRecord[] {
  return all<SheetRecord>('RFA_AUDIT').filter((row) => row.RFA_ID === rfaId);
}

// Execution-local Drive folder memoization
const folderCache = new Map<string, GoogleAppsScript.Drive.Folder>();
export function resetWorkflowCache(): void { folderCache.clear(); }

function canView(user: SessionUser, rfa: RfaRecord): boolean {
  if (toBoolean(user.IS_ADMIN) || normalizeEmail(rfa.REQUESTER_EMAIL) === normalizeEmail(user.EMAIL)) return true;
  if (toBoolean(user.CAN_IMPLEMENT_RFA) && ['APPROVED', 'IMPLEMENTATION'].includes(rfa.STATUS)) return true;
  if (normalizeEmail(rfa.CURRENT_APPROVER_EMAIL) === normalizeEmail(user.EMAIL)) return true;
  return approvalRows(rfa.RFA_ID).some((row) => normalizeEmail(row.APPROVER_EMAIL) === normalizeEmail(user.EMAIL));
}

/** Optimized canView that reuses preloaded approval index (avoids N+1). */
function canViewWithApproverSet(user: SessionUser, rfa: RfaRecord, approverRfaSet: Set<string>): boolean {
  if (toBoolean(user.IS_ADMIN) || normalizeEmail(rfa.REQUESTER_EMAIL) === normalizeEmail(user.EMAIL)) return true;
  if (toBoolean(user.CAN_IMPLEMENT_RFA) && ['APPROVED', 'IMPLEMENTATION'].includes(rfa.STATUS)) return true;
  if (normalizeEmail(rfa.CURRENT_APPROVER_EMAIL) === normalizeEmail(user.EMAIL)) return true;
  return approverRfaSet.has(String(rfa.RFA_ID));
}

function assertView(user: SessionUser, rfa: RfaRecord): void {
  if (!canView(user, rfa)) {
    audit('ACCESS_DENIED', user, rfa.RFA_ID, rfa.STATUS, rfa.STATUS, 'Attempted to access an unauthorized RFA.');
    businessError('You do not have access to this RFA.', 'FORBIDDEN');
  }
}

function assertOwnerEditable(user: SessionUser, rfa: RfaRecord): void {
  if (normalizeEmail(rfa.REQUESTER_EMAIL) !== normalizeEmail(user.EMAIL) && !toBoolean(user.IS_ADMIN)) businessError('Only the requester can edit this RFA.', 'FORBIDDEN');
  if (!['DRAFT', 'RETURNED'].includes(rfa.STATUS)) businessError('Only draft or returned RFAs can be edited.');
}

function nextNumber(): string {
  const year = new Date().getFullYear();
  const storedYear = Number(getSetting('LAST_RFA_YEAR') || 0);
  const sequence = storedYear === year ? Number(getSetting('LAST_RFA_SEQUENCE') || 0) + 1 : 1;
  setSetting('LAST_RFA_YEAR', String(year), 'Internal numbering state');
  setSetting('LAST_RFA_SEQUENCE', String(sequence), 'Internal numbering state');
  return formatRfaNumber(year, sequence);
}

function appendApproval(rfa: RfaRecord, step: string, actor: Pick<UserRecord, 'USER_ID' | 'FULL_NAME' | 'EMAIL'>, action: string, remarks = ''): void {
  insert('RFA_APPROVALS', {
    APPROVAL_ID: newId('apr'), RFA_ID: rfa.RFA_ID, RFA_NUMBER: rfa.RFA_NUMBER, STEP: step,
    APPROVER_USER_ID: actor.USER_ID, APPROVER_NAME: actor.FULL_NAME, APPROVER_EMAIL: actor.EMAIL,
    ACTION: action, REMARKS: remarks, TIMESTAMP: nowIso()
  });
}

function admins(): UserRecord[] {
  return all<UserRecord>('USERS').filter((user) => toBoolean(user.ACTIVE) && toBoolean(user.IS_ADMIN));
}

function routeLegacy(rfa: RfaRecord, actor: SessionUser, startIndex: number): RfaRecord {
  const matrix = all<MatrixRecord>('APPROVAL_MATRIX').filter((row) => row.DEPARTMENT_ID === rfa.DEPARTMENT_ID);
  const result = selectNextApprover(matrix, all<UserRecord>('USERS'), rfa.REQUESTER_EMAIL, startIndex);
  result.skipped.forEach((skip) => {
    const skippedUser = skip.user ?? { USER_ID: skip.matrix.APPROVER_USER_ID, FULL_NAME: 'Unknown approver', EMAIL: '' };
    appendApproval(rfa, skip.matrix.APPROVAL_STEP, skippedUser, 'SKIPPED', skip.reason);
    audit('APPROVER_SKIPPED', actor, rfa.RFA_ID, rfa.STATUS, rfa.STATUS, skip.reason, { matrixId: skip.matrix.MATRIX_ID, approverUserId: skip.matrix.APPROVER_USER_ID });
  });
  if (!result.next) {
    const updates = { STATUS: 'EXCEPTION', CURRENT_STEP: '', CURRENT_APPROVER_USER_ID: '', CURRENT_APPROVER_EMAIL: '', CURRENT_MATRIX_ID: '', UPDATED_AT: nowIso(), VERSION: Number(rfa.VERSION) + 1 };
    updateBy('RFA', 'RFA_ID', rfa.RFA_ID, updates);
    const exceptionRfa = { ...rfa, ...updates } as RfaRecord;
    appendApproval(exceptionRfa, rfa.CURRENT_STEP || 'RECOMMENDING_APPROVAL', { USER_ID: '', FULL_NAME: 'SYSTEM', EMAIL: '' }, 'EXCEPTION', 'No valid configured approver is available.');
    audit('WORKFLOW_EXCEPTION', actor, rfa.RFA_ID, rfa.STATUS, 'EXCEPTION', 'No valid configured approver is available.');
    admins().forEach((admin) => notify('WORKFLOW_EXCEPTION', admin, exceptionRfa, actor, 'No valid configured approver is available.'));
    return exceptionRfa;
  }
  const { matrix: nextMatrix, user: nextUser } = result.next;
  const updates = { STATUS: STEP_STATUS[nextMatrix.APPROVAL_STEP], CURRENT_STEP: nextMatrix.APPROVAL_STEP, CURRENT_APPROVER_USER_ID: nextUser.USER_ID, CURRENT_APPROVER_EMAIL: nextUser.EMAIL, CURRENT_MATRIX_ID: nextMatrix.MATRIX_ID, RESUME_MATRIX_ID: '', UPDATED_AT: nowIso(), VERSION: Number(rfa.VERSION) + 1 };
  updateBy('RFA', 'RFA_ID', rfa.RFA_ID, updates);
  const routed = { ...rfa, ...updates } as RfaRecord;
  audit('APPROVAL_REQUESTED', actor, rfa.RFA_ID, rfa.STATUS, routed.STATUS, '', { step: nextMatrix.APPROVAL_STEP, approver: nextUser.EMAIL });
  notify('APPROVAL_REQUIRED', nextUser, routed, actor);
  return routed;
}

function notifyAssignedStage(rfa: RfaRecord, actor: SessionUser, section: ApprovalSection): void {
  const approvedEmails = new Set(getApprovedAssignments(rfa, section).map((row) => normalizeEmail(row.APPROVER_EMAIL)));
  getAssignmentsBySection(rfa.RFA_ID, section)
    .filter((row) => !approvedEmails.has(normalizeEmail(row.APPROVER_EMAIL)))
    .forEach((row) => notify('APPROVAL_REQUIRED', { FULL_NAME: row.APPROVER_NAME, EMAIL: row.APPROVER_EMAIL } as UserRecord, rfa, actor, `This RFA is awaiting your approval action for the ${section} section.`));
}

function completeAssignedWorkflow(rfa: RfaRecord, actor: SessionUser): RfaRecord {
  const updates = { STATUS: 'APPROVED', CURRENT_STEP: 'APPROVED_BY', CURRENT_APPROVER_USER_ID: '', CURRENT_APPROVER_EMAIL: '', CURRENT_MATRIX_ID: ASSIGNMENT_WORKFLOW_MARKER, COMPLETED_AT: nowIso(), UPDATED_AT: nowIso(), VERSION: Number(rfa.VERSION) + 1 };
  updateBy('RFA', 'RFA_ID', rfa.RFA_ID, updates);
  const approved = { ...rfa, ...updates } as RfaRecord;
  audit('STATUS_CHANGED', actor, rfa.RFA_ID, rfa.STATUS, 'APPROVED', 'All assigned approval sections completed.');
  const requester = all<UserRecord>('USERS').find((candidate) => normalizeEmail(candidate.EMAIL) === normalizeEmail(rfa.REQUESTER_EMAIL));
  if (requester) notify('RFA_APPROVED', requester, approved, actor);
  return approved;
}

function routeAssigned(rfa: RfaRecord, actor: SessionUser, startIndex: number): RfaRecord {
  const assignments = approvalRows(rfa.RFA_ID).filter((row) => row.ACTION === '');
  const counts = APPROVAL_SECTIONS.reduce((allCounts, section) => ({ ...allCounts, [section]: assignments.filter((row) => row.STEP === section).length }), {} as Record<ApprovalSection, number>);
  const section = nextAssignedSection(counts, startIndex);
  if (section) {
    for (let index = startIndex; index < APPROVAL_SECTIONS.indexOf(section); index += 1) {
      audit('STAGE_SKIPPED', actor, rfa.RFA_ID, rfa.STATUS, rfa.STATUS, 'No approvers selected for this section.', { section: APPROVAL_SECTIONS[index] });
    }
    const assigned = assignments.filter((row) => row.STEP === section);
    const updates = { STATUS: STEP_STATUS[section], CURRENT_STEP: section, CURRENT_APPROVER_USER_ID: '', CURRENT_APPROVER_EMAIL: '', CURRENT_MATRIX_ID: ASSIGNMENT_WORKFLOW_MARKER, RESUME_MATRIX_ID: '', UPDATED_AT: nowIso(), VERSION: Number(rfa.VERSION) + 1 };
    updateBy('RFA', 'RFA_ID', rfa.RFA_ID, updates);
    const routed = { ...rfa, ...updates } as RfaRecord;
    audit('APPROVAL_REQUESTED', actor, rfa.RFA_ID, rfa.STATUS, routed.STATUS, '', { section, approverCount: assigned.length });
    notifyAssignedStage(routed, actor, section);
    return routed;
  }
  return completeAssignedWorkflow(rfa, actor);
}

function emptyAssignments(): RfaSectionAssignments {
  return { RECOMMENDING_APPROVAL: [], REVIEWED_BY: [], NOTED_BY: [], APPROVED_BY: [] };
}

function activeEmployeeDirectory(user: SessionUser, users = all<UserRecord>('USERS')): EligibleApprover[] {
  const departments = new Map(all<DepartmentRecord>('DEPARTMENTS').map((department) => [department.DEPARTMENT_ID, department.DEPARTMENT_NAME]));
  const requesterEmail = normalizeEmail(user.EMAIL);
  return users
    .filter((candidate) => toBoolean(candidate.ACTIVE) && toBoolean(candidate.CAN_APPROVE_RFA) && candidate.USER_ID !== user.USER_ID && normalizeEmail(candidate.EMAIL) !== requesterEmail)
    .map((candidate) => ({
      USER_ID: candidate.USER_ID,
      FULL_NAME: candidate.FULL_NAME,
      EMAIL: candidate.EMAIL,
      POSITION: candidate.POSITION,
      DEPARTMENT: departments.get(candidate.DEPARTMENT_ID) || 'Not assigned'
    }))
    .sort((left, right) => left.FULL_NAME.localeCompare(right.FULL_NAME) || left.EMAIL.localeCompare(right.EMAIL));
}

function parseAssignments(user: SessionUser, value: unknown): RfaSectionAssignments {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const users = all<UserRecord>('USERS');
  const activeEmployees = new Map(activeEmployeeDirectory(user, users).map((candidate) => [candidate.USER_ID, candidate]));
  const usersById = new Map(users.map((candidate) => [candidate.USER_ID, candidate]));
  const assignments = emptyAssignments();
  APPROVAL_SECTIONS.forEach((section) => {
    const ids = Array.isArray(source[section]) ? source[section].map((id) => String(id)) : [];
    if (new Set(ids).size !== ids.length) businessError(`Duplicate approvers are not allowed in ${section}.`);
    assignments[section] = ids.map((id) => {
      const directoryUser = usersById.get(id);
      if (!directoryUser) businessError('A selected employee no longer exists in the employee directory.', 'FORBIDDEN');
      if (!toBoolean(directoryUser.ACTIVE)) businessError('A selected employee is inactive and cannot be assigned.', 'FORBIDDEN');
      if (directoryUser.USER_ID === user.USER_ID || normalizeEmail(directoryUser.EMAIL) === normalizeEmail(user.EMAIL)) businessError('You cannot assign yourself as an approver for this RFA.', 'SELF_APPROVAL');
      if (!toBoolean(directoryUser.CAN_APPROVE_RFA)) businessError('A selected employee does not have approval capability.', 'FORBIDDEN');
      const candidate = activeEmployees.get(id);
      if (!candidate) businessError('A selected employee is not available for approval.', 'FORBIDDEN');
      return candidate;
    });
  });
  return assignments;
}

function saveAssignments(rfa: RfaRecord, assignments: RfaSectionAssignments): void {
  clearPendingRfaAssignments(rfa.RFA_ID);
  APPROVAL_SECTIONS.forEach((section) => saveRfaSectionAssignments(rfa.RFA_ID, rfa.RFA_NUMBER, section, assignments[section]));
  const persisted = approvalRows(rfa.RFA_ID).filter((row) => row.ACTION === '');
  const savedCorrectly = APPROVAL_SECTIONS.every((section) => persisted.filter((row) => row.STEP === section).length === assignments[section].length);
  if (!savedCorrectly) businessError('The approval route could not be saved. Please try again.', 'CONFLICT');
}

export function eligibleApprovers(user: SessionUser): Record<string, unknown> {
  if (!toBoolean(user.CAN_CREATE_RFA) || !user.DEPARTMENT_ID) businessError('You do not have permission to select approvers.', 'FORBIDDEN');
  return { employees: activeEmployeeDirectory(user) };
}

export function createRfa(user: SessionUser, payload: Record<string, unknown>): RfaRecord {
  if (!toBoolean(user.CAN_CREATE_RFA)) businessError('You do not have permission to create an RFA.', 'FORBIDDEN');
  if (!user.DEPARTMENT_ID) businessError('Your account does not have a department. Ask an administrator to update your profile.', 'CONFIGURATION_REQUIRED');
  const department = findBy<DepartmentRecord>('DEPARTMENTS', 'DEPARTMENT_ID', user.DEPARTMENT_ID);
  if (!department || !toBoolean(department.ACTIVE)) businessError('Your configured department is missing or inactive.', 'CONFIGURATION_REQUIRED');
  const clean = validateRfaInput(payload, false);
  const assignments = parseAssignments(user, payload.approvalAssignments);
  const timestamp = nowIso();
  const record: RfaRecord = {
    RFA_ID: newId('rfa'), RFA_NUMBER: nextNumber(), DATE_FILED: timestamp.slice(0, 10),
    DEPARTMENT_ID: department.DEPARTMENT_ID, DEPARTMENT_NAME: department.DEPARTMENT_NAME,
    REQUESTED_BY: user.FULL_NAME, REQUESTER_EMAIL: normalizeEmail(user.EMAIL), POSITION: user.POSITION,
    REQUEST_TITLE: String(clean.requestTitle), PURPOSE: String(clean.purpose), BUDGET_ALLOCATION: Number(clean.budgetAllocation),
    TARGET_DATE: String(clean.targetDate), JUSTIFICATION: String(clean.justification), STATUS: 'DRAFT', CURRENT_STEP: '',
    CURRENT_APPROVER_USER_ID: '', CURRENT_APPROVER_EMAIL: '', CURRENT_MATRIX_ID: ASSIGNMENT_WORKFLOW_MARKER, RESUME_MATRIX_ID: '',
    CREATED_AT: timestamp, UPDATED_AT: timestamp, SUBMITTED_AT: '', COMPLETED_AT: '', VERSION: 1
  };
  insert('RFA', record);
  saveAssignments(record, assignments);
  audit('RFA_CREATED', user, record.RFA_ID, '', 'DRAFT', '', { rfaNumber: record.RFA_NUMBER });
  return record;
}

export function updateRfa(user: SessionUser, payload: Record<string, unknown>): RfaRecord {
  const rfa = getRfa(String(payload.rfaId ?? ''));
  assertOwnerEditable(user, rfa);
  const clean = validateRfaInput(payload, false);
  const usesAssignments = Object.prototype.hasOwnProperty.call(payload, 'approvalAssignments');
  if (usesAssignments && !isAssignmentWorkflow(rfa)) businessError('Legacy RFAs retain their original Approval Matrix route and cannot be converted.', 'FORBIDDEN');
  const assignments = usesAssignments ? parseAssignments(user, payload.approvalAssignments) : null;
  const updates = {
    REQUEST_TITLE: clean.requestTitle, PURPOSE: clean.purpose, BUDGET_ALLOCATION: clean.budgetAllocation,
    TARGET_DATE: clean.targetDate, JUSTIFICATION: clean.justification, CURRENT_MATRIX_ID: usesAssignments ? ASSIGNMENT_WORKFLOW_MARKER : rfa.CURRENT_MATRIX_ID, UPDATED_AT: nowIso(), VERSION: Number(rfa.VERSION) + 1
  };
  updateBy('RFA', 'RFA_ID', rfa.RFA_ID, updates);
  const updated = { ...rfa, ...updates } as RfaRecord;
  if (assignments) saveAssignments(updated, assignments);
  audit('RFA_UPDATED', user, rfa.RFA_ID, rfa.STATUS, rfa.STATUS);
  return updated;
}

export function submitRfa(user: SessionUser, rfaId: string, resubmit = false): RfaRecord {
  const rfa = getRfa(rfaId);
  assertOwnerEditable(user, rfa);
  validateRfaInput({ requestTitle: rfa.REQUEST_TITLE, purpose: rfa.PURPOSE, budgetAllocation: rfa.BUDGET_ALLOCATION, targetDate: rfa.TARGET_DATE, justification: rfa.JUSTIFICATION }, true);
  if (resubmit && rfa.STATUS !== 'RETURNED') businessError('Only a returned RFA can be resubmitted.');
  if (!resubmit && rfa.STATUS !== 'DRAFT') businessError('Only a draft RFA can be submitted.');

  const previous = rfa.STATUS;
  const timestamp = nowIso();
  const updates = { STATUS: 'SUBMITTED', SUBMITTED_AT: timestamp, UPDATED_AT: timestamp, VERSION: Number(rfa.VERSION) + 1 };
  updateBy('RFA', 'RFA_ID', rfa.RFA_ID, updates);
  const submitted = { ...rfa, ...updates } as RfaRecord;

  // Append PREPARED_BY approval (only for new submissions, not resubmits)
  if (!resubmit) appendApproval(submitted, 'PREPARED_BY', user, 'APPROVED', 'Submitted electronically by requester.');

  audit(resubmit ? 'RESUBMITTED' : 'RFA_SUBMITTED', user, rfa.RFA_ID, previous, 'SUBMITTED');
  notify(resubmit ? 'RFA_RESUBMITTED' : 'RFA_SUBMITTED', user, submitted, user);

  if (isAssignmentWorkflow(submitted)) return routeAssigned(submitted, user, 0);
  const matrix = orderedMatrix(all<MatrixRecord>('APPROVAL_MATRIX').filter((row) => row.DEPARTMENT_ID === submitted.DEPARTMENT_ID));
  if (!matrix.length) businessError('No active approval matrix is configured for your department.', 'CONFIGURATION_REQUIRED');
  const resumeIndex = resubmit && rfa.RESUME_MATRIX_ID ? Math.max(0, matrix.findIndex((row) => row.MATRIX_ID === rfa.RESUME_MATRIX_ID)) : 0;
  return routeLegacy(submitted, user, resumeIndex);
}

export function decideRfa(user: SessionUser, rfaId: string, action: 'APPROVED' | 'RETURNED' | 'DISAPPROVED', remarks: string): RfaRecord {
  const rfa = getRfa(rfaId);
  if (!toBoolean(user.CAN_APPROVE_RFA)) businessError('You do not have approval permission.', 'FORBIDDEN');
  if (normalizeEmail(rfa.REQUESTER_EMAIL) === normalizeEmail(user.EMAIL)) businessError('You cannot approve, return, or disapprove your own RFA.', 'SELF_APPROVAL');
  const assignmentSection = currentAssignmentSection(rfa);
  const assigned = isAssignmentWorkflow(rfa) && assignmentSection
    ? getAssignmentsBySection(rfa.RFA_ID, assignmentSection).some((row) => String(row.APPROVER_USER_ID) === user.USER_ID)
    : normalizeEmail(rfa.CURRENT_APPROVER_EMAIL) === normalizeEmail(user.EMAIL);
  if (!assigned) businessError('This RFA is not assigned to you.', 'FORBIDDEN');
  if (isAssignmentWorkflow(rfa) && assignmentSection && getApprovedAssignments(rfa, assignmentSection).some((row) => String(row.APPROVER_USER_ID) === user.USER_ID)) businessError('You have already acted on this RFA section.', 'CONFLICT');
  if (action !== 'APPROVED' && remarks.trim().length < 3) businessError('A reason is required for return or disapproval.');
  appendApproval(rfa, rfa.CURRENT_STEP, user, action, remarks.trim());
  const previous = rfa.STATUS;

  if (action === 'RETURNED') {
    const updates = { STATUS: 'RETURNED', RESUME_MATRIX_ID: isAssignmentWorkflow(rfa) ? '' : rfa.CURRENT_MATRIX_ID, CURRENT_APPROVER_USER_ID: '', CURRENT_APPROVER_EMAIL: '', CURRENT_MATRIX_ID: isAssignmentWorkflow(rfa) ? ASSIGNMENT_WORKFLOW_MARKER : '', UPDATED_AT: nowIso(), VERSION: Number(rfa.VERSION) + 1 };
    updateBy('RFA', 'RFA_ID', rfa.RFA_ID, updates);
    const returned = { ...rfa, ...updates } as RfaRecord;
    audit('RETURNED', user, rfa.RFA_ID, previous, 'RETURNED', remarks);
    const requester = all<UserRecord>('USERS').find((candidate) => normalizeEmail(candidate.EMAIL) === normalizeEmail(rfa.REQUESTER_EMAIL));
    if (requester) notify('RFA_RETURNED', requester, returned, user, remarks);
    return returned;
  }
  if (action === 'DISAPPROVED') {
    const updates = { STATUS: 'DISAPPROVED', CURRENT_APPROVER_USER_ID: '', CURRENT_APPROVER_EMAIL: '', CURRENT_MATRIX_ID: '', COMPLETED_AT: nowIso(), UPDATED_AT: nowIso(), VERSION: Number(rfa.VERSION) + 1 };
    updateBy('RFA', 'RFA_ID', rfa.RFA_ID, updates);
    const disapproved = { ...rfa, ...updates } as RfaRecord;
    audit('DISAPPROVED', user, rfa.RFA_ID, previous, 'DISAPPROVED', remarks);
    const requester = all<UserRecord>('USERS').find((candidate) => normalizeEmail(candidate.EMAIL) === normalizeEmail(rfa.REQUESTER_EMAIL));
    if (requester) notify('RFA_DISAPPROVED', requester, disapproved, user, remarks);
    return disapproved;
  }

  audit('APPROVED', user, rfa.RFA_ID, previous, previous, remarks, { step: rfa.CURRENT_STEP });
  if (isAssignmentWorkflow(rfa) && assignmentSection) {
    const assignedCounts = APPROVAL_SECTIONS.reduce((counts, section) => ({ ...counts, [section]: getAssignmentsBySection(rfa.RFA_ID, section).length }), {} as Record<ApprovalSection, number>);
    const approvedCounts = APPROVAL_SECTIONS.reduce((counts, section) => ({ ...counts, [section]: getApprovedAssignments(rfa, section).length }), {} as Record<ApprovalSection, number>);
    const next = nextAssignedStageAfterAction(assignedCounts, approvedCounts, APPROVAL_SECTIONS.indexOf(assignmentSection));
    if (next === assignmentSection) return rfa;
    return routeAssigned(rfa, user, APPROVAL_SECTIONS.indexOf(assignmentSection) + 1);
  }
  const matrix = orderedMatrix(all<MatrixRecord>('APPROVAL_MATRIX').filter((row) => row.DEPARTMENT_ID === rfa.DEPARTMENT_ID));
  const currentIndex = matrix.findIndex((row) => row.MATRIX_ID === rfa.CURRENT_MATRIX_ID);
  if (matrix.slice(currentIndex + 1).length) return routeLegacy(rfa, user, currentIndex + 1);
  const updates = { STATUS: 'APPROVED', CURRENT_STEP: 'APPROVED_BY', CURRENT_APPROVER_USER_ID: '', CURRENT_APPROVER_EMAIL: '', CURRENT_MATRIX_ID: '', COMPLETED_AT: nowIso(), UPDATED_AT: nowIso(), VERSION: Number(rfa.VERSION) + 1 };
  updateBy('RFA', 'RFA_ID', rfa.RFA_ID, updates);
  const approved = { ...rfa, ...updates } as RfaRecord;
  audit('STATUS_CHANGED', user, rfa.RFA_ID, previous, 'APPROVED', 'Final electronic approval completed.');
  const requester = all<UserRecord>('USERS').find((candidate) => normalizeEmail(candidate.EMAIL) === normalizeEmail(rfa.REQUESTER_EMAIL));
  if (requester) notify('RFA_APPROVED', requester, approved, user);
  return approved;
}

export function transitionCloseout(user: SessionUser, rfaId: string, action: 'IMPLEMENTATION' | 'CLOSED' | 'CANCELLED'): RfaRecord {
  const rfa = getRfa(rfaId);
  const owns = normalizeEmail(rfa.REQUESTER_EMAIL) === normalizeEmail(user.EMAIL);
  const canImplement = toBoolean(user.CAN_IMPLEMENT_RFA) || toBoolean(user.IS_ADMIN);
  if (action === 'CANCELLED' ? !owns && !toBoolean(user.IS_ADMIN) : !canImplement) businessError(action === 'CANCELLED' ? 'Only the requester or an administrator can cancel this RFA.' : 'You do not have implementation permission.', 'FORBIDDEN');
  if (action === 'IMPLEMENTATION' && rfa.STATUS !== 'APPROVED') businessError('Only an approved RFA can enter implementation.');
  if (action === 'CLOSED' && !['APPROVED', 'IMPLEMENTATION'].includes(rfa.STATUS)) businessError('Only an approved or implementation-stage RFA can be closed.');
  if (action === 'CANCELLED' && !['DRAFT', 'RETURNED'].includes(rfa.STATUS)) businessError('Only a draft or returned RFA can be cancelled.');
  const previous = rfa.STATUS;
  const updates = { STATUS: action, COMPLETED_AT: action === 'CLOSED' ? nowIso() : rfa.COMPLETED_AT, UPDATED_AT: nowIso(), VERSION: Number(rfa.VERSION) + 1 };
  updateBy('RFA', 'RFA_ID', rfa.RFA_ID, updates);
  const updated = { ...rfa, ...updates } as RfaRecord;
  audit('STATUS_CHANGED', user, rfa.RFA_ID, previous, action);
  if (action === 'CLOSED') {
    const requester = all<UserRecord>('USERS').find((candidate) => normalizeEmail(candidate.EMAIL) === normalizeEmail(rfa.REQUESTER_EMAIL));
    if (requester) notify('RFA_CLOSED', requester, updated, user);
  }
  return updated;
}

export function listRfas(user: SessionUser, filters: Record<string, unknown>): RfaRecord[] {
  const query = String(filters.query ?? '').trim().toLowerCase();
  const status = String(filters.status ?? '');
  const departmentId = String(filters.departmentId ?? '');
  const currentStep = String(filters.currentStep ?? '');
  // Load once per request — eliminates N+1 approval scans inside canView
  const allApprovals = all<SheetRecord>('RFA_APPROVALS');
  const normalizedUserEmail = normalizeEmail(user.EMAIL);
  const approverRfaSet = new Set<string>();
  for (const row of allApprovals) {
    if (normalizeEmail(row.APPROVER_EMAIL) === normalizedUserEmail) approverRfaSet.add(String(row.RFA_ID));
  }
  return all<RfaRecord>('RFA').filter((rfa) => {
    if (!canViewWithApproverSet(user, rfa, approverRfaSet)) return false;
    if (status && rfa.STATUS !== status) return false;
    if (departmentId && rfa.DEPARTMENT_ID !== departmentId) return false;
    if (currentStep && rfa.CURRENT_STEP !== currentStep) return false;
    if (query && ![rfa.RFA_NUMBER, rfa.REQUEST_TITLE, rfa.REQUESTED_BY, rfa.DEPARTMENT_NAME].some((value) => String(value).toLowerCase().includes(query))) return false;
    return true;
  }).sort((a, b) => String(b.UPDATED_AT).localeCompare(String(a.UPDATED_AT)));
}

export function listForApproval(user: SessionUser): RfaRecord[] {
  if (!toBoolean(user.CAN_APPROVE_RFA)) return [];
  return all<RfaRecord>('RFA').filter((rfa) => {
    if (isAssignmentWorkflow(rfa)) {
      const section = currentAssignmentSection(rfa);
      return Boolean(section && getAssignmentsBySection(rfa.RFA_ID, section).some((row) => String(row.APPROVER_USER_ID) === user.USER_ID) && !getApprovedAssignments(rfa, section).some((row) => String(row.APPROVER_USER_ID) === user.USER_ID));
    }
    return toBoolean(user.CAN_APPROVE_RFA) && normalizeEmail(rfa.CURRENT_APPROVER_EMAIL) === normalizeEmail(user.EMAIL);
  });
}

export function detailRfa(user: SessionUser, rfaId: string): Record<string, unknown> {
  const rfa = getRfa(rfaId);
  assertView(user, rfa);
  const section = currentAssignmentSection(rfa);
  const isCurrentSectionHead = isAssignmentWorkflow(rfa) && section
    ? getAssignmentsBySection(rfa.RFA_ID, section).some((row) => String(row.APPROVER_USER_ID) === user.USER_ID) && !getApprovedAssignments(rfa, section).some((row) => String(row.APPROVER_USER_ID) === user.USER_ID)
    : normalizeEmail(rfa.CURRENT_APPROVER_EMAIL) === normalizeEmail(user.EMAIL);
  // canEdit: requester or admin, and RFA is in DRAFT or RETURNED status
  const canEdit = (normalizeEmail(rfa.REQUESTER_EMAIL) === normalizeEmail(user.EMAIL) || toBoolean(user.IS_ADMIN)) && ['DRAFT', 'RETURNED'].includes(rfa.STATUS);
  // An administrator may view any RFA but can decide only when explicitly assigned.
  const canDecide = isCurrentSectionHead && normalizeEmail(rfa.REQUESTER_EMAIL) !== normalizeEmail(user.EMAIL) && toBoolean(user.CAN_APPROVE_RFA);
  const canImplement = (toBoolean(user.CAN_IMPLEMENT_RFA) || toBoolean(user.IS_ADMIN)) && rfa.STATUS === 'APPROVED';
  const canClose = (toBoolean(user.CAN_IMPLEMENT_RFA) || toBoolean(user.IS_ADMIN)) && ['APPROVED', 'IMPLEMENTATION'].includes(rfa.STATUS);

  return {
    rfa,
    approvals: approvalRows(rfaId),
    attachments: attachmentRows(rfaId).map(({ DRIVE_FILE_ID: _hidden, ...attachment }) => attachment),
    audit: auditRows(rfaId).map(({ METADATA_JSON: _metadata, ...entry }) => entry),
    permissions: {
      canEdit,
      canDecide,
      canImplement,
      canClose
    }
  };
}

function rfaFolder(rfa: RfaRecord): GoogleAppsScript.Drive.Folder {
  const rootId = getSetting('ATTACHMENT_ROOT_FOLDER_ID');
  if (!rootId) businessError('Attachment storage is not configured. Run setupDatabase().', 'CONFIGURATION_REQUIRED');
  const cacheKey = `rfa:${rfa.RFA_NUMBER}`;
  const cached = folderCache.get(cacheKey);
  if (cached) return cached;
  const year = rfa.RFA_NUMBER.split('-')[1] || new Date().getFullYear().toString();
  const yearCacheKey = `year:${year}:${rootId}`;
  let yearFolder = folderCache.get(yearCacheKey) as GoogleAppsScript.Drive.Folder | undefined;
  let root: GoogleAppsScript.Drive.Folder | undefined;
  if (!yearFolder) {
    root = DriveApp.getFolderById(rootId);
    const yearFolders = root.getFoldersByName(year);
    yearFolder = yearFolders.hasNext() ? yearFolders.next() : root.createFolder(year);
    folderCache.set(yearCacheKey, yearFolder);
  } else {
    // Ensure yearFolder still accessible; if cached we still need rfa subfolder
  }
  // yearFolder is now resolved; ensure we have a reference to its parent root only if needed
  const rfaFolders = yearFolder.getFoldersByName(rfa.RFA_NUMBER);
  const folder = rfaFolders.hasNext() ? rfaFolders.next() : yearFolder.createFolder(rfa.RFA_NUMBER);
  folderCache.set(cacheKey, folder);
  return folder;
}

export function uploadAttachment(user: SessionUser, payload: Record<string, unknown>): SheetRecord {
  const rfa = getRfa(String(payload.rfaId ?? ''));
  assertOwnerEditable(user, rfa);
  const fileName = String(payload.fileName ?? '').replace(/[\\/:*?"<>|]/g, '_').trim();
  const mimeType = String(payload.mimeType ?? '');
  const base64 = String(payload.base64 ?? '');
  if (!fileName || !ALLOWED_ATTACHMENT_TYPES.includes(mimeType)) businessError('Attachment must be a PDF, JPG, PNG, DOC, or DOCX file.');
  const bytes = Utilities.base64Decode(base64);
  const max = Number(getSetting('MAX_ATTACHMENT_BYTES') || 10000000);
  if (!bytes.length || bytes.length > max) businessError(`Attachment must be between 1 byte and ${Math.round(max / 1000000)} MB.`);
  const file = rfaFolder(rfa).createFile(Utilities.newBlob(bytes, mimeType, fileName));
  file.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.VIEW);
  const record = {
    ATTACHMENT_ID: newId('att'), RFA_ID: rfa.RFA_ID, FILE_NAME: fileName, DRIVE_FILE_ID: file.getId(),
    MIME_TYPE: mimeType, SIZE_BYTES: bytes.length, UPLOADED_BY: user.EMAIL, UPLOADED_AT: nowIso()
  };
  insert('RFA_ATTACHMENTS', record);
  audit('ATTACHMENT_UPLOADED', user, rfa.RFA_ID, rfa.STATUS, rfa.STATUS, fileName, { mimeType, size: bytes.length });
  const { DRIVE_FILE_ID: _hidden, ...safe } = record;
  return safe;
}

export function downloadAttachment(user: SessionUser, attachmentId: string): SheetRecord {
  const attachment = findBy<SheetRecord>('RFA_ATTACHMENTS', 'ATTACHMENT_ID', attachmentId);
  if (!attachment) businessError('Attachment was not found.', 'NOT_FOUND');
  const rfa = getRfa(String(attachment.RFA_ID));
  assertView(user, rfa);
  const blob = DriveApp.getFileById(String(attachment.DRIVE_FILE_ID)).getBlob();
  return { fileName: attachment.FILE_NAME, mimeType: attachment.MIME_TYPE, base64: Utilities.base64Encode(blob.getBytes()) };
}
