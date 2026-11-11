import { SHEETS } from './constants';
import { audit } from './audit';
import { getDatabase, getSetting, resetPerRequestCache, setSetting } from './store';
import type { SessionUser } from './types';

/**
 * Fresh start after a pilot: remove every RFA and everything that belongs to an RFA,
 * while keeping accounts and configuration exactly as they are.
 *
 * Cleared:  RFA, RFA_APPROVALS, RFA_ATTACHMENTS, NOTIFICATIONS (all rows)
 *           RFA_AUDIT rows linked to an RFA, BUDGET_TRANSACTIONS rows linked to an RFA
 *           RFA numbering (next RFA becomes ####-0001 again)
 *           Attachment files/folders in Drive are moved to the trash (recoverable ~30 days)
 * Kept:     USERS, DEPARTMENTS, DEPARTMENT_HEADS, APPROVAL_MATRIX, SETTINGS,
 *           DEPARTMENT_BUDGETS, EXPENSE_CATEGORIES, budget rows not tied to an RFA,
 *           and history rows not tied to an RFA (user/admin changes)
 */

type SheetName = keyof typeof SHEETS;
type Row = Record<string, unknown>;

const CLEAR_ALL: SheetName[] = ['RFA', 'RFA_APPROVALS', 'RFA_ATTACHMENTS', 'NOTIFICATIONS'];
const CLEAR_RFA_LINKED: SheetName[] = ['RFA_AUDIT', 'BUDGET_TRANSACTIONS'];

export interface RfaResetCounts { [sheet: string]: number }

export function sheetRows(name: SheetName): { sheet: GoogleAppsScript.Spreadsheet.Sheet | null; headers: string[]; values: unknown[][] } {
  const sheet = getDatabase().getSheetByName(name);
  const headers = [...SHEETS[name]] as string[];
  if (!sheet || sheet.getLastRow() < 2) return { sheet, headers, values: [] };
  return { sheet, headers, values: sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues() };
}

function isRfaLinked(headers: string[], row: unknown[]): boolean {
  return String(row[headers.indexOf('RFA_ID')] ?? '').trim() !== '';
}

/** Count what a reset would remove, without changing anything. */
export function previewRfaReset(): RfaResetCounts {
  const counts: RfaResetCounts = {};
  CLEAR_ALL.forEach((name) => { counts[name] = sheetRows(name).values.length; });
  CLEAR_RFA_LINKED.forEach((name) => { const { headers, values } = sheetRows(name); counts[name] = values.filter((row) => isRfaLinked(headers, row)).length; });
  return counts;
}

/** Rewrite a sheet keeping only rows for which keep() is true. Returns rows removed. */
export function keepOnly(name: SheetName, keep: (headers: string[], row: unknown[]) => boolean): number {
  const { sheet, headers, values } = sheetRows(name);
  if (!sheet || values.length === 0) return 0;
  const kept = values.filter((row) => keep(headers, row));
  const removed = values.length - kept.length;
  if (removed === 0) return 0;
  sheet.getRange(2, 1, values.length, headers.length).clearContent();
  if (kept.length) sheet.getRange(2, 1, kept.length, headers.length).setValues(kept);
  return removed;
}

function backupDatabase(): { backupId: string; backupName: string } {
  const db = getDatabase();
  const stamp = Utilities.formatDate(new Date(), db.getSpreadsheetTimeZone() || 'Asia/Manila', 'yyyy-MM-dd HHmm');
  const backupName = `eRFA Database - backup before RFA reset ${stamp}`;
  const copy = DriveApp.getFileById(db.getId()).makeCopy(backupName);
  return { backupId: copy.getId(), backupName };
}

/** Move pilot attachment files and RFA folders to the Drive trash. Renaming first keeps
 *  a reused RFA number (e.g. RFA-2026-0001) from ever picking up an old folder. */
function trashAttachments(attachmentRows: Row[]): { files: number; folders: number } {
  let files = 0;
  let folders = 0;
  attachmentRows.forEach((row) => {
    const id = String(row.DRIVE_FILE_ID ?? '').trim();
    if (!id) return;
    try { DriveApp.getFileById(id).setTrashed(true); files += 1; } catch { /* already gone or no access */ }
  });
  const rootId = getSetting('ATTACHMENT_ROOT_FOLDER_ID');
  if (!rootId) return { files, folders };
  try {
    const years = DriveApp.getFolderById(rootId).getFolders();
    while (years.hasNext()) {
      const rfaFolders = years.next().getFolders();
      while (rfaFolders.hasNext()) {
        const folder = rfaFolders.next();
        if (!/^RFA-\d{4}-\d+$/.test(folder.getName())) continue;
        folder.setName(`${folder.getName()} (pilot, removed)`);
        folder.setTrashed(true);
        folders += 1;
      }
    }
  } catch { /* folder cleanup is best-effort; sheet data is already cleared */ }
  return { files, folders };
}

export function resetRfas(actor: Pick<SessionUser, 'FULL_NAME' | 'EMAIL'>): Record<string, unknown> {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('eRFA is busy. Try again in a minute.');
  try {
    const before = previewRfaReset();
    const backup = backupDatabase();

    const { headers: attachmentHeaders, values: attachmentValues } = sheetRows('RFA_ATTACHMENTS');
    const attachmentRows = attachmentValues.map((row) => Object.fromEntries(attachmentHeaders.map((h, i) => [h, row[i]])));

    const removed: RfaResetCounts = {};
    CLEAR_ALL.forEach((name) => { removed[name] = keepOnly(name, () => false); });
    CLEAR_RFA_LINKED.forEach((name) => { removed[name] = keepOnly(name, (headers, row) => !isRfaLinked(headers, row)); });
    SpreadsheetApp.flush();

    setSetting('LAST_RFA_SEQUENCE', '0', 'Internal numbering state');
    const drive = trashAttachments(attachmentRows);
    resetPerRequestCache();

    audit('RFAS_RESET', actor, '', '', '', 'All RFAs cleared for a fresh start. Accounts and settings kept.', { removed, drive, backupId: backup.backupId });
    return { before, removed, drive, backup, message: `Removed ${removed.RFA} RFAs. Accounts, departments, approval matrix and settings were kept. Backup: "${backup.backupName}".` };
  } finally {
    lock.releaseLock();
  }
}
