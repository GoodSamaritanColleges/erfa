import { ALLOWED_ATTACHMENT_TYPES, APPROVAL_SECTIONS, ASSIGNMENT_WORKFLOW_MARKER, FIXED_WORKFLOW_MARKER, LEGACY_APPROVAL_SECTIONS, OFFICIAL_WORKFLOW_MARKER, STEP_STATUS, V2_APPROVAL_SECTIONS } from './constants';
import { audit } from './audit';
import { commitApprovedFinancialRfa, financialDetail, financialRfaFields, recordActualExpense } from './budget';
import { formatRfaNumber, isJhsOrShsDepartment, nextAssignedSection, nextAssignedStageAfterAction, normalizeEmail, orderedMatrix, parsePresidentThresholdCents, selectNextApprover, toBoolean, validateExpenseClassification, validateRfaInput } from './core';
import { archivedRows, findArchivedAttachment, findArchivedRfa, schoolYearLabel } from './archive';
import { notify } from './notifications';
import { activeRoles, emailOrderFor, hasAllRfasRole, isReplacedOfficial, resolveRole, type ApprovalRole, type RoleStage } from './roles';
import { all, clearPendingRfaAssignments, findBy, getAssignmentsBySection, getSetting, insert, newId, nowIso, saveRfaSectionAssignments, setSetting, updateBy } from './store';
import type { ApprovalSection, DepartmentHeadRecord, DepartmentRecord, EligibleApprover, MatrixRecord, RfaRecord, RfaSectionAssignments, SessionUser, SheetRecord, UserRecord } from './types';

function businessError(message: string, code = 'INVALID_OPERATION'): never {
  const error = new Error(message) as Error & { code?: string };
  error.code = code;
  throw error;
}

function isAssignmentWorkflow(rfa: RfaRecord): boolean {
  return rfa.CURRENT_MATRIX_ID === ASSIGNMENT_WORKFLOW_MARKER || rfa.CURRENT_MATRIX_ID === FIXED_WORKFLOW_MARKER || rfa.CURRENT_MATRIX_ID === OFFICIAL_WORKFLOW_MARKER;
}

function isFixedWorkflow(rfa: RfaRecord): boolean {
  return rfa.CURRENT_MATRIX_ID === FIXED_WORKFLOW_MARKER;
}

function isOfficialWorkflow(rfa: RfaRecord): boolean {
  return rfa.CURRENT_MATRIX_ID === OFFICIAL_WORKFLOW_MARKER;
}

function isLegacyAssignmentWorkflow(rfa: RfaRecord): boolean {
  return rfa.CURRENT_MATRIX_ID === ASSIGNMENT_WORKFLOW_MARKER;
}

function sectionsForRfa(rfa: RfaRecord): readonly ApprovalSection[] {
  if (isLegacyAssignmentWorkflow(rfa)) return LEGACY_APPROVAL_SECTIONS;
  if (isFixedWorkflow(rfa)) return V2_APPROVAL_SECTIONS;
  if (isOfficialWorkflow(rfa)) return APPROVAL_SECTIONS;
  return APPROVAL_SECTIONS;
}

function markerFor(rfa: RfaRecord): string {
  if (isOfficialWorkflow(rfa)) return OFFICIAL_WORKFLOW_MARKER;
  if (isFixedWorkflow(rfa)) return FIXED_WORKFLOW_MARKER;
  return ASSIGNMENT_WORKFLOW_MARKER;
}

function currentAssignmentSection(rfa: RfaRecord): ApprovalSection | null {
  const sections = sectionsForRfa(rfa);
  return sections.includes(rfa.CURRENT_STEP as ApprovalSection) ? rfa.CURRENT_STEP as ApprovalSection : null;
}

function getApprovedAssignments(rfa: RfaRecord, section: ApprovalSection): SheetRecord[] {
  const submittedAt = Date.parse(String(rfa.SUBMITTED_AT || ''));
  return approvalRows(rfa.RFA_ID).filter((row) => row.STEP === section && row.ACTION === 'APPROVED' && (!Number.isFinite(submittedAt) || Date.parse(String(row.TIMESTAMP || '')) >= submittedAt));
}

/**
 * Email order within Approved By: the AVP for Finance role first, then the VPs,
 * then the President last. Only the email timing follows this order; every assigned
 * official can still open and act on the RFA as soon as the stage starts.
 */
function approvedByEmailTier(row: SheetRecord): number {
  return emailOrderFor({ id: String(row.APPROVER_USER_ID), name: String(row.APPROVER_NAME || ''), email: String(row.APPROVER_EMAIL || '') });
}

/** The Approved By assignees still awaiting action in the earliest email tier that is not yet complete. */
function approvedByCurrentEmailTier(rfa: RfaRecord): { tier: number; rows: SheetRecord[] } {
  const approvedIds = new Set(getApprovedAssignments(rfa, 'APPROVED_BY').map((row) => String(row.APPROVER_USER_ID)));
  const pending = getAssignmentsBySection(rfa.RFA_ID, 'APPROVED_BY').filter((row) => !approvedIds.has(String(row.APPROVER_USER_ID)));
  if (!pending.length) return { tier: -1, rows: [] };
  const tier = Math.min(...pending.map(approvedByEmailTier));
  return { tier, rows: pending.filter((row) => approvedByEmailTier(row) === tier) };
}

/** True while an earlier Approved By official (AVP for Finance role, then the VPs) has not yet approved ahead of this user. */
function notYetApprovedByTurn(rfa: RfaRecord, userId: string): boolean {
  if (rfa.CURRENT_STEP !== 'APPROVED_BY' || !isAssignmentWorkflow(rfa)) return false;
  const mine = getAssignmentsBySection(rfa.RFA_ID, 'APPROVED_BY').find((row) => String(row.APPROVER_USER_ID) === userId);
  if (!mine) return false;
  const { tier } = approvedByCurrentEmailTier(rfa);
  return tier >= 0 && approvedByEmailTier(mine) > tier;
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

export function notedByNotApplicable(auditEntries: SheetRecord[]): boolean {
  const latest = [...auditEntries].reverse().find((row) => row.ACTION === 'NOTED_BY_SELECTION');
  return latest?.REMARKS === 'N/A';
}

// Execution-local Drive folder memoization
const folderCache = new Map<string, GoogleAppsScript.Drive.Folder>();
export function resetWorkflowCache(): void { folderCache.clear(); }

function isProcurementUser(user: SessionUser): boolean {
  // Procurement Unit members get view-only access to approved RFAs (no approval role).
  if (!user.DEPARTMENT_ID) return false;
  try {
    const dept = findBy<DepartmentRecord>('DEPARTMENTS', 'DEPARTMENT_ID', user.DEPARTMENT_ID);
    if (!dept) return false;
    return String(dept.DEPARTMENT_CODE || '').toUpperCase() === 'PPU' || String(dept.DEPARTMENT_NAME || '').toUpperCase().includes('PROCUREMENT');
  } catch { return false; }
}

const APPROVED_STATUSES = ['APPROVED', 'IMPLEMENTATION', 'CLOSED'];

/**
 * Who may open the institution-wide "All RFAs" register:
 *  - 'all'      administrators, both VPs, the President, the Reviewed and Noted
 *               official and the Approved By officials (see OFFICIAL_ROLES)
 *  - 'approved' Procurement: approved, in-implementation and closed RFAs only
 *  - 'none'     everyone else (they see only their own RFAs and their approval queue)
 * Officials are recognised by their configured user ID or email; when a setting is
 * blank, by name, mirroring how approval routing locates them.
 */
export function allRfasScope(user: SessionUser): 'all' | 'approved' | 'none' {
  if (toBoolean(user.IS_ADMIN)) return 'all';
  const person = { id: user.USER_ID, name: String(user.FULL_NAME || ''), email: user.EMAIL };
  if (hasAllRfasRole(person)) return 'all';
  const procurementId = String(getSetting('PROCUREMENT_USER_ID') || '').trim();
  if ((procurementId && procurementId === user.USER_ID) || isProcurementUser(user)) return 'approved';
  return 'none';
}

function canView(user: SessionUser, rfa: RfaRecord, approvals?: SheetRecord[]): boolean {
  if (toBoolean(user.IS_ADMIN) || normalizeEmail(rfa.REQUESTER_EMAIL) === normalizeEmail(user.EMAIL)) return true;
  if (toBoolean(user.CAN_IMPLEMENT_RFA) && APPROVED_STATUSES.includes(rfa.STATUS)) return true;
  const scope = allRfasScope(user);
  if (scope === 'all' || (scope === 'approved' && APPROVED_STATUSES.includes(rfa.STATUS))) return true;
  if (normalizeEmail(rfa.CURRENT_APPROVER_EMAIL) === normalizeEmail(user.EMAIL)) return true;
  return (approvals ?? approvalRows(rfa.RFA_ID)).some((row) => normalizeEmail(row.APPROVER_EMAIL) === normalizeEmail(user.EMAIL));
}

function assertView(user: SessionUser, rfa: RfaRecord, approvals?: SheetRecord[]): void {
  if (!canView(user, rfa, approvals)) {
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

/** Drive folder name for a draft's attachments until it receives its RFA number. */
function draftFolderName(rfa: RfaRecord): string { return `DRAFT-${rfa.RFA_ID}`; }

/**
 * RFA numbers are given when an RFA is first submitted, so unsubmitted drafts never use up
 * a number and numbers follow the order RFAs were actually sent. Called only after the
 * submission has passed validation; a returned RFA keeps its number when resubmitted.
 */
function assignNumberOnSubmit(rfa: RfaRecord): void {
  if (rfa.RFA_NUMBER) return;
  rfa.RFA_NUMBER = nextNumber();
  updateBy('RFA', 'RFA_ID', rfa.RFA_ID, { RFA_NUMBER: rfa.RFA_NUMBER });
  moveDraftAttachments(rfa);
}

/** Rename the draft's attachment folder to the new RFA number, in that number's year folder. */
function moveDraftAttachments(rfa: RfaRecord): void {
  try {
    const rootId = getSetting('ATTACHMENT_ROOT_FOLDER_ID');
    if (!rootId) return;
    const root = DriveApp.getFolderById(rootId);
    const years = root.getFolders();
    while (years.hasNext()) {
      const yearFolder = years.next();
      const drafts = yearFolder.getFoldersByName(draftFolderName(rfa));
      if (!drafts.hasNext()) continue;
      const folder = drafts.next();
      folder.setName(rfa.RFA_NUMBER);
      const targetYear = rfa.RFA_NUMBER.split('-')[1];
      if (targetYear && yearFolder.getName() !== targetYear) {
        const existing = root.getFoldersByName(targetYear);
        folder.moveTo(existing.hasNext() ? existing.next() : root.createFolder(targetYear));
      }
      folderCache.delete(`rfa:${draftFolderName(rfa)}`);
      return;
    }
  } catch { /* Attachments open from their own file IDs; the folder name is only for tidiness. */ }
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
  const recipients = section === 'APPROVED_BY'
    ? approvedByCurrentEmailTier(rfa).rows
    : getAssignmentsBySection(rfa.RFA_ID, section).filter((row) => !approvedEmails.has(normalizeEmail(row.APPROVER_EMAIL)));
  recipients.forEach((row) => notify('APPROVAL_REQUIRED', { FULL_NAME: row.APPROVER_NAME, EMAIL: row.APPROVER_EMAIL } as UserRecord, rfa, actor, `This RFA is awaiting your approval action for the ${section} section.`));
}

function completeAssignedWorkflow(rfa: RfaRecord, actor: SessionUser): RfaRecord {
  const financial = commitApprovedFinancialRfa(rfa, actor);
  const marker = markerFor(rfa);
  const financialUpdates: Record<string, unknown> = { ...(financial || {}) };
  // Expense-monitoring: approved amount mirrors requested amount (no ledger).
  if (!financialUpdates.APPROVED_AMOUNT && toBoolean(rfa.IS_BUDGET_REQUEST) && Number(rfa.REQUESTED_AMOUNT) > 0) {
    financialUpdates.APPROVED_AMOUNT = Number(rfa.REQUESTED_AMOUNT);
  }
  const updates = { STATUS: 'APPROVED', CURRENT_STEP: 'APPROVED_BY', CURRENT_APPROVER_USER_ID: '', CURRENT_APPROVER_EMAIL: '', CURRENT_MATRIX_ID: marker, COMPLETED_AT: nowIso(), UPDATED_AT: nowIso(), VERSION: Number(rfa.VERSION) + 1, ...financialUpdates };
  updateBy('RFA', 'RFA_ID', rfa.RFA_ID, updates);
  const approved = { ...rfa, ...updates } as RfaRecord;
  audit('STATUS_CHANGED', actor, rfa.RFA_ID, rfa.STATUS, 'APPROVED', 'All assigned approval sections completed.');
  const requester = all<UserRecord>('USERS').find((candidate) => normalizeEmail(candidate.EMAIL) === normalizeEmail(rfa.REQUESTER_EMAIL));
  if (requester) notify('RFA_APPROVED', requester, approved, actor);
  return approved;
}

function routeAssigned(rfa: RfaRecord, actor: SessionUser, startIndex: number): RfaRecord {
  const sections = sectionsForRfa(rfa);
  const marker = markerFor(rfa);
  const assignments = approvalRows(rfa.RFA_ID).filter((row) => row.ACTION === '');
  const counts = sections.reduce((allCounts, section) => ({ ...allCounts, [section]: assignments.filter((row) => row.STEP === section).length }), {} as Record<string, number>);
  const section = nextAssignedSection(counts, startIndex, sections);
  if (section) {
    for (let index = startIndex; index < sections.indexOf(section); index += 1) {
      audit('STAGE_SKIPPED', actor, rfa.RFA_ID, rfa.STATUS, rfa.STATUS, 'No approvers assigned for this section.', { section: sections[index] });
    }
    const assigned = assignments.filter((row) => row.STEP === section);
    const updates = { STATUS: STEP_STATUS[section], CURRENT_STEP: section, CURRENT_APPROVER_USER_ID: '', CURRENT_APPROVER_EMAIL: '', CURRENT_MATRIX_ID: marker, RESUME_MATRIX_ID: '', UPDATED_AT: nowIso(), VERSION: Number(rfa.VERSION) + 1 };
    updateBy('RFA', 'RFA_ID', rfa.RFA_ID, updates);
    const routed = { ...rfa, ...updates } as RfaRecord;
    audit('APPROVAL_REQUESTED', actor, rfa.RFA_ID, rfa.STATUS, routed.STATUS, '', { section, approverCount: assigned.length });
    notifyAssignedStage(routed, actor, section);
    return routed;
  }
  return completeAssignedWorkflow(rfa, actor);
}

function emptyAssignments(): RfaSectionAssignments {
  return { RECOMMENDING_APPROVAL: [], REVIEWED_AND_NOTED: [], REVIEWED_BY: [], NOTED_BY: [], INVOLVED_DEPARTMENT_HEAD: [], APPROVED_BY: [] };
}

function emptyLegacyAssignments(): RfaSectionAssignments {
  return { RECOMMENDING_APPROVAL: [], REVIEWED_AND_NOTED: [], REVIEWED_BY: [], NOTED_BY: [], INVOLVED_DEPARTMENT_HEAD: [], APPROVED_BY: [] };
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

/** Legacy (V1) free-selection parser — retained only for historical RFAs. */
function parseAssignments(user: SessionUser, value: unknown): RfaSectionAssignments {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const users = all<UserRecord>('USERS');
  const activeEmployees = new Map(activeEmployeeDirectory(user, users).map((candidate) => [candidate.USER_ID, candidate]));
  const usersById = new Map(users.map((candidate) => [candidate.USER_ID, candidate]));
  const assignments = emptyLegacyAssignments();
  LEGACY_APPROVAL_SECTIONS.forEach((section) => {
    const ids = Array.isArray(source[section]) ? source[section].map((id) => String(id)) : [];
    if (new Set(ids).size !== ids.length) businessError(`Duplicate approvers are not allowed in ${section}.`);
    (assignments as Record<string, EligibleApprover[]>)[section] = ids.map((id) => {
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

function validateNotedByChoice(payload: Record<string, unknown>, assignments: RfaSectionAssignments): boolean {
  const notApplicable = payload.notedByNotApplicable === true;
  if (notApplicable && assignments.NOTED_BY.length) businessError('Noted By cannot contain approvers when N/A is selected.');
  return notApplicable;
}

function saveAssignments(rfa: RfaRecord, assignments: RfaSectionAssignments, sections: readonly ApprovalSection[] = APPROVAL_SECTIONS): void {
  clearPendingRfaAssignments(rfa.RFA_ID);
  sections.forEach((section) => saveRfaSectionAssignments(rfa.RFA_ID, rfa.RFA_NUMBER, section, (assignments as Record<string, EligibleApprover[]>)[section] || []));
  const persisted = approvalRows(rfa.RFA_ID).filter((row) => row.ACTION === '');
  const savedCorrectly = sections.every((section) => persisted.filter((row) => row.STEP === section).length === ((assignments as Record<string, EligibleApprover[]>)[section] || []).length);
  if (!savedCorrectly) businessError('The approval route could not be saved. Please try again.', 'CONFLICT');
}

function toEligible(user: UserRecord, departments: Map<string, string>): EligibleApprover {
  return { USER_ID: user.USER_ID, FULL_NAME: user.FULL_NAME, EMAIL: user.EMAIL, POSITION: user.POSITION, DEPARTMENT: departments.get(user.DEPARTMENT_ID) || 'Not assigned' };
}

function toUsersMap(): Map<string, UserRecord> {
  return new Map(all<UserRecord>('USERS').map((u) => [u.USER_ID, u]));
}

function isValidApprover(user: UserRecord | undefined, requesterEmail: string, requesterUserId: string): user is UserRecord {
  return !!user && toBoolean(user.ACTIVE) && toBoolean(user.CAN_APPROVE_RFA) && user.USER_ID !== requesterUserId && normalizeEmail(user.EMAIL) !== requesterEmail;
}

/** Heads for a department: DEPARTMENT_HEADS rows first, primary field as fallback. */
function getDepartmentHeads(departmentId: string, usersById: Map<string, UserRecord>, requesterEmail: string, requesterUserId: string, requireValid = true): UserRecord[] {
  const heads: UserRecord[] = [];
  const idSet = new Set<string>();
  let sheetHeads: DepartmentHeadRecord[] = [];
  try { sheetHeads = all<DepartmentHeadRecord>('DEPARTMENT_HEADS'); } catch { sheetHeads = []; }
  for (const row of sheetHeads) {
    if (row.DEPARTMENT_ID !== departmentId || !toBoolean(row.ACTIVE)) continue;
    const userId = String(row.USER_ID || '');
    if (!userId || idSet.has(userId)) continue;
    idSet.add(userId);
    const candidate = usersById.get(userId);
    if (candidate && (!requireValid || isValidApprover(candidate, requesterEmail, requesterUserId))) heads.push(candidate);
  }
  if (heads.length) {
    // Also include primary field if not already present (backward compat adds it only when sheet empty)
    return heads;
  }
  const dept = all<DepartmentRecord>('DEPARTMENTS').find((d) => d.DEPARTMENT_ID === departmentId);
  const headId = dept ? String(dept.DEPARTMENT_HEAD_USER_ID || '') : '';
  if (headId) {
    const candidate = usersById.get(headId);
    if (candidate && (!requireValid || isValidApprover(candidate, requesterEmail, requesterUserId))) heads.push(candidate);
  }
  return heads;
}

function isAcademicDepartment(department: DepartmentRecord): boolean {
  if (toBoolean(department.IS_ACADEMIC)) return true;
  // Fallback: JHS/SHS are academic even before an admin toggles the flag.
  if (isJhsOrShsDepartment(department)) return true;
  return false;
}

function getThresholdCents(): number {
  try { return parsePresidentThresholdCents(getSetting('PRESIDENT_THRESHOLD_PHP') || '50000'); } catch { return 5_000_000; }
}


function addDistinct(list: EligibleApprover[], candidates: EligibleApprover[]): void {
  for (const c of candidates) {
    if (!list.some((e) => e.USER_ID === c.USER_ID)) list.push(c);
  }
}

/**
 * Resolve fixed department-based assignments from the Approval Matrix
 * (REVIEWED_BY / NOTED_BY / APPROVED_BY) and the involved department head
 * (DEPARTMENTS.DEPARTMENT_HEAD_USER_ID, matrix fallback).
 * strict=true enforces REVIEWED_BY + APPROVED_BY existence (and head when involved).
 */
function resolveFixedAssignments(
  departmentId: string,
  involvedDepartmentId: string,
  notedByNotApplicable: boolean,
  requesterEmail: string,
  requesterUserId: string,
  strict: boolean
): { assignments: RfaSectionAssignments; involvedDepartmentName: string } {
  const requester = normalizeEmail(requesterEmail);
  const departments = all<DepartmentRecord>('DEPARTMENTS');
  const departmentMap = new Map(departments.map((d) => [d.DEPARTMENT_ID, d]));
  const deptNameMap = new Map(departments.map((d) => [d.DEPARTMENT_ID, d.DEPARTMENT_NAME]));
  const users = all<UserRecord>('USERS');
  const usersById = new Map(users.map((u) => [u.USER_ID, u]));
  const matrix = all<MatrixRecord>('APPROVAL_MATRIX').filter((row) => toBoolean(row.ACTIVE) && toBoolean(row.REQUIRED));
  const assignments = emptyAssignments();
  const resolveMatrixSection = (section: ApprovalSection): EligibleApprover[] => {
    const rows = matrix
      .filter((row) => row.DEPARTMENT_ID === departmentId && row.APPROVAL_STEP === section)
      .sort((a, b) => Number(a.SEQUENCE) - Number(b.SEQUENCE));
    const out: EligibleApprover[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const candidate = usersById.get(String(row.APPROVER_USER_ID));
      if (!candidate || !toBoolean(candidate.ACTIVE) || !toBoolean(candidate.CAN_APPROVE_RFA)) continue;
      if (candidate.USER_ID === requesterUserId || normalizeEmail(candidate.EMAIL) === requester) continue; // self-approval prevention (skip)
      if (seen.has(candidate.USER_ID)) continue;
      seen.add(candidate.USER_ID);
      out.push(toEligible(candidate, deptNameMap));
    }
    return out;
  };
  assignments.REVIEWED_BY = resolveMatrixSection('REVIEWED_BY');
  assignments.NOTED_BY = notedByNotApplicable ? [] : resolveMatrixSection('NOTED_BY');
  assignments.APPROVED_BY = resolveMatrixSection('APPROVED_BY');
  let involvedDepartmentName = '';
  if (involvedDepartmentId) {
    const involved = departmentMap.get(involvedDepartmentId);
    if (!involved || !toBoolean(involved.ACTIVE)) businessError('The involved department is missing or inactive.', 'CONFIGURATION_REQUIRED');
    if (involved.DEPARTMENT_ID === departmentId) businessError('The involved department must be different from the requesting department.');
    involvedDepartmentName = involved.DEPARTMENT_NAME;
    // Primary: department head field. Fallback: matrix rows for INVOLVED_DEPARTMENT_HEAD.
    let head: EligibleApprover[] = [];
    const headUserId = String((involved as unknown as Record<string, unknown>).DEPARTMENT_HEAD_USER_ID || '').trim();
    if (headUserId) {
      const candidate = usersById.get(headUserId);
      if (candidate && toBoolean(candidate.ACTIVE) && toBoolean(candidate.CAN_APPROVE_RFA) && candidate.USER_ID !== requesterUserId && normalizeEmail(candidate.EMAIL) !== requester) {
        head = [toEligible(candidate, deptNameMap)];
      }
    }
    if (!head.length) {
      const rows = matrix
        .filter((row) => row.DEPARTMENT_ID === involvedDepartmentId && row.APPROVAL_STEP === 'INVOLVED_DEPARTMENT_HEAD')
        .sort((a, b) => Number(a.SEQUENCE) - Number(b.SEQUENCE));
      const seen = new Set<string>();
      for (const row of rows) {
        const candidate = usersById.get(String(row.APPROVER_USER_ID));
        if (!candidate || !toBoolean(candidate.ACTIVE) || !toBoolean(candidate.CAN_APPROVE_RFA)) continue;
        if (candidate.USER_ID === requesterUserId || normalizeEmail(candidate.EMAIL) === requester) continue;
        if (seen.has(candidate.USER_ID)) continue;
        seen.add(candidate.USER_ID);
        head.push(toEligible(candidate, deptNameMap));
      }
    }
    if (strict && !head.length) {
      businessError(`No department head is configured for the involved department (${involvedDepartmentName}). An administrator must set the department head before this RFA can be submitted.`, 'CONFIGURATION_REQUIRED');
    }
    assignments.INVOLVED_DEPARTMENT_HEAD = head;
  } else {
    assignments.INVOLVED_DEPARTMENT_HEAD = [];
  }
  if (strict) {
    if (!assignments.REVIEWED_BY.length) businessError('No active REVIEWED BY approver is configured for your department. An administrator must configure the Approval Matrix before this RFA can be submitted.', 'CONFIGURATION_REQUIRED');
    if (!assignments.APPROVED_BY.length) businessError('No active APPROVED BY approver is configured for your department. An administrator must configure the Approval Matrix before this RFA can be submitted.', 'CONFIGURATION_REQUIRED');
  }
  return { assignments, involvedDepartmentName };
}

export interface OfficialSelections {
  purchaseRequest: boolean;
  recommendingAlternateUserId: string;
  includePrincipal: boolean;
  includeProcurement: boolean;
  involvedDepartmentIds: string[];
}

/**
 * Official V3 resolver. strict=true enforces all mandatory/conditional config at submit.
 * All stages are AND: every assigned approver (including every recommending head) must approve.
 */
function resolveOfficialAssignments(
  departmentId: string,
  selections: OfficialSelections,
  requestedAmountCents: number,
  requesterEmail: string,
  requesterUserId: string,
  strict: boolean
): { assignments: RfaSectionAssignments; involvedDepartmentNames: string[]; alternateName: string } {
  const requester = normalizeEmail(requesterEmail);
  const departments = all<DepartmentRecord>('DEPARTMENTS');
  const departmentMap = new Map(departments.map((d) => [d.DEPARTMENT_ID, d]));
  const deptNameMap = new Map(departments.map((d) => [d.DEPARTMENT_ID, d.DEPARTMENT_NAME]));
  const usersById = toUsersMap();
  const matrix = all<MatrixRecord>('APPROVAL_MATRIX').filter((row) => toBoolean(row.ACTIVE) && toBoolean(row.REQUIRED));
  const requestingDept = departmentMap.get(departmentId);
  if (!requestingDept || !toBoolean(requestingDept.ACTIVE)) businessError('Your configured department is missing or inactive.', 'CONFIGURATION_REQUIRED');

  const assignments = emptyAssignments();
  const resolveMatrix = (section: ApprovalSection): EligibleApprover[] => {
    const rows = matrix.filter((row) => row.DEPARTMENT_ID === departmentId && row.APPROVAL_STEP === section).sort((a, b) => Number(a.SEQUENCE) - Number(b.SEQUENCE));
    const out: EligibleApprover[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const c = usersById.get(String(row.APPROVER_USER_ID));
      if (!c || !isValidApprover(c, requester, requesterUserId)) continue;
      if (isReplacedOfficial(c)) continue; // role now held by someone else (set in Approval settings)
      if (seen.has(c.USER_ID)) continue;
      seen.add(c.USER_ID);
      out.push(toEligible(c, deptNameMap));
    }
    return out;
  };

  // --- Stage 1: Recommending Approval (Dept Head — all must approve) ---
  // Alternate selection removed — single head approves alone; dual heads: either approves.
  let recommending: EligibleApprover[] = [];
  const heads = getDepartmentHeads(departmentId, usersById, requester, requesterUserId, true);
  recommending = heads.map((h) => toEligible(h, deptNameMap));
  const alternateName = '';
  // Backward compat: ignore any legacy alternate selection (don't require, don't add)
  if (strict && !recommending.length) businessError('No Department Head is configured for the requesting department. An administrator must set department heads before submission.', 'CONFIGURATION_REQUIRED');
  assignments.RECOMMENDING_APPROVAL = recommending;

  // Roles from Administration -> Approval roles. Each applicable role must have a person who can approve.
  const canApprove = (u: UserRecord) => isValidApprover(u, requester, requesterUserId);
  const roleHolders = (stage: RoleStage, applies: (role: ApprovalRole) => boolean, why: string): EligibleApprover[] => {
    const holders: EligibleApprover[] = [];
    for (const role of activeRoles(stage).filter(applies)) {
      const holder = resolveRole(role, usersById, canApprove);
      if (holder) addDistinct(holders, [toEligible(holder, deptNameMap)]);
      else if (strict) businessError(`The approval role "${role.TITLE}" has no person assigned${why}. An administrator must assign it in Approval roles before submission.`, 'CONFIGURATION_REQUIRED');
    }
    return holders;
  };
  const academic = isAcademicDepartment(requestingDept);
  const atOrAboveThreshold = Number(requestedAmountCents) >= getThresholdCents();
  const conditional = (role: ApprovalRole) => (role.CONDITION === 'ACADEMIC' && academic) || (role.CONDITION === 'AT_OR_ABOVE_THRESHOLD' && atOrAboveThreshold);

  // --- Stage 2: Reviewed and Noted By ---
  const reviewed: EligibleApprover[] = [];
  // A department's own matrix entries take precedence over the always-on Reviewed roles.
  let mandatoryReviewed = resolveMatrix('REVIEWED_AND_NOTED');
  if (!mandatoryReviewed.length) mandatoryReviewed = roleHolders('REVIEWED_AND_NOTED', (role) => role.CONDITION === 'ALWAYS', '');
  addDistinct(reviewed, mandatoryReviewed);
  if (strict && !mandatoryReviewed.length) businessError('Reviewed and Noted By has no approver. An administrator must assign it in Approval roles before submission.', 'CONFIGURATION_REQUIRED');
  addDistinct(reviewed, roleHolders('REVIEWED_AND_NOTED', conditional, ' for this request'));

  // Optional: Other Department Heads (all heads per involved dept — all must approve)
  const involvedNames: string[] = [];
  for (const involvedId of selections.involvedDepartmentIds) {
    const involved = departmentMap.get(involvedId);
    if (!involved || !toBoolean(involved.ACTIVE)) businessError('An involved department is missing or inactive.', 'CONFIGURATION_REQUIRED');
    if (involvedId === departmentId) businessError('An involved department must be different from the requesting department.');
    involvedNames.push(involved.DEPARTMENT_NAME);
    const involvedHeads = getDepartmentHeads(involvedId, usersById, requester, requesterUserId, true);
    if (strict && !involvedHeads.length) businessError(`No department head is configured for involved department ${involved.DEPARTMENT_NAME}.`, 'CONFIGURATION_REQUIRED');
    if (involvedHeads.length) {
      // All heads of the involved department must approve (same AND rule as every stage).
      addDistinct(reviewed, involvedHeads.map((h) => toEligible(h, deptNameMap)));
    }
  }

  // Optional: JHS/SHS roles (e.g. the Principal), only when the request asks for them
  if (selections.includePrincipal) {
    if (!isJhsOrShsDepartment(requestingDept)) businessError('The JHS/SHS Principal is only available for Junior High School or Senior High School departments.', 'FORBIDDEN');
    addDistinct(reviewed, roleHolders('REVIEWED_AND_NOTED', (role) => role.CONDITION === 'JHS_SHS_OPTIONAL', ' for this JHS/SHS request'));
  }
  // Procurement Clerk removed from the workflow — never assigned.
  assignments.REVIEWED_AND_NOTED = reviewed;

  // --- Stage 3: Approved By ---
  const approved: EligibleApprover[] = [];
  const mandatoryApproved = resolveMatrix('APPROVED_BY');
  addDistinct(mandatoryApproved, roleHolders('APPROVED_BY', (role) => role.CONDITION === 'ALWAYS', ''));
  addDistinct(approved, mandatoryApproved);
  if (strict && !mandatoryApproved.length) businessError('Approved By has no approvers. An administrator must assign them in Approval roles before submission.', 'CONFIGURATION_REQUIRED');
  // Conditional roles: academic departments (e.g. VP for Academic Affairs), at or above the threshold (e.g. President)
  addDistinct(approved, roleHolders('APPROVED_BY', conditional, ' for this request'));
  assignments.APPROVED_BY = approved;

  return { assignments, involvedDepartmentNames: involvedNames, alternateName };
}

function parseInvolvedDepartmentIds(payload: Record<string, unknown>): string[] {
  const out: string[] = [];
  const push = (value: string) => { const v = value.trim(); if (v && !out.includes(v)) out.push(v); };
  if (Array.isArray(payload.involvedDepartmentIds)) {
    for (const item of payload.involvedDepartmentIds) push(String(item || ''));
  }
  if (typeof payload.involvedDepartmentIds === 'string' && String(payload.involvedDepartmentIds).includes(',')) {
    for (const part of String(payload.involvedDepartmentIds).split(',')) push(part);
  }
  push(String(payload.involvedDepartmentId || ''));
  return out;
}

function validateInvolvedChoice(payload: Record<string, unknown>, requestingDepartmentId: string): { hasInvolved: boolean; involvedDepartmentId: string } {
  const ids = parseInvolvedDepartmentIds(payload);
  const hasInvolved = payload.hasInvolvedDepartment === true || ids.length > 0;
  if (!hasInvolved) return { hasInvolved: false, involvedDepartmentId: '' };
  if (!ids.length) businessError('The involved department is required when another department is involved.');
  for (const id of ids) {
    if (id === requestingDepartmentId) businessError('An involved department must be different from the requesting department.');
    const involved = findBy<DepartmentRecord>('DEPARTMENTS', 'DEPARTMENT_ID', id);
    if (!involved || !toBoolean(involved.ACTIVE)) businessError('An involved department is missing or inactive.', 'CONFIGURATION_REQUIRED');
  }
  return { hasInvolved: true, involvedDepartmentId: ids[0] };
}

function parseOfficialSelections(payload: Record<string, unknown>, requestingDepartmentId: string): OfficialSelections & { involvedDepartmentIds: string[] } {
  const involvedDepartmentIds = parseInvolvedDepartmentIds(payload);
  // Validate each involved dept eagerly (invalid selections should not be stored)
  for (const id of involvedDepartmentIds) {
    if (id === requestingDepartmentId) businessError('An involved department must be different from the requesting department.');
    const involved = findBy<DepartmentRecord>('DEPARTMENTS', 'DEPARTMENT_ID', id);
    if (!involved || !toBoolean(involved.ACTIVE)) businessError('An involved department is missing or inactive.', 'CONFIGURATION_REQUIRED');
  }
  return {
    purchaseRequest: toBoolean(payload.purchaseRequest),
    recommendingAlternateUserId: String(payload.recommendingAlternateUserId || '').trim(),
    includePrincipal: toBoolean(payload.includePrincipal),
    includeProcurement: toBoolean(payload.includeProcurement),
    involvedDepartmentIds
  };
}

function officialSelectionsFromRfa(rfa: RfaRecord): OfficialSelections {
  const ids = String(rfa.INVOLVED_DEPARTMENT_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!ids.length && rfa.INVOLVED_DEPARTMENT_ID) ids.push(String(rfa.INVOLVED_DEPARTMENT_ID));
  // Legacy V2/V1 RFAs stored involved as single field without official selections
  return {
    purchaseRequest: toBoolean(rfa.PURCHASE_REQUEST),
    recommendingAlternateUserId: String(rfa.RECOMMENDING_ALTERNATE_USER_ID || '').trim(),
    includePrincipal: toBoolean(rfa.INCLUDE_PRINCIPAL),
    includeProcurement: toBoolean(rfa.INCLUDE_PROCUREMENT),
    involvedDepartmentIds: ids
  };
}

export function listDepartments(user: SessionUser): DepartmentRecord[] {
  if (!toBoolean(user.CAN_CREATE_RFA)) businessError('You do not have permission to select departments.', 'FORBIDDEN');
  const seen = new Map<string, DepartmentRecord>();
  for (const d of all<DepartmentRecord>('DEPARTMENTS').filter((d) => toBoolean(d.ACTIVE))) {
    const key = String(d.DEPARTMENT_NAME || '').trim().toLowerCase() || String(d.DEPARTMENT_CODE || '').toUpperCase();
    if (!seen.has(key)) seen.set(key, d);
  }
  return Array.from(seen.values()).sort((a, b) => String(a.DEPARTMENT_NAME).localeCompare(String(b.DEPARTMENT_NAME)));
}

export function fixedRoutePreview(user: SessionUser): Record<string, unknown> {
  if (!toBoolean(user.CAN_CREATE_RFA) || !user.DEPARTMENT_ID) businessError('You do not have permission to view the approval route.', 'FORBIDDEN');
  const department = findBy<DepartmentRecord>('DEPARTMENTS', 'DEPARTMENT_ID', user.DEPARTMENT_ID);
  if (!department) businessError('Your configured department is missing or inactive.', 'CONFIGURATION_REQUIRED');
  const usersById = toUsersMap();
  const deptNameMap = new Map(all<DepartmentRecord>('DEPARTMENTS').map((d) => [d.DEPARTMENT_ID, d.DEPARTMENT_NAME]));
  const headsForRequesting = getDepartmentHeads(user.DEPARTMENT_ID, usersById, user.EMAIL, user.USER_ID, false);
  // Soft official preview (no involved/optionals) so the form can display mandatory routes and count heads.
  const selections: OfficialSelections = { purchaseRequest: false, recommendingAlternateUserId: '', includePrincipal: false, includeProcurement: false, involvedDepartmentIds: [] };
  let assignments: RfaSectionAssignments = emptyAssignments();
  try {
    assignments = resolveOfficialAssignments(user.DEPARTMENT_ID, selections, 0, user.EMAIL, user.USER_ID, false).assignments;
  } catch { assignments = emptyAssignments(); }
  const departments = all<DepartmentRecord>('DEPARTMENTS').filter((d) => toBoolean(d.ACTIVE));
  const heads = departments.map((d) => {
    const list = getDepartmentHeads(d.DEPARTMENT_ID, usersById, user.EMAIL, user.USER_ID, false);
    const primary = list[0];
    return { departmentId: d.DEPARTMENT_ID, departmentName: d.DEPARTMENT_NAME, headUserId: primary?.USER_ID || '', headName: primary?.FULL_NAME || '', headEmail: primary?.EMAIL || '', headCount: list.length, heads: list.map((h) => ({ userId: h.USER_ID, fullName: h.FULL_NAME, email: h.EMAIL })) };
  });
  // Alternate candidates: active approvers who head at least one other department
  const allHeadIds = new Set<string>();
  for (const d of departments) {
    for (const h of getDepartmentHeads(d.DEPARTMENT_ID, usersById, user.EMAIL, user.USER_ID, false)) allHeadIds.add(h.USER_ID);
  }
  const alternateCandidates = Array.from(allHeadIds).map((id) => usersById.get(id)).filter((u): u is UserRecord => !!u && isValidApprover(u, user.EMAIL, user.USER_ID)).map((u) => toEligible(u, deptNameMap));
  return {
    assignments, heads, departments,
    requestingDepartment: department,
    requestingHeadCount: headsForRequesting.length,
    isAcademic: isAcademicDepartment(department as DepartmentRecord),
    isJhsOrShs: isJhsOrShsDepartment(department as DepartmentRecord),
    presidentThresholdPhp: getThresholdCents() / 100,
    principalName: activeRoles('REVIEWED_AND_NOTED').filter((role) => role.CONDITION === 'JHS_SHS_OPTIONAL').map((role) => resolveRole(role, usersById, (u) => isValidApprover(u, user.EMAIL, user.USER_ID))?.FULL_NAME || '').filter(Boolean).join(', '),
    alternateCandidates
  };
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
  // Reject explicit legacy free selections for the official workflow — assignments are server-resolved.
  if (payload.approvalAssignments && typeof payload.approvalAssignments === 'object') {
    const source = payload.approvalAssignments as Record<string, unknown>;
    const hasAny = Object.values(source).some((v) => Array.isArray(v) && (v as unknown[]).length > 0);
    if (hasAny) businessError('Approvers are assigned automatically from the official matrix. Manual approver selection is not allowed.', 'FORBIDDEN');
  }
  const expenseClassification = validateExpenseClassification(payload.expenseClassification);
  const selections = parseOfficialSelections(payload, department.DEPARTMENT_ID);
  const financial = financialRfaFields(user, { ...payload, dateFiled: new Date(), isBudgetRequest: true, expenseClassification, involvedDepartmentId: selections.involvedDepartmentIds[0] || '', involvedDepartmentIds: selections.involvedDepartmentIds.join(',') }, false) as Pick<RfaRecord, 'IS_BUDGET_REQUEST' | 'EXPENSE_CATEGORY_ID' | 'REQUESTED_AMOUNT' | 'APPROVED_AMOUNT' | 'ACTUAL_AMOUNT' | 'FISCAL_YEAR' | 'ACTUAL_EXPENSE_RECORDED_AT' | 'EXPENSE_CLASSIFICATION' | 'INVOLVED_DEPARTMENT_ID' | 'INVOLVED_DEPARTMENT_NAME' | 'PURCHASE_REQUEST' | 'RECOMMENDING_ALTERNATE_USER_ID' | 'RECOMMENDING_ALTERNATE_NAME' | 'INCLUDE_PRINCIPAL' | 'INCLUDE_PROCUREMENT' | 'INVOLVED_DEPARTMENT_IDS'>;
  // Validate applicabilities softly at draft (strict at submit)
  if (selections.includePrincipal && !isJhsOrShsDepartment(department)) businessError('The JHS/SHS Principal is only available for Junior High School or Senior High School departments.', 'FORBIDDEN');
  const resolved = resolveOfficialAssignments(department.DEPARTMENT_ID, selections, Number(financial.REQUESTED_AMOUNT), user.EMAIL, user.USER_ID, false);
  const timestamp = nowIso();
  const involvedNames = resolved.involvedDepartmentNames.join(', ');
  const record: RfaRecord = {
    RFA_ID: newId('rfa'), RFA_NUMBER: '', DATE_FILED: timestamp.slice(0, 10),
    DEPARTMENT_ID: department.DEPARTMENT_ID, DEPARTMENT_NAME: department.DEPARTMENT_NAME,
    REQUESTED_BY: user.FULL_NAME, REQUESTER_EMAIL: normalizeEmail(user.EMAIL), POSITION: user.POSITION,
    REQUEST_TITLE: String(clean.requestTitle), PURPOSE: String(clean.purpose), BUDGET_ALLOCATION: Number(clean.budgetAllocation),
    TARGET_DATE: String(clean.targetDate), JUSTIFICATION: String(clean.justification), STATUS: 'DRAFT', CURRENT_STEP: '',
    CURRENT_APPROVER_USER_ID: '', CURRENT_APPROVER_EMAIL: '', CURRENT_MATRIX_ID: OFFICIAL_WORKFLOW_MARKER, RESUME_MATRIX_ID: '',
    CREATED_AT: timestamp, UPDATED_AT: timestamp, SUBMITTED_AT: '', COMPLETED_AT: '', VERSION: 1, ...financial,
    EXPENSE_CLASSIFICATION: expenseClassification,
    INVOLVED_DEPARTMENT_ID: selections.involvedDepartmentIds[0] || '',
    INVOLVED_DEPARTMENT_NAME: involvedNames,
    PURCHASE_REQUEST: selections.purchaseRequest,
    RECOMMENDING_ALTERNATE_USER_ID: selections.recommendingAlternateUserId,
    RECOMMENDING_ALTERNATE_NAME: resolved.alternateName,
    INCLUDE_PRINCIPAL: selections.includePrincipal,
    INCLUDE_PROCUREMENT: selections.includeProcurement,
    INVOLVED_DEPARTMENT_IDS: selections.involvedDepartmentIds.join(',')
  };
  insert('RFA', record);
  saveAssignments(record, resolved.assignments, APPROVAL_SECTIONS);
  audit('OPTIONAL_APPROVERS_SELECTED', user, record.RFA_ID, '', '', JSON.stringify({ purchaseRequest: selections.purchaseRequest, involvedDepartmentIds: selections.involvedDepartmentIds, includePrincipal: selections.includePrincipal, includeProcurement: selections.includeProcurement, recommendingAlternateUserId: selections.recommendingAlternateUserId }), { rfaNumber: record.RFA_NUMBER, expenseClassification });
  audit('RFA_CREATED', user, record.RFA_ID, '', 'DRAFT', '', { rfaNumber: record.RFA_NUMBER, expenseClassification });
  return record;
}

export function updateRfa(user: SessionUser, payload: Record<string, unknown>): RfaRecord {
  const rfa = getRfa(String(payload.rfaId ?? ''));
  assertOwnerEditable(user, rfa);
  const clean = validateRfaInput(payload, false);
  if (isOfficialWorkflow(rfa)) {
    if (payload.approvalAssignments && typeof payload.approvalAssignments === 'object') {
      const source = payload.approvalAssignments as Record<string, unknown>;
      if (Object.values(source).some((v) => Array.isArray(v) && (v as unknown[]).length > 0)) businessError('Approvers are assigned automatically from the official matrix. Manual approver selection is not allowed.', 'FORBIDDEN');
    }
    const rawClassification = payload.expenseClassification !== undefined ? payload.expenseClassification : rfa.EXPENSE_CLASSIFICATION;
    const expenseClassification = validateExpenseClassification(rawClassification);
    const previous = officialSelectionsFromRfa(rfa);
    const selections: OfficialSelections = {
      purchaseRequest: payload.purchaseRequest !== undefined ? toBoolean(payload.purchaseRequest) : previous.purchaseRequest,
      recommendingAlternateUserId: payload.recommendingAlternateUserId !== undefined ? String(payload.recommendingAlternateUserId || '') : previous.recommendingAlternateUserId,
      includePrincipal: payload.includePrincipal !== undefined ? toBoolean(payload.includePrincipal) : previous.includePrincipal,
      includeProcurement: payload.includeProcurement !== undefined ? toBoolean(payload.includeProcurement) : previous.includeProcurement,
      involvedDepartmentIds: payload.involvedDepartmentIds !== undefined || payload.involvedDepartmentId !== undefined ? parseInvolvedDepartmentIds(payload) : previous.involvedDepartmentIds
    };
    if (selections.includePrincipal) {
      const dept = findBy<DepartmentRecord>('DEPARTMENTS', 'DEPARTMENT_ID', rfa.DEPARTMENT_ID);
      if (!isJhsOrShsDepartment(dept)) businessError('The JHS/SHS Principal is only available for Junior High School or Senior High School departments.', 'FORBIDDEN');
    }
    const financial = financialRfaFields(user, { ...payload, dateFiled: rfa.DATE_FILED || new Date(), isBudgetRequest: true, expenseClassification, involvedDepartmentId: selections.involvedDepartmentIds[0] || '', involvedDepartmentIds: selections.involvedDepartmentIds.join(',') }, false);
    const resolved = resolveOfficialAssignments(rfa.DEPARTMENT_ID, selections, Number(financial.REQUESTED_AMOUNT), rfa.REQUESTER_EMAIL, user.USER_ID, false);
    const updates = {
      REQUEST_TITLE: clean.requestTitle, PURPOSE: clean.purpose, BUDGET_ALLOCATION: clean.budgetAllocation,
      TARGET_DATE: clean.targetDate, JUSTIFICATION: clean.justification,
      UPDATED_AT: nowIso(), VERSION: Number(rfa.VERSION) + 1, ...financial,
      EXPENSE_CLASSIFICATION: expenseClassification,
      INVOLVED_DEPARTMENT_ID: selections.involvedDepartmentIds[0] || '',
      INVOLVED_DEPARTMENT_NAME: resolved.involvedDepartmentNames.join(', '),
      PURCHASE_REQUEST: selections.purchaseRequest,
      RECOMMENDING_ALTERNATE_USER_ID: selections.recommendingAlternateUserId,
      RECOMMENDING_ALTERNATE_NAME: resolved.alternateName,
      INCLUDE_PRINCIPAL: selections.includePrincipal,
      INCLUDE_PROCUREMENT: selections.includeProcurement,
      INVOLVED_DEPARTMENT_IDS: selections.involvedDepartmentIds.join(',')
    };
    updateBy('RFA', 'RFA_ID', rfa.RFA_ID, updates);
    const updated = { ...rfa, ...updates } as RfaRecord;
    saveAssignments(updated, resolved.assignments, APPROVAL_SECTIONS);
    audit('OPTIONAL_APPROVERS_SELECTED', user, rfa.RFA_ID, '', '', JSON.stringify(selections), {});
    audit('RFA_UPDATED', user, rfa.RFA_ID, rfa.STATUS, rfa.STATUS);
    return updated;
  }
  // Fixed workflow (V2 historical): classification + involved fields are updatable; assignments re-resolve from matrix.
  if (isFixedWorkflow(rfa) || isAssignmentWorkflow(rfa)) {
    if (payload.approvalAssignments && typeof payload.approvalAssignments === 'object' && isFixedWorkflow(rfa)) {
      const source = payload.approvalAssignments as Record<string, unknown>;
      const hasAny = Object.values(source).some((v) => Array.isArray(v) && (v as unknown[]).length > 0);
      if (hasAny) businessError('Approvers are assigned automatically. Manual approver selection is not allowed.', 'FORBIDDEN');
    }
    const rawClassification = payload.expenseClassification !== undefined ? payload.expenseClassification : rfa.EXPENSE_CLASSIFICATION;
    const expenseClassification = rfa.EXPENSE_CLASSIFICATION || String(rawClassification || '').trim()
      ? validateExpenseClassification(rawClassification)
      : '';
    const { hasInvolved, involvedDepartmentId } = validateInvolvedChoice({
      hasInvolvedDepartment: payload.hasInvolvedDepartment !== undefined ? payload.hasInvolvedDepartment : Boolean(rfa.INVOLVED_DEPARTMENT_ID),
      involvedDepartmentId: payload.involvedDepartmentId !== undefined ? payload.involvedDepartmentId : rfa.INVOLVED_DEPARTMENT_ID
    }, rfa.DEPARTMENT_ID);
    const notedByNa = payload.notedByNotApplicable !== undefined ? payload.notedByNotApplicable === true : notedByNotApplicable(auditRows(rfa.RFA_ID));
    const financial = financialRfaFields(user, { ...payload, isBudgetRequest: true, expenseClassification, involvedDepartmentId }, false);
    const resolved = isFixedWorkflow(rfa)
      ? resolveFixedAssignments(rfa.DEPARTMENT_ID, hasInvolved ? involvedDepartmentId : '', notedByNa, rfa.REQUESTER_EMAIL, user.USER_ID, false)
      : null;
    const updates = {
      REQUEST_TITLE: clean.requestTitle, PURPOSE: clean.purpose, BUDGET_ALLOCATION: clean.budgetAllocation,
      TARGET_DATE: clean.targetDate, JUSTIFICATION: clean.justification,
      UPDATED_AT: nowIso(), VERSION: Number(rfa.VERSION) + 1, ...financial,
      EXPENSE_CLASSIFICATION: expenseClassification,
      INVOLVED_DEPARTMENT_ID: hasInvolved ? involvedDepartmentId : '',
      INVOLVED_DEPARTMENT_NAME: resolved ? resolved.involvedDepartmentName : (hasInvolved ? (findBy<DepartmentRecord>('DEPARTMENTS', 'DEPARTMENT_ID', involvedDepartmentId)?.DEPARTMENT_NAME || '') : '')
    };
    updateBy('RFA', 'RFA_ID', rfa.RFA_ID, updates);
    const updated = { ...rfa, ...updates } as RfaRecord;
    if (isFixedWorkflow(rfa) && resolved) {
      saveAssignments(updated, resolved.assignments, V2_APPROVAL_SECTIONS);
      audit('NOTED_BY_SELECTION', user, rfa.RFA_ID, '', '', notedByNa ? 'N/A' : 'Fixed department assignment');
    } else if (Object.prototype.hasOwnProperty.call(payload, 'approvalAssignments') && isLegacyAssignmentWorkflow(rfa)) {
      const assignments = parseAssignments(user, payload.approvalAssignments);
      const legacyNoted = validateNotedByChoice(payload, assignments);
      saveAssignments(updated, assignments, LEGACY_APPROVAL_SECTIONS);
      audit('NOTED_BY_SELECTION', user, rfa.RFA_ID, '', '', legacyNoted ? 'N/A' : 'Approvers / empty');
    }
    audit('RFA_UPDATED', user, rfa.RFA_ID, rfa.STATUS, rfa.STATUS);
    return updated;
  }
  // Legacy Approval-Matrix RFAs: retain original route, cannot be converted.
  const financial = financialRfaFields(user, { ...payload, isBudgetRequest: toBoolean(rfa.IS_BUDGET_REQUEST) }, false);
  const usesAssignments = Object.prototype.hasOwnProperty.call(payload, 'approvalAssignments');
  if (usesAssignments) businessError('Legacy RFAs retain their original Approval Matrix route and cannot be converted.', 'FORBIDDEN');
  const updates = {
    REQUEST_TITLE: clean.requestTitle, PURPOSE: clean.purpose, BUDGET_ALLOCATION: clean.budgetAllocation,
    TARGET_DATE: clean.targetDate, JUSTIFICATION: clean.justification, UPDATED_AT: nowIso(), VERSION: Number(rfa.VERSION) + 1, ...financial
  };
  updateBy('RFA', 'RFA_ID', rfa.RFA_ID, updates);
  const updated = { ...rfa, ...updates } as RfaRecord;
  audit('RFA_UPDATED', user, rfa.RFA_ID, rfa.STATUS, rfa.STATUS);
  return updated;
}

export function submitRfa(user: SessionUser, rfaId: string, resubmit = false): RfaRecord {
  const rfa = getRfa(rfaId);
  assertOwnerEditable(user, rfa);
  if (resubmit && rfa.STATUS !== 'RETURNED') businessError('Only a returned RFA can be resubmitted.');
  if (!resubmit && rfa.STATUS !== 'DRAFT') businessError('Only a draft RFA can be submitted.');
  validateRfaInput({ requestTitle: rfa.REQUEST_TITLE, purpose: rfa.PURPOSE, budgetAllocation: rfa.BUDGET_ALLOCATION, targetDate: rfa.TARGET_DATE, justification: rfa.JUSTIFICATION }, true);
  if (toBoolean(rfa.IS_BUDGET_REQUEST)) financialRfaFields(user, { isBudgetRequest: true, fiscalYear: rfa.FISCAL_YEAR, expenseCategoryId: rfa.EXPENSE_CATEGORY_ID, requestedAmount: Number(rfa.REQUESTED_AMOUNT) / 100, expenseClassification: rfa.EXPENSE_CLASSIFICATION }, true);
  // Official workflow requires OPEX/CAPEX + strict official assignments at submit time.
  if (isOfficialWorkflow(rfa)) {
    validateExpenseClassification(rfa.EXPENSE_CLASSIFICATION);
    const requestedCents = Number(rfa.REQUESTED_AMOUNT || 0);
    if (!Number.isSafeInteger(requestedCents) || requestedCents <= 0) businessError('Requested amount must be greater than zero.');
    const rejectedAssignments = approvalRows(rfa.RFA_ID).filter((row) => row.ACTION === 'RETURNED' || row.ACTION === 'DISAPPROVED');
    void rejectedAssignments;
    const selections = officialSelectionsFromRfa(rfa);
    const resolved = resolveOfficialAssignments(rfa.DEPARTMENT_ID, selections, Number(rfa.REQUESTED_AMOUNT), rfa.REQUESTER_EMAIL, user.USER_ID, true);
    assignNumberOnSubmit(rfa);
    saveAssignments(rfa, resolved.assignments, APPROVAL_SECTIONS);
    audit('OPTIONAL_APPROVERS_RESOLVED', user, rfa.RFA_ID, '', '', JSON.stringify({ ...selections, isAcademic: isAcademicDepartment(findBy<DepartmentRecord>('DEPARTMENTS', 'DEPARTMENT_ID', rfa.DEPARTMENT_ID) as DepartmentRecord), thresholdPhp: getThresholdCents() / 100, amountPhp: Number(rfa.REQUESTED_AMOUNT) / 100, needsPresident: Number(rfa.REQUESTED_AMOUNT) >= getThresholdCents() }), {});
  }
  if (isFixedWorkflow(rfa)) {
    validateExpenseClassification(rfa.EXPENSE_CLASSIFICATION);
    const notedByNa = notedByNotApplicable(auditRows(rfa.RFA_ID));
    const resolved = resolveFixedAssignments(rfa.DEPARTMENT_ID, String(rfa.INVOLVED_DEPARTMENT_ID || ''), notedByNa, rfa.REQUESTER_EMAIL, user.USER_ID, true);
    assignNumberOnSubmit(rfa);
    saveAssignments(rfa, resolved.assignments, V2_APPROVAL_SECTIONS);
  }
  assignNumberOnSubmit(rfa);

  const previous = rfa.STATUS;
  const timestamp = nowIso();
  const updates = { STATUS: 'SUBMITTED', SUBMITTED_AT: timestamp, UPDATED_AT: timestamp, VERSION: Number(rfa.VERSION) + 1 };
  updateBy('RFA', 'RFA_ID', rfa.RFA_ID, updates);
  const submitted = { ...rfa, ...updates } as RfaRecord;

  // Append PREPARED_BY approval (only for new submissions, not resubmits)
  if (!resubmit) appendApproval(submitted, 'PREPARED_BY', user, 'APPROVED', 'Submitted electronically by requester.');

  audit(resubmit ? 'RESUBMITTED' : 'RFA_SUBMITTED', user, rfa.RFA_ID, previous, 'SUBMITTED');
  if (toBoolean(rfa.IS_BUDGET_REQUEST)) audit('FINANCIAL_RFA_SUBMITTED', user, rfa.RFA_ID, previous, 'SUBMITTED', '', { fiscalYear: rfa.FISCAL_YEAR, requestedAmountCentavos: rfa.REQUESTED_AMOUNT });
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
  if (assignmentSection === 'INVOLVED_DEPARTMENT_HEAD') {
    const involvedId = String(rfa.INVOLVED_DEPARTMENT_ID || '');
    if (!involvedId) businessError('This RFA has no involved department.', 'FORBIDDEN');
    const involved = findBy<DepartmentRecord>('DEPARTMENTS', 'DEPARTMENT_ID', involvedId);
    const headId = involved ? String((involved as unknown as Record<string, unknown>).DEPARTMENT_HEAD_USER_ID || '') : '';
    const matrixAssigned = getAssignmentsBySection(rfa.RFA_ID, 'INVOLVED_DEPARTMENT_HEAD').some((row) => String(row.APPROVER_USER_ID) === user.USER_ID);
    if (!matrixAssigned && headId !== user.USER_ID) businessError('Only the involved department head may approve this assignment.', 'FORBIDDEN');
  }
  if (isAssignmentWorkflow(rfa) && assignmentSection && getApprovedAssignments(rfa, assignmentSection).some((row) => String(row.APPROVER_USER_ID) === user.USER_ID)) businessError('You have already acted on this RFA section.', 'CONFLICT');
  if (notYetApprovedByTurn(rfa, user.USER_ID)) businessError('This RFA is not yet your turn: an earlier Approved By official must approve first. You will be emailed when it is.', 'FORBIDDEN');
  const emailTierBefore = isAssignmentWorkflow(rfa) && assignmentSection === 'APPROVED_BY' ? approvedByCurrentEmailTier(rfa).tier : -1;
  if (action !== 'APPROVED' && remarks.trim().length < 3) businessError('A reason is required for return or disapproval.');
  appendApproval(rfa, rfa.CURRENT_STEP, user, action, remarks.trim());
  const previous = rfa.STATUS;

  if (action === 'RETURNED') {
    const marker = markerFor(rfa);
    const updates = { STATUS: 'RETURNED', RESUME_MATRIX_ID: isAssignmentWorkflow(rfa) ? '' : rfa.CURRENT_MATRIX_ID, CURRENT_APPROVER_USER_ID: '', CURRENT_APPROVER_EMAIL: '', CURRENT_MATRIX_ID: isAssignmentWorkflow(rfa) ? marker : '', UPDATED_AT: nowIso(), VERSION: Number(rfa.VERSION) + 1 };
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
    const sections = sectionsForRfa(rfa);
    const assignedCounts = sections.reduce((counts, section) => ({ ...counts, [section]: getAssignmentsBySection(rfa.RFA_ID, section).length }), {} as Record<string, number>);
    const approvedCounts = sections.reduce((counts, section) => ({ ...counts, [section]: getApprovedAssignments(rfa, section).length }), {} as Record<string, number>);
    // All stages are AND: every assigned approver (including every recommending head) must approve.
    const next = nextAssignedStageAfterAction(assignedCounts, approvedCounts, sections.indexOf(assignmentSection), sections);
    if (next === assignmentSection) {
      // Approved By email order: once a tier finishes (AVP for Finance, then the VPs), email the next one.
      if (assignmentSection === 'APPROVED_BY' && approvedByCurrentEmailTier(rfa).tier !== emailTierBefore) notifyAssignedStage(rfa, user, assignmentSection);
      return rfa;
    }
    return routeAssigned(rfa, user, sections.indexOf(assignmentSection) + 1);
  }
  const matrix = orderedMatrix(all<MatrixRecord>('APPROVAL_MATRIX').filter((row) => row.DEPARTMENT_ID === rfa.DEPARTMENT_ID));
  const currentIndex = matrix.findIndex((row) => row.MATRIX_ID === rfa.CURRENT_MATRIX_ID);
  if (matrix.slice(currentIndex + 1).length) return routeLegacy(rfa, user, currentIndex + 1);
  const financial = commitApprovedFinancialRfa(rfa, user);
  const updates = { STATUS: 'APPROVED', CURRENT_STEP: 'APPROVED_BY', CURRENT_APPROVER_USER_ID: '', CURRENT_APPROVER_EMAIL: '', CURRENT_MATRIX_ID: '', COMPLETED_AT: nowIso(), UPDATED_AT: nowIso(), VERSION: Number(rfa.VERSION) + 1, ...(financial || {}) };
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

export function saveActualExpense(user: SessionUser, rfaId: string, payload: Record<string, unknown>): Record<string, unknown> {
  const rfa = getRfa(rfaId);
  return recordActualExpense(user, rfa, payload);
}

/** "My RFAs": only the requests this user filed — for every role, including administrators. */
export function listRfas(user: SessionUser, filters: Record<string, unknown>, _approvals?: SheetRecord[], records?: RfaRecord[]): RfaRecord[] {
  const email = normalizeEmail(user.EMAIL);
  const schoolYear = Number(filters.schoolYear || 0);
  const source = schoolYear ? archivedRows<RfaRecord>(schoolYear, 'RFA') : (records ?? all<RfaRecord>('RFA'));
  return filterRfas(source.filter((rfa) => normalizeEmail(rfa.REQUESTER_EMAIL) === email), filters);
}

/** "All RFAs": the institution-wide register, limited by allRfasScope(). */
export function listAllRfas(user: SessionUser, filters: Record<string, unknown>): RfaRecord[] {
  const scope = allRfasScope(user);
  if (scope === 'none') businessError('You do not have access to the All RFAs register.', 'FORBIDDEN');
  const schoolYear = Number(filters.schoolYear || 0);
  const source = schoolYear ? archivedRows<RfaRecord>(schoolYear, 'RFA') : all<RfaRecord>('RFA');
  const records = source.filter((rfa) => rfa.STATUS !== 'DRAFT' && (scope === 'all' || APPROVED_STATUSES.includes(rfa.STATUS)));
  return filterRfas(records, filters);
}

function filterRfas(records: RfaRecord[], filters: Record<string, unknown>): RfaRecord[] {
  const query = String(filters.query ?? '').trim().toLowerCase();
  const status = String(filters.status ?? '');
  const departmentId = String(filters.departmentId ?? '');
  const currentStep = String(filters.currentStep ?? '');
  const expenseClassification = String(filters.expenseClassification ?? '').trim().toUpperCase();
  const fiscalYear = String(filters.fiscalYear ?? '').trim();
  const involvedDepartmentId = String(filters.involvedDepartmentId ?? '').trim();
  const fromDate = String(filters.fromDate ?? '').trim();
  const toDate = String(filters.toDate ?? '').trim();
  return records.filter((rfa) => {
    if (status && rfa.STATUS !== status) return false;
    if (departmentId && rfa.DEPARTMENT_ID !== departmentId) return false;
    if (currentStep && rfa.CURRENT_STEP !== currentStep) return false;
    if (expenseClassification && String(rfa.EXPENSE_CLASSIFICATION || '').toUpperCase() !== expenseClassification) return false;
    if (fiscalYear && String(rfa.FISCAL_YEAR) !== fiscalYear) return false;
    if (involvedDepartmentId && String(rfa.INVOLVED_DEPARTMENT_ID || '') !== involvedDepartmentId) return false;
    const dateValue = String(rfa.DATE_FILED || '').slice(0, 10);
    if (fromDate && dateValue < fromDate) return false;
    if (toDate && dateValue > toDate) return false;
    if (query && ![rfa.RFA_NUMBER, rfa.REQUEST_TITLE, rfa.REQUESTED_BY, rfa.DEPARTMENT_NAME, rfa.EXPENSE_CLASSIFICATION, rfa.INVOLVED_DEPARTMENT_NAME].some((value) => String(value).toLowerCase().includes(query))) return false;
    return true;
  }).sort((a, b) => String(b.UPDATED_AT).localeCompare(String(a.UPDATED_AT)));
}

export function listForApproval(user: SessionUser, approvals?: SheetRecord[], records?: RfaRecord[]): RfaRecord[] {
  if (!toBoolean(user.CAN_APPROVE_RFA)) return [];
  const assigned = new Set<string>();
  const approvedAt = new Map<string, string[]>();
  for (const row of approvals ?? all<SheetRecord>('RFA_APPROVALS')) {
    if (String(row.APPROVER_USER_ID) !== user.USER_ID) continue;
    const key = `${row.RFA_ID}:${row.STEP}`;
    if (row.ACTION === '') assigned.add(key);
    if (row.ACTION === 'APPROVED') {
      const timestamps = approvedAt.get(key) || [];
      timestamps.push(String(row.TIMESTAMP || ''));
      approvedAt.set(key, timestamps);
    }
  }
  return (records ?? all<RfaRecord>('RFA')).filter((rfa) => {
    if (isAssignmentWorkflow(rfa)) {
      const section = currentAssignmentSection(rfa);
      if (!section) return false;
      const key = `${rfa.RFA_ID}:${section}`;
      if (!assigned.has(key)) return false;
      const submittedAt = Date.parse(String(rfa.SUBMITTED_AT || ''));
      if ((approvedAt.get(key) || []).some((timestamp) => !Number.isFinite(submittedAt) || Date.parse(timestamp) >= submittedAt)) return false;
      return !notYetApprovedByTurn(rfa, user.USER_ID);
    }
    return normalizeEmail(rfa.CURRENT_APPROVER_EMAIL) === normalizeEmail(user.EMAIL);
  });
}

export function dashboardRfas(user: SessionUser): { rfas: RfaRecord[]; approvals: RfaRecord[] } {
  const approvals = toBoolean(user.IS_ADMIN) && !toBoolean(user.CAN_APPROVE_RFA) ? [] : all<SheetRecord>('RFA_APPROVALS');
  const records = all<RfaRecord>('RFA');
  return { rfas: listRfas(user, {}, approvals, records), approvals: listForApproval(user, approvals, records) };
}

/** Read-only view of an RFA that was moved to a school-year archive. */
function archivedDetail(user: SessionUser, rfaId: string, schoolYearHint: number): Record<string, unknown> {
  const found = findArchivedRfa(rfaId, schoolYearHint);
  if (!found) businessError('RFA was not found.', 'NOT_FOUND');
  const { schoolYear, rfa } = found;
  const approvals = archivedRows<SheetRecord>(schoolYear, 'RFA_APPROVALS').filter((row) => row.RFA_ID === rfaId);
  const history = archivedRows<SheetRecord>(schoolYear, 'RFA_AUDIT').filter((row) => row.RFA_ID === rfaId);
  assertView(user, rfa, approvals);
  return {
    rfa,
    approvals,
    attachments: archivedRows<SheetRecord>(schoolYear, 'RFA_ATTACHMENTS').filter((row) => row.RFA_ID === rfaId).map(({ DRIVE_FILE_ID: _hidden, ...attachment }) => attachment),
    audit: history.map(({ METADATA_JSON: _metadata, ...entry }) => entry),
    notedByNotApplicable: notedByNotApplicable(history),
    approvedByOrder: {},
    financial: financialDetail(rfa),
    archived: { schoolYear, label: schoolYearLabel(schoolYear) },
    permissions: { canEdit: false, canDecide: false, canImplement: false, canClose: false, canRecordActualExpense: false }
  };
}

export function detailRfa(user: SessionUser, rfaId: string, schoolYearHint = 0): Record<string, unknown> {
  if (!findBy<RfaRecord>('RFA', 'RFA_ID', rfaId)) return archivedDetail(user, rfaId, schoolYearHint);
  const rfa = getRfa(rfaId);
  const approvals = approvalRows(rfaId);
  const history = auditRows(rfaId);
  assertView(user, rfa, approvals);
  const section = currentAssignmentSection(rfa);
  const submittedAt = Date.parse(String(rfa.SUBMITTED_AT || ''));
  const isCurrentSectionHead = isAssignmentWorkflow(rfa) && section
    ? approvals.some((row) => row.STEP === section && row.ACTION === '' && String(row.APPROVER_USER_ID) === user.USER_ID)
      && !approvals.some((row) => row.STEP === section && row.ACTION === 'APPROVED' && String(row.APPROVER_USER_ID) === user.USER_ID && (!Number.isFinite(submittedAt) || Date.parse(String(row.TIMESTAMP || '')) >= submittedAt))
    : normalizeEmail(rfa.CURRENT_APPROVER_EMAIL) === normalizeEmail(user.EMAIL);
  // canEdit: requester or admin, and RFA is in DRAFT or RETURNED status
  const canEdit = (normalizeEmail(rfa.REQUESTER_EMAIL) === normalizeEmail(user.EMAIL) || toBoolean(user.IS_ADMIN)) && ['DRAFT', 'RETURNED'].includes(rfa.STATUS);
  // An administrator may view any RFA but can decide only when explicitly assigned.
  const canDecide = isCurrentSectionHead && !notYetApprovedByTurn(rfa, user.USER_ID) && normalizeEmail(rfa.REQUESTER_EMAIL) !== normalizeEmail(user.EMAIL) && toBoolean(user.CAN_APPROVE_RFA);
  const canImplement = (toBoolean(user.CAN_IMPLEMENT_RFA) || toBoolean(user.IS_ADMIN)) && rfa.STATUS === 'APPROVED';
  const canClose = (toBoolean(user.CAN_IMPLEMENT_RFA) || toBoolean(user.IS_ADMIN)) && ['APPROVED', 'IMPLEMENTATION'].includes(rfa.STATUS);

  return {
    rfa,
    approvals,
    attachments: attachmentRows(rfaId).map(({ DRIVE_FILE_ID: _hidden, ...attachment }) => attachment),
    audit: history.map(({ METADATA_JSON: _metadata, ...entry }) => entry),
    notedByNotApplicable: notedByNotApplicable(history),
    // Approved By email order per approver user ID: 0 = AVP for Finance, 1 = VPs, 2 = President.
    approvedByOrder: Object.fromEntries(approvals.filter((row) => row.STEP === 'APPROVED_BY' && row.ACTION === '').map((row) => [String(row.APPROVER_USER_ID), approvedByEmailTier(row)])),
    financial: financialDetail(rfa),
    permissions: {
      canEdit,
      canDecide,
      canImplement,
      canClose,
      canRecordActualExpense: false
    }
  };
}

function rfaFolder(rfa: RfaRecord): GoogleAppsScript.Drive.Folder {
  const rootId = getSetting('ATTACHMENT_ROOT_FOLDER_ID');
  if (!rootId) businessError('Attachment storage is not configured. Run setupDatabase().', 'CONFIGURATION_REQUIRED');
  const folderName = rfa.RFA_NUMBER || draftFolderName(rfa);
  const cacheKey = `rfa:${folderName}`;
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
  const rfaFolders = yearFolder.getFoldersByName(folderName);
  const folder = rfaFolders.hasNext() ? rfaFolders.next() : yearFolder.createFolder(folderName);
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
  let attachment = findBy<SheetRecord>('RFA_ATTACHMENTS', 'ATTACHMENT_ID', attachmentId);
  if (attachment) assertView(user, getRfa(String(attachment.RFA_ID)));
  else {
    const archived = findArchivedAttachment(attachmentId);
    if (!archived) businessError('Attachment was not found.', 'NOT_FOUND');
    attachment = archived.attachment;
    const found = findArchivedRfa(String(attachment.RFA_ID), archived.schoolYear);
    if (!found) businessError('Attachment was not found.', 'NOT_FOUND');
    assertView(user, found.rfa, archivedRows<SheetRecord>(found.schoolYear, 'RFA_APPROVALS').filter((row) => row.RFA_ID === found.rfa.RFA_ID));
  }
  const blob = DriveApp.getFileById(String(attachment.DRIVE_FILE_ID)).getBlob();
  return { fileName: attachment.FILE_NAME, mimeType: attachment.MIME_TYPE, base64: Utilities.base64Encode(blob.getBytes()) };
}
