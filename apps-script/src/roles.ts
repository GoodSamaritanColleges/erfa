import { SHEETS } from './constants';
import { normalizeEmail, toBoolean } from './core';
import { all, getDatabase, getSetting, nowIso, setSetting } from './store';
import type { SheetRecord, UserRecord } from './types';

/**
 * Configurable approval roles. Each role is a row in the ROLES sheet:
 *  - TITLE        what the role is called (e.g. "VP for Admin and Finance")
 *  - STAGE        REVIEWED_AND_NOTED or APPROVED_BY
 *  - CONDITION    ALWAYS | ACADEMIC (academic departments) | AT_OR_ABOVE_THRESHOLD (President rule)
 *                 | JHS_SHS_OPTIONAL (added when a JHS/SHS request asks for it)
 *  - EMAIL_ORDER  Approved By email order: 0 first, 1 middle, 2 last
 *  - ALL_RFAS_ACCESS  whether the holder sees the All RFAs register
 *  - USER_ID      the person holding the role (change it any time)
 *  - ACTIVE       switch a role off without deleting it
 * Until an administrator saves roles, the six original roles are used, filled from the older
 * settings, so routing is exactly what it was.
 */
export type RoleStage = 'REVIEWED_AND_NOTED' | 'APPROVED_BY';
export type RoleCondition = 'ALWAYS' | 'ACADEMIC' | 'AT_OR_ABOVE_THRESHOLD' | 'JHS_SHS_OPTIONAL';
export const ROLE_STAGES: RoleStage[] = ['REVIEWED_AND_NOTED', 'APPROVED_BY'];
export const ROLE_CONDITIONS: RoleCondition[] = ['ALWAYS', 'ACADEMIC', 'AT_OR_ABOVE_THRESHOLD', 'JHS_SHS_OPTIONAL'];

export interface ApprovalRole {
  ROLE_ID: string; TITLE: string; STAGE: RoleStage; CONDITION: RoleCondition;
  EMAIL_ORDER: number; ALL_RFAS_ACCESS: boolean; USER_ID: string; ACTIVE: boolean; SORT: number;
}

interface Legacy { key: string; index?: number; name: string; emailKey?: string; email?: string; exactName?: boolean }
type DefaultRole = Omit<ApprovalRole, 'USER_ID'> & { legacy: Legacy };

const DEFAULT_ROLES: DefaultRole[] = [
  { ROLE_ID: 'REVIEWED', TITLE: 'Reviewed and Noted By', STAGE: 'REVIEWED_AND_NOTED', CONDITION: 'ALWAYS', EMAIL_ORDER: 1, ALL_RFAS_ACCESS: true, ACTIVE: true, SORT: 10, legacy: { key: 'REVIEWED_MANDATORY_USER_ID', name: 'Ofelia Hocson' } },
  { ROLE_ID: 'APPROVED_FIRST', TITLE: 'AVP for Finance', STAGE: 'APPROVED_BY', CONDITION: 'ALWAYS', EMAIL_ORDER: 0, ALL_RFAS_ACCESS: true, ACTIVE: true, SORT: 20, legacy: { key: 'APPROVED_MANDATORY_USER_IDS', index: 0, name: 'Ana Liza Tago' } },
  { ROLE_ID: 'VP_FINANCE', TITLE: 'VP for Admin and Finance', STAGE: 'APPROVED_BY', CONDITION: 'ALWAYS', EMAIL_ORDER: 1, ALL_RFAS_ACCESS: true, ACTIVE: true, SORT: 30, legacy: { key: 'APPROVED_MANDATORY_USER_IDS', index: 1, name: 'Raquel Baquiran', emailKey: 'VP_ADMIN_FINANCE_EMAIL', email: 'vp.finance@example.edu', exactName: true } },
  { ROLE_ID: 'VP_ACADEMIC', TITLE: 'VP for Academic Affairs', STAGE: 'APPROVED_BY', CONDITION: 'ACADEMIC', EMAIL_ORDER: 1, ALL_RFAS_ACCESS: true, ACTIVE: true, SORT: 40, legacy: { key: 'VP_ACADEMIC_USER_ID', name: 'Jennelyn De Guzman' } },
  { ROLE_ID: 'PRESIDENT', TITLE: 'President', STAGE: 'APPROVED_BY', CONDITION: 'AT_OR_ABOVE_THRESHOLD', EMAIL_ORDER: 2, ALL_RFAS_ACCESS: true, ACTIVE: true, SORT: 50, legacy: { key: 'PRESIDENT_USER_ID', name: 'Alessandra De Guzman-Valino', emailKey: 'PRESIDENT_EMAIL', email: 'president@example.edu', exactName: true } },
  { ROLE_ID: 'PRINCIPAL', TITLE: 'JHS/SHS Principal', STAGE: 'REVIEWED_AND_NOTED', CONDITION: 'JHS_SHS_OPTIONAL', EMAIL_ORDER: 1, ALL_RFAS_ACCESS: false, ACTIVE: true, SORT: 60, legacy: { key: 'PRINCIPAL_USER_ID', name: 'Noliver Garcia' } }
];
const legacyById = new Map(DEFAULT_ROLES.map((role) => [role.ROLE_ID, role.legacy]));

function legacySettingId(legacy: Legacy): string {
  const raw = String(getSetting(legacy.key) || '');
  return legacy.index === undefined ? raw.trim() : (raw.split(',')[legacy.index] || '').trim();
}

function asRole(row: SheetRecord): ApprovalRole {
  const stage = ROLE_STAGES.includes(String(row.STAGE) as RoleStage) ? String(row.STAGE) as RoleStage : 'APPROVED_BY';
  const condition = ROLE_CONDITIONS.includes(String(row.CONDITION) as RoleCondition) ? String(row.CONDITION) as RoleCondition : 'ALWAYS';
  return {
    ROLE_ID: String(row.ROLE_ID), TITLE: String(row.TITLE || row.ROLE_ID), STAGE: stage, CONDITION: condition,
    EMAIL_ORDER: Math.max(0, Math.min(2, Number(row.EMAIL_ORDER ?? 1) || 0)), ALL_RFAS_ACCESS: toBoolean(row.ALL_RFAS_ACCESS),
    USER_ID: String(row.USER_ID || '').trim(), ACTIVE: toBoolean(row.ACTIVE), SORT: Number(row.SORT || 0)
  };
}

/** The six original roles filled from the older settings, plus any extra Approved By IDs. */
function seededRoles(): ApprovalRole[] {
  const roles: ApprovalRole[] = DEFAULT_ROLES.map(({ legacy, ...role }) => ({ ...role, USER_ID: legacySettingId(legacy) }));
  String(getSetting('APPROVED_MANDATORY_USER_IDS') || '').split(',').map((v) => v.trim()).filter(Boolean).slice(2).forEach((id, index) => {
    roles.push({ ROLE_ID: `APPROVED_EXTRA_${index + 1}`, TITLE: `Approved By official ${index + 3}`, STAGE: 'APPROVED_BY', CONDITION: 'ALWAYS', EMAIL_ORDER: 1, ALL_RFAS_ACCESS: true, USER_ID: id, ACTIVE: true, SORT: 35 + index });
  });
  return roles;
}

/** All roles (active and inactive), in display order. */
export function loadRoles(): ApprovalRole[] {
  let rows: SheetRecord[] = [];
  try { rows = all<SheetRecord>('ROLES').filter((row) => String(row.ROLE_ID || '')); } catch { rows = []; }
  const roles = rows.length ? rows.map(asRole) : seededRoles();
  return roles.sort((a, b) => a.SORT - b.SORT || a.TITLE.localeCompare(b.TITLE));
}

export function activeRoles(stage?: RoleStage, condition?: RoleCondition): ApprovalRole[] {
  return loadRoles().filter((role) => role.ACTIVE && (!stage || role.STAGE === stage) && (!condition || role.CONDITION === condition));
}

function nameMatches(candidate: string, fullName: string): boolean {
  const name = candidate.trim().toLowerCase();
  const parts = fullName.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return parts.length >= 2 && name.includes(parts[0]) && name.includes(parts[parts.length - 1]);
}

function legacyEmail(legacy: Legacy): string {
  return normalizeEmail(String((legacy.emailKey && getSetting(legacy.emailKey)) || legacy.email || ''));
}

/** Only for the six original roles while no person is assigned: matches the person who held it before. */
function isLegacyHolder(role: ApprovalRole, person: { name: string; email: string }): boolean {
  const legacy = legacyById.get(role.ROLE_ID);
  if (!legacy) return false;
  const email = legacyEmail(legacy);
  if (email && normalizeEmail(person.email) === email) return true;
  return legacy.exactName ? person.name.trim().toLowerCase() === legacy.name.toLowerCase() : nameMatches(person.name, legacy.name);
}

/** True when this person holds the role (by user ID; by the original holder only while unassigned). */
export function holdsRole(role: ApprovalRole, person: { id: string; name: string; email: string }): boolean {
  if (role.USER_ID) return person.id === role.USER_ID;
  return isLegacyHolder(role, person);
}

/** The user who holds the role and may approve this request, or undefined. */
export function resolveRole(role: ApprovalRole, usersById: Map<string, UserRecord>, canApprove: (user: UserRecord) => boolean): UserRecord | undefined {
  if (role.USER_ID) {
    const assigned = usersById.get(role.USER_ID);
    return assigned && canApprove(assigned) ? assigned : undefined;
  }
  const legacy = legacyById.get(role.ROLE_ID);
  if (!legacy) return undefined;
  const candidates = [...usersById.values()].filter(canApprove);
  const email = legacyEmail(legacy);
  const byEmail = email ? candidates.find((u) => normalizeEmail(u.EMAIL) === email) : undefined;
  if (byEmail) return byEmail;
  const exact = candidates.find((u) => String(u.FULL_NAME || '').trim().toLowerCase() === legacy.name.toLowerCase());
  if (exact || legacy.exactName) return exact;
  return candidates.find((u) => nameMatches(String(u.FULL_NAME || ''), legacy.name));
}

/**
 * Someone listed in the Approval Matrix only because of an official role they no longer have:
 * the role was given to a different person, or switched off. Such matrix entries are skipped,
 * so changes made in Approval roles take effect everywhere. Other department-specific matrix
 * approvers are kept.
 */
export function isReplacedOfficial(user: UserRecord): boolean {
  const roles = loadRoles();
  if (roles.some((role) => role.ACTIVE && role.USER_ID === user.USER_ID)) return false;
  if (roles.some((role) => !role.ACTIVE && role.USER_ID === user.USER_ID)) return true;
  const person = { name: String(user.FULL_NAME || ''), email: String(user.EMAIL || '') };
  return roles.some((role) => isLegacyHolder(role, person) && (!role.ACTIVE || Boolean(role.USER_ID)));
}

/** Approved By email order for a person: the order of the role they hold, else the middle. */
export function emailOrderFor(person: { id: string; name: string; email: string }): number {
  const role = activeRoles('APPROVED_BY').find((r) => holdsRole(r, person));
  return role ? role.EMAIL_ORDER : 1;
}

export function hasAllRfasRole(person: { id: string; name: string; email: string }): boolean {
  return activeRoles().some((role) => role.ALL_RFAS_ACCESS && holdsRole(role, person));
}

// --- Saving (administrators) ---

/** Validate and store the full list of roles. Also keeps the older settings in step. */
export function saveRoles(input: unknown, usersById: Map<string, UserRecord>): ApprovalRole[] {
  if (!Array.isArray(input) || !input.length) throw new Error('Add at least one role.');
  const seen = new Set<string>();
  const roles: ApprovalRole[] = input.map((raw, index) => {
    const row = raw as Record<string, unknown>;
    const title = String(row.TITLE ?? '').trim();
    if (title.length < 2) throw new Error(`Role ${index + 1} needs a title.`);
    const id = String(row.ROLE_ID || '').trim() || `ROLE_${Date.now().toString(36)}_${index}`;
    if (seen.has(id)) throw new Error(`Two roles share the ID ${id}.`);
    seen.add(id);
    const stage = String(row.STAGE) as RoleStage;
    const condition = String(row.CONDITION) as RoleCondition;
    if (!ROLE_STAGES.includes(stage)) throw new Error(`Choose a stage for "${title}".`);
    if (!ROLE_CONDITIONS.includes(condition)) throw new Error(`Choose when "${title}" applies.`);
    if (condition === 'JHS_SHS_OPTIONAL' && stage !== 'REVIEWED_AND_NOTED') throw new Error(`"${title}": the JHS/SHS option belongs to Reviewed and Noted By.`);
    const userId = String(row.USER_ID || '').trim();
    if (userId) {
      const user = usersById.get(userId);
      if (!user || !toBoolean(user.ACTIVE) || !toBoolean(user.CAN_APPROVE_RFA)) throw new Error(`"${title}": the selected person must be an active user with approval permission.`);
    }
    return { ROLE_ID: id, TITLE: title, STAGE: stage, CONDITION: condition, EMAIL_ORDER: Math.max(0, Math.min(2, Number(row.EMAIL_ORDER ?? 1) || 0)), ALL_RFAS_ACCESS: toBoolean(row.ALL_RFAS_ACCESS), USER_ID: userId, ACTIVE: row.ACTIVE === undefined ? true : toBoolean(row.ACTIVE), SORT: (index + 1) * 10 };
  });
  const approvedHolders = roles.filter((r) => r.ACTIVE && r.STAGE === 'APPROVED_BY' && r.USER_ID).map((r) => r.USER_ID);
  if (new Set(approvedHolders).size !== approvedHolders.length) throw new Error('One person cannot hold two Approved By roles.');

  const headers = [...SHEETS.ROLES] as string[];
  const db = getDatabase();
  const sheet = db.getSheetByName('ROLES') ?? db.insertSheet('ROLES');
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  if (sheet.getLastRow() > 1) sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).clearContent();
  const stamp = nowIso();
  sheet.getRange(2, 1, roles.length, headers.length).setValues(roles.map((role) => headers.map((h) => (h === 'UPDATED_AT' ? stamp : (role as unknown as Record<string, unknown>)[h] ?? ''))));
  SpreadsheetApp.flush();

  // Keep the older settings in step (used as a fallback and by earlier versions).
  const byId = new Map(roles.map((r) => [r.ROLE_ID, r]));
  const idOf = (id: string) => (byId.get(id)?.ACTIVE ? byId.get(id)?.USER_ID || '' : '');
  const approvedIds = [idOf('APPROVED_FIRST'), idOf('VP_FINANCE')];
  setSetting('REVIEWED_MANDATORY_USER_ID', idOf('REVIEWED'), 'Role: Reviewed and Noted By (mandatory) - user ID (mirrors the ROLES sheet)');
  setSetting('APPROVED_MANDATORY_USER_IDS', approvedIds.some(Boolean) ? approvedIds.join(',') : '', 'Roles: Approved By - AVP for Finance, VP for Admin and Finance (mirrors the ROLES sheet)');
  setSetting('VP_ACADEMIC_USER_ID', idOf('VP_ACADEMIC'), 'Role: VP for Academic Affairs - user ID (mirrors the ROLES sheet)');
  setSetting('PRESIDENT_USER_ID', idOf('PRESIDENT'), 'Role: President - user ID (mirrors the ROLES sheet)');
  setSetting('PRINCIPAL_USER_ID', idOf('PRINCIPAL'), 'Role: JHS/SHS Principal - user ID (mirrors the ROLES sheet)');
  const emailOf = (id: string) => normalizeEmail(String(usersById.get(id)?.EMAIL || ''));
  if (emailOf(idOf('VP_FINANCE'))) setSetting('VP_ADMIN_FINANCE_EMAIL', emailOf(idOf('VP_FINANCE')), 'Email of the VP for Admin and Finance role (follows Approval roles)');
  if (emailOf(idOf('PRESIDENT'))) setSetting('PRESIDENT_EMAIL', emailOf(idOf('PRESIDENT')), 'Email of the President role (follows Approval roles)');
  return loadRoles();
}
