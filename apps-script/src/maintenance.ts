import { SHEETS } from './constants';
import { getDatabase, resetPerRequestCache } from './store';

export const RESET_CONFIRMATION = 'RESET TEST DATA';

// Explicit transactional allowlist. Master data and mixed audit history are not here.
export const RESET_SHEETS = [
  'RFA', 'RFA_APPROVALS', 'RFA_ATTACHMENTS', 'NOTIFICATIONS',
  'DEPARTMENT_BUDGETS', 'BUDGET_TRANSACTIONS'
] as const satisfies readonly (keyof typeof SHEETS)[];

const protectedSheets = ['USERS', 'DEPARTMENTS', 'APPROVAL_MATRIX', 'SETTINGS', 'EXPENSE_CATEGORIES'] as const;
const budgetAuditActions = new Set(['BUDGET_CREATED', 'BUDGET_ADJUSTED', 'BUDGET_OVERAGE_SETTING_CHANGED']);
const numberingKeys = ['LAST_RFA_YEAR', 'LAST_RFA_SEQUENCE'] as const;

export function auditRowIsTestTransaction(rfaId: unknown, action: unknown): boolean {
  return String(rfaId ?? '').trim() !== '' || budgetAuditActions.has(String(action ?? ''));
}

export function validateResetAllowlist(names: readonly string[]): void {
  if (new Set(names).size !== names.length || names.length !== RESET_SHEETS.length ||
      names.some((name) => !RESET_SHEETS.includes(name as typeof RESET_SHEETS[number]) || protectedSheets.includes(name as typeof protectedSheets[number]))) {
    throw new Error('Reset sheet allowlist does not match the verified transactional schema.');
  }
}

type PlannedSheet = { name: string; sheet: GoogleAppsScript.Spreadsheet.Sheet; rows: number };

function checkedSheet(db: GoogleAppsScript.Spreadsheet.Spreadsheet, name: keyof typeof SHEETS): GoogleAppsScript.Spreadsheet.Sheet {
  const sheet = db.getSheetByName(name);
  if (!sheet) throw new Error(`Reset cancelled: ${name} is missing.`);
  const expected = [...SHEETS[name]] as string[];
  const lastColumn = sheet.getLastColumn();
  if (lastColumn !== expected.length || sheet.getLastRow() < 1) throw new Error(`Reset cancelled: ${name} header width is not the expected schema.`);
  const actual = sheet.getRange(1, 1, 1, expected.length).getDisplayValues()[0];
  if (actual.some((value, index) => value !== expected[index])) throw new Error(`Reset cancelled: ${name} headers differ from the expected schema.`);
  return sheet;
}

export function resetTestDataForProduction(confirmation: string): { cleared: { sheet: string; rows: number }[]; auditRowsRemoved: number; numberingReset: string[] } {
  if (confirmation !== RESET_CONFIRMATION) throw new Error(`Reset cancelled: exact confirmation ${RESET_CONFIRMATION} is required.`);
  validateResetAllowlist(RESET_SHEETS);
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('Reset cancelled: could not acquire the script lock.');
  try {
    // Preflight every affected sheet and numbering row before touching any data.
    const db = getDatabase();
    const planned: PlannedSheet[] = RESET_SHEETS.map((name) => {
      const sheet = checkedSheet(db, name);
      return { name, sheet, rows: sheet.getLastRow() - 1 };
    });
    const auditSheet = checkedSheet(db, 'RFA_AUDIT');
    const settingsSheet = checkedSheet(db, 'SETTINGS');
    for (const name of protectedSheets) checkedSheet(db, name);

    const auditRows = auditSheet.getLastRow() - 1;
    const auditFields = SHEETS.RFA_AUDIT;
    const auditValues = auditRows ? auditSheet.getRange(2, 1, auditRows, auditFields.length).getValues() : [];
    const auditDeleteRows = auditValues.flatMap((row, index) =>
      auditRowIsTestTransaction(row[auditFields.indexOf('RFA_ID')], row[auditFields.indexOf('ACTION')]) ? [index + 2] : []);

    const settingsRows = settingsSheet.getLastRow() - 1;
    const settingsValues = settingsRows ? settingsSheet.getRange(2, 1, settingsRows, SHEETS.SETTINGS.length).getValues() : [];
    const counterRows = numberingKeys.map((key) => {
      const matches = settingsValues.flatMap((row, index) => String(row[0]) === key ? [index + 2] : []);
      if (matches.length !== 1) throw new Error(`Reset cancelled: expected one ${key} setting.`);
      return matches[0];
    });

    for (const item of planned) {
      if (item.rows) item.sheet.deleteRows(2, item.rows);
      console.log(`Reset ${item.name}: ${item.rows} data rows removed.`);
    }
    for (let index = auditDeleteRows.length - 1; index >= 0; index -= 1) auditSheet.deleteRow(auditDeleteRows[index]);
    console.log(`Reset RFA_AUDIT: ${auditDeleteRows.length} RFA/budget audit rows removed; master/system history preserved.`);
    for (const row of counterRows) settingsSheet.getRange(row, 2).setValue('0');
    console.log('Reset SETTINGS: LAST_RFA_YEAR and LAST_RFA_SEQUENCE set to 0; all other settings preserved.');
    resetPerRequestCache();
    return { cleared: planned.map(({ name, rows }) => ({ sheet: name, rows })), auditRowsRemoved: auditDeleteRows.length, numberingReset: [...numberingKeys] };
  } finally {
    lock.releaseLock();
  }
}
