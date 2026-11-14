/**
 * In-memory replacement for src/store.ts, used only by the local demo server (dev/server.ts).
 * Same exported functions, backed by plain arrays instead of Google Sheets.
 */
import { DEFAULT_SETTINGS, SHEETS } from '../src/constants';
import { toBoolean } from '../src/core';
import type { ApprovalSection, SheetRecord } from '../src/types';

type SheetName = keyof typeof SHEETS;
const tables = new Map<string, SheetRecord[]>();
let sequence = 0;

function table(name: string): SheetRecord[] {
  if (!tables.has(name)) tables.set(name, []);
  return tables.get(name)!;
}

export function resetPerRequestCache(): void { /* nothing cached */ }
export function nowIso(): string { return new Date().toISOString(); }
export function newId(prefix: string): string { sequence += 1; return `${prefix}_${sequence.toString(36)}${Math.random().toString(36).slice(2, 6)}`; }
export function normalizeCell(value: unknown): string | number | boolean { return value instanceof Date ? value.toISOString() : value as string | number | boolean; }

export function all<T extends SheetRecord>(name: SheetName): T[] { return table(name).map((row) => ({ ...row })) as T[]; }
export function allTail<T extends SheetRecord>(name: SheetName, limit: number): T[] { return table(name).slice(-limit).map((row) => ({ ...row })) as T[]; }
export function findBy<T extends SheetRecord>(name: SheetName, key: string, value: string): T | undefined {
  const row = table(name).find((item) => String(item[key]) === value);
  return row ? ({ ...row } as T) : undefined;
}
export function insert(name: SheetName, record: SheetRecord): void {
  const headers = SHEETS[name] as readonly string[];
  table(name).push(Object.fromEntries(headers.map((h) => [h, record[h] ?? ''])));
}
export function updateBy(name: SheetName, key: string, value: string, updates: SheetRecord): void {
  const row = table(name).find((item) => String(item[key]) === value);
  if (!row) throw new Error(`${name} record not found.`);
  Object.assign(row, updates);
}

export function getSetting(key: string): string { return String(table('SETTINGS').find((row) => row.KEY === key)?.VALUE ?? ''); }
export function setSetting(key: string, value: string, description = ''): void {
  const row = table('SETTINGS').find((item) => item.KEY === key);
  if (row) Object.assign(row, { VALUE: value, UPDATED_AT: nowIso() });
  else insert('SETTINGS', { KEY: key, VALUE: value, DESCRIPTION: description, UPDATED_AT: nowIso() });
}
export function settingBoolean(key: string): boolean { return toBoolean(getSetting(key)); }

export function saveRfaSectionAssignments(rfaId: string, rfaNumber: string, section: ApprovalSection, assignments: Array<{ USER_ID: string; FULL_NAME: string; EMAIL: string }>): void {
  for (const person of assignments) insert('RFA_APPROVALS', { APPROVAL_ID: newId('apr'), RFA_ID: rfaId, RFA_NUMBER: rfaNumber, STEP: section, APPROVER_USER_ID: person.USER_ID, APPROVER_NAME: person.FULL_NAME, APPROVER_EMAIL: person.EMAIL, ACTION: '', REMARKS: '', TIMESTAMP: nowIso() });
}
export function clearPendingRfaAssignments(rfaId: string): void {
  tables.set('RFA_APPROVALS', table('RFA_APPROVALS').filter((row) => !(row.RFA_ID === rfaId && String(row.ACTION ?? '') === '')));
}
export function getAssignmentsBySection(rfaId: string, section: ApprovalSection): SheetRecord[] {
  return table('RFA_APPROVALS').filter((row) => row.RFA_ID === rfaId && row.STEP === section && row.ACTION === '').map((row) => ({ ...row }));
}

/** Minimal spreadsheet adapter for code that writes whole sheets (roles, matrix clean-up). */
function sheetAdapter(name: SheetName) {
  const headers = SHEETS[name] as readonly string[];
  return {
    getLastRow: () => table(name).length + 1,
    getLastColumn: () => headers.length,
    getRange: (row: number, _col: number, rows = 1) => ({
      getValues: () => (row === 1 ? [[...headers]] : table(name).slice(row - 2, row - 2 + rows).map((r) => headers.map((h) => r[h] ?? ''))),
      setValues: (values: unknown[][]) => {
        if (row === 1) return;
        values.forEach((v, i) => { table(name)[row - 2 + i] = Object.fromEntries(headers.map((h, j) => [h, v[j] ?? ''])) as SheetRecord; });
      },
      clearContent: () => { tables.set(name, table(name).filter((_, i) => i < row - 2 || i >= row - 2 + rows)); }
    }),
    deleteRow: (row: number) => { table(name).splice(row - 2, 1); }
  };
}
const database = {
  getId: () => 'local-demo-database', getUrl: () => 'about:blank', getSpreadsheetTimeZone: () => 'Asia/Manila',
  getSheetByName: (name: string) => (Object.prototype.hasOwnProperty.call(SHEETS, name) ? sheetAdapter(name as SheetName) : null),
  insertSheet: (name: string) => sheetAdapter(name as SheetName)
};
export function getDatabase(): GoogleAppsScript.Spreadsheet.Spreadsheet { return database as unknown as GoogleAppsScript.Spreadsheet.Spreadsheet; }

export function setupSchema(): { spreadsheetId: string; spreadsheetUrl: string; sheets: string[]; attachmentFolderId: string } {
  Object.keys(SHEETS).forEach((name) => table(name));
  DEFAULT_SETTINGS.forEach(([key, value, description]) => { if (!table('SETTINGS').some((row) => row.KEY === key)) insert('SETTINGS', { KEY: key, VALUE: value, DESCRIPTION: description, UPDATED_AT: nowIso() }); });
  return { spreadsheetId: 'local-demo-database', spreadsheetUrl: 'about:blank', sheets: Object.keys(SHEETS), attachmentFolderId: '' };
}

/** Outbox of emails "sent" by the demo (printed to the console too). */
export const outbox: Array<{ to: string; subject: string }> = [];

/** Real store batches log rows into one spreadsheet write; in memory every write is already instant. */
export function withBatchedLogs<T>(operation: () => T): T { return operation(); }
export function flushPendingRows(): void { /* nothing pending in memory */ }
