import { DEFAULT_SETTINGS, SHEETS } from './constants';
import { toBoolean } from './core';
import type { SheetRecord } from './types';

const PROPERTY_SPREADSHEET_ID = 'ERFA_SPREADSHEET_ID';

// --- Per-execution memoization (safe: lives only for this Apps Script invocation) ---
let cachedDb: GoogleAppsScript.Spreadsheet.Spreadsheet | null = null;
const sheetDataCache = new Map<string, SheetRecord[]>();
let settingsMapCache: Map<string, string> | null = null;

function invalidateSheetCache(name: keyof typeof SHEETS): void {
  sheetDataCache.delete(name as string);
  if ((name as string) === 'SETTINGS') settingsMapCache = null;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(prefix: string): string {
  return `${prefix}_${Utilities.getUuid()}`;
}

export function getDatabase(): GoogleAppsScript.Spreadsheet.Spreadsheet {
  if (cachedDb) return cachedDb;
  const properties = PropertiesService.getScriptProperties();
  const configured = properties.getProperty(PROPERTY_SPREADSHEET_ID);
  if (configured) {
    cachedDb = SpreadsheetApp.openById(configured);
    return cachedDb;
  }
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) {
    properties.setProperty(PROPERTY_SPREADSHEET_ID, active.getId());
    cachedDb = active;
    return cachedDb;
  }
  const created = SpreadsheetApp.create('eRFA Database');
  properties.setProperty(PROPERTY_SPREADSHEET_ID, created.getId());
  cachedDb = created;
  return created;
}

function getSheet(name: keyof typeof SHEETS): GoogleAppsScript.Spreadsheet.Sheet {
  const sheet = getDatabase().getSheetByName(name);
  if (!sheet) throw new Error(`Database sheet ${name} is missing. Run setupDatabase().`);
  return sheet;
}

export function setupSchema(): { spreadsheetId: string; spreadsheetUrl: string; sheets: string[]; attachmentFolderId: string } {
  const db = getDatabase();
  Object.entries(SHEETS).forEach(([name, headers]) => {
    let sheet = db.getSheetByName(name);
    if (!sheet) sheet = db.insertSheet(name);
    const currentHeaders = sheet.getLastColumn() ? sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0] : [];
    headers.forEach((header, index) => {
      if (!currentHeaders[index]) sheet!.getRange(1, index + 1).setValue(header);
      else if (currentHeaders[index] !== header) throw new Error(`${name} header ${index + 1} must be ${header}, found ${currentHeaders[index]}.`);
    });
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#18365f').setFontColor('#ffffff');
    sheet.autoResizeColumns(1, headers.length);
  });
  const defaultSheet = db.getSheetByName('Sheet1');
  if (defaultSheet && db.getSheets().length > Object.keys(SHEETS).length && defaultSheet.getLastRow() === 0) db.deleteSheet(defaultSheet);

  DEFAULT_SETTINGS.forEach(([key, value, description]) => {
    if (!findBy<SheetRecord>('SETTINGS', 'KEY', key)) insert('SETTINGS', { KEY: key, VALUE: value, DESCRIPTION: description, UPDATED_AT: nowIso() });
  });

  let attachmentFolderId = getSetting('ATTACHMENT_ROOT_FOLDER_ID');
  if (!attachmentFolderId) {
    const folder = DriveApp.createFolder('eRFA');
    attachmentFolderId = folder.getId();
    setSetting('ATTACHMENT_ROOT_FOLDER_ID', attachmentFolderId, 'Drive root folder ID');
  }
  return { spreadsheetId: db.getId(), spreadsheetUrl: db.getUrl(), sheets: Object.keys(SHEETS), attachmentFolderId };
}

function normalizeCell(value: unknown): string | number | boolean {
  if (value instanceof Date) return value.toISOString();
  return value as string | number | boolean;
}

export function all<T extends SheetRecord>(name: keyof typeof SHEETS): T[] {
  const key = name as string;
  if (sheetDataCache.has(key)) {
    // Return shallow copies to prevent caller mutation from polluting cache
    return (sheetDataCache.get(key)! as T[]).map((r) => ({ ...r }));
  }
  const sheet = getSheet(name);
  const headers = [...SHEETS[name]] as string[];
  if (sheet.getLastRow() < 2) {
    sheetDataCache.set(key, []);
    return [];
  }
  const records = sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues().map((row) => {
    const record: SheetRecord = {};
    headers.forEach((header, index) => { record[header] = normalizeCell(row[index]); });
    return record as T;
  });
  sheetDataCache.set(key, records as SheetRecord[]);
  return records.map((r) => ({ ...r }));
}

/**
 * Read only the last `limit` rows (tail) — avoids full scan for large audit/log sheets.
 * Preserves column order and normalization identically to `all()`.
 */
export function allTail<T extends SheetRecord>(name: keyof typeof SHEETS, limit: number): T[] {
  const sheet = getSheet(name);
  const headers = [...SHEETS[name]] as string[];
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const rowCount = Math.min(limit, lastRow - 1);
  const startRow = lastRow - rowCount + 1;
  return sheet.getRange(startRow, 1, rowCount, headers.length).getValues().map((row) => {
    const record: SheetRecord = {};
    headers.forEach((header, index) => { record[header] = normalizeCell(row[index]); });
    return record as T;
  });
}

export function insert(name: keyof typeof SHEETS, record: SheetRecord): void {
  const headers = [...SHEETS[name]] as string[];
  getSheet(name).appendRow(headers.map((header) => record[header] ?? ''));
  invalidateSheetCache(name);
}

export function updateBy(name: keyof typeof SHEETS, key: string, value: string, updates: SheetRecord): void {
  const sheet = getSheet(name);
  const headers = [...SHEETS[name]] as string[];
  const keyIndex = headers.indexOf(key);
  if (keyIndex < 0) throw new Error(`Unknown key ${key} for ${name}.`);
  if (sheet.getLastRow() < 2) throw new Error(`${name} record not found.`);
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues();
  const rowIndex = values.findIndex((row) => String(row[keyIndex]) === value);
  if (rowIndex < 0) throw new Error(`${name} record not found.`);
  const row = values[rowIndex];
  Object.entries(updates).forEach(([field, fieldValue]) => {
    const index = headers.indexOf(field);
    if (index >= 0) row[index] = fieldValue;
  });
  sheet.getRange(rowIndex + 2, 1, 1, headers.length).setValues([row]);
  invalidateSheetCache(name);
}

export function findBy<T extends SheetRecord>(name: keyof typeof SHEETS, key: string, value: string): T | undefined {
  return all<T>(name).find((record) => String(record[key]) === value);
}

function getSettingsMap(): Map<string, string> {
  if (settingsMapCache) return settingsMapCache;
  const map = new Map<string, string>();
  // all('SETTINGS') is itself cached per execution after first load
  const records = all<SheetRecord>('SETTINGS');
  for (const r of records) map.set(String(r.KEY), String(r.VALUE ?? ''));
  settingsMapCache = map;
  return map;
}

export function getSetting(key: string): string {
  return getSettingsMap().get(key) ?? '';
}

export function setSetting(key: string, value: string, description = ''): void {
  const existing = all<SheetRecord>('SETTINGS').find((item) => String(item.KEY) === key);
  if (existing) updateBy('SETTINGS', 'KEY', key, { VALUE: value, DESCRIPTION: description || existing.DESCRIPTION, UPDATED_AT: nowIso() });
  else insert('SETTINGS', { KEY: key, VALUE: value, DESCRIPTION: description, UPDATED_AT: nowIso() });
  // caches invalidated by insert/updateBy -> settingsMapCache cleared
}

export function settingBoolean(key: string): boolean {
  return toBoolean(getSetting(key));
}
