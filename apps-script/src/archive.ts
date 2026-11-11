import { SHEETS } from './constants';
import { audit } from './audit';
import { all, getDatabase, getSetting, insert, normalizeCell, nowIso, resetPerRequestCache, updateBy } from './store';
import { keepOnly, sheetRows } from './resetRfas';
import type { RfaRecord, SessionUser, SheetRecord } from './types';

/**
 * Yearly archive. At the end of each school year, finished RFAs from past school years are
 * moved out of the main database into one spreadsheet per school year, so the main database
 * (and therefore every page) stays small and fast. Archived RFAs stay viewable read-only.
 *
 * Moved:  RFA rows with a final status (APPROVED, CLOSED, DISAPPROVED, CANCELLED) filed in a
 *         past school year, plus their RFA_APPROVALS, RFA_ATTACHMENTS, RFA_AUDIT and NOTIFICATIONS.
 * Kept:   unfinished RFAs (draft, pending, returned, implementation), BUDGET_TRANSACTIONS
 *         (so budget balances never change), accounts and all configuration.
 * Drive attachment files are not moved; they already live in per-year folders.
 */

type SheetName = keyof typeof SHEETS;
export const ARCHIVABLE_STATUSES = ['APPROVED', 'CLOSED', 'DISAPPROVED', 'CANCELLED'];
const LINKED_SHEETS: SheetName[] = ['RFA_APPROVALS', 'RFA_ATTACHMENTS', 'RFA_AUDIT', 'NOTIFICATIONS'];
const ARCHIVE_SHEETS: SheetName[] = ['RFA', ...LINKED_SHEETS];

export interface ArchiveRecord extends SheetRecord { SCHOOL_YEAR: number; LABEL: string; SPREADSHEET_ID: string; RFA_COUNT: number; FISCAL_YEARS: string }

function startMonth(): number {
  const month = Number(getSetting('SCHOOL_YEAR_START_MONTH') || 6);
  return month >= 1 && month <= 12 ? Math.floor(month) : 6;
}

/** First calendar year of the school year a date falls in (June 2026 to May 2027 is 2026). */
export function schoolYearOf(value: unknown, month = startMonth()): number {
  const text = value instanceof Date ? Utilities.formatDate(value, 'Asia/Manila', 'yyyy-MM-dd') : String(value ?? '').slice(0, 10);
  const [y, m] = text.split('-').map(Number);
  if (!y || !m) return 0;
  return m >= month ? y : y - 1;
}

export function schoolYearLabel(startYear: number, month = startMonth()): string {
  return month === 1 ? `SY ${startYear}` : `SY ${startYear}–${startYear + 1}`;
}

export function currentSchoolYear(): number {
  return schoolYearOf(Utilities.formatDate(new Date(), 'Asia/Manila', 'yyyy-MM-dd'));
}

// --- Reading archives (memoized per request) ---
let archiveListCache: ArchiveRecord[] | null = null;
const archiveRowCache = new Map<string, SheetRecord[]>();
export function resetArchiveCache(): void { archiveListCache = null; archiveRowCache.clear(); }

export function listArchives(): ArchiveRecord[] {
  if (archiveListCache) return archiveListCache;
  try { archiveListCache = all<ArchiveRecord>('ARCHIVES').filter((row) => String(row.SPREADSHEET_ID || '')).sort((a, b) => Number(b.SCHOOL_YEAR) - Number(a.SCHOOL_YEAR)); }
  catch { archiveListCache = []; } // ARCHIVES sheet not created yet: no archives.
  return archiveListCache;
}

function archiveFor(schoolYear: number): ArchiveRecord | undefined {
  return listArchives().find((row) => Number(row.SCHOOL_YEAR) === schoolYear);
}

/** Rows of one sheet inside one school year's archive spreadsheet. */
export function archivedRows<T extends SheetRecord>(schoolYear: number, name: SheetName): T[] {
  const key = `${schoolYear}:${name}`;
  const cached = archiveRowCache.get(key);
  if (cached) return cached.map((row) => ({ ...row })) as T[];
  const archive = archiveFor(schoolYear);
  let rows: SheetRecord[] = [];
  if (archive) {
    const sheet = SpreadsheetApp.openById(String(archive.SPREADSHEET_ID)).getSheetByName(name);
    const headers = [...SHEETS[name]] as string[];
    if (sheet && sheet.getLastRow() >= 2) {
      rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues()
        .filter((row) => row.some((cell) => cell !== ''))
        .map((row) => Object.fromEntries(headers.map((h, i) => [h, normalizeCell(row[i], h)])) as SheetRecord);
    }
  }
  archiveRowCache.set(key, rows);
  return rows.map((row) => ({ ...row })) as T[];
}

/** Main-database RFAs plus archived RFAs for the given fiscal year (or every archive if none given). */
export function rfasWithArchives(fiscalYear = ''): RfaRecord[] {
  const archived = listArchives()
    .filter((row) => !fiscalYear || String(row.FISCAL_YEARS || '').split(',').map((v) => v.trim()).includes(fiscalYear))
    .flatMap((row) => archivedRows<RfaRecord>(Number(row.SCHOOL_YEAR), 'RFA'));
  return [...all<RfaRecord>('RFA'), ...archived];
}

/** Locate an archived RFA, checking the hinted school year first. */
export function findArchivedRfa(rfaId: string, schoolYearHint = 0): { schoolYear: number; rfa: RfaRecord } | null {
  const years = listArchives().map((row) => Number(row.SCHOOL_YEAR));
  const ordered = schoolYearHint && years.includes(schoolYearHint) ? [schoolYearHint, ...years.filter((y) => y !== schoolYearHint)] : years;
  for (const schoolYear of ordered) {
    const rfa = archivedRows<RfaRecord>(schoolYear, 'RFA').find((row) => row.RFA_ID === rfaId);
    if (rfa) return { schoolYear, rfa };
  }
  return null;
}

export function findArchivedAttachment(attachmentId: string): { schoolYear: number; attachment: SheetRecord } | null {
  for (const archive of listArchives()) {
    const attachment = archivedRows<SheetRecord>(Number(archive.SCHOOL_YEAR), 'RFA_ATTACHMENTS').find((row) => row.ATTACHMENT_ID === attachmentId);
    if (attachment) return { schoolYear: Number(archive.SCHOOL_YEAR), attachment };
  }
  return null;
}

/** School years users can pick in My RFAs and All RFAs. */
export function archiveYears(): Array<{ schoolYear: number; label: string; rfaCount: number }> {
  return listArchives().map((row) => ({ schoolYear: Number(row.SCHOOL_YEAR), label: String(row.LABEL || schoolYearLabel(Number(row.SCHOOL_YEAR))), rfaCount: Number(row.RFA_COUNT || 0) }));
}

// --- Writing archives ---

function rowRecord(headers: string[], row: unknown[]): Record<string, unknown> {
  return Object.fromEntries(headers.map((h, i) => [h, row[i]]));
}

/** RFAs that would be archived now, grouped by school year. Changes nothing. */
export function previewArchive(): Record<string, number> {
  const current = currentSchoolYear();
  const { headers, values } = sheetRows('RFA');
  const counts: Record<string, number> = {};
  values.forEach((row) => {
    const record = rowRecord(headers, row);
    const sy = schoolYearOf(record.DATE_FILED);
    if (sy && sy < current && ARCHIVABLE_STATUSES.includes(String(record.STATUS))) counts[schoolYearLabel(sy)] = (counts[schoolYearLabel(sy)] || 0) + 1;
  });
  return counts;
}

function openOrCreateArchive(schoolYear: number): GoogleAppsScript.Spreadsheet.Spreadsheet {
  const existing = archiveFor(schoolYear);
  if (existing) return SpreadsheetApp.openById(String(existing.SPREADSHEET_ID));
  const db = getDatabase();
  const spreadsheet = SpreadsheetApp.create(`eRFA Archive ${schoolYearLabel(schoolYear)}`);
  ARCHIVE_SHEETS.forEach((name, index) => {
    const sheet = index === 0 ? spreadsheet.getSheets()[0].setName(name) : spreadsheet.insertSheet(name);
    const headers = [...SHEETS[name]] as string[];
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  });
  try {
    // Keep the archive next to the main database in Drive.
    const file = DriveApp.getFileById(spreadsheet.getId());
    const parents = DriveApp.getFileById(db.getId()).getParents();
    if (parents.hasNext()) file.moveTo(parents.next());
  } catch { /* location is cosmetic */ }
  return spreadsheet;
}

function appendRows(spreadsheet: GoogleAppsScript.Spreadsheet.Spreadsheet, name: SheetName, rows: unknown[][]): void {
  if (!rows.length) return;
  const sheet = spreadsheet.getSheetByName(name) ?? spreadsheet.insertSheet(name);
  const headers = [...SHEETS[name]] as string[];
  if (sheet.getLastRow() < 1) sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  const start = sheet.getLastRow() + 1;
  sheet.getRange(start, 1, rows.length, headers.length).setValues(rows);
  SpreadsheetApp.flush();
  if (sheet.getLastRow() < start + rows.length - 1) throw new Error(`Archive write check failed for ${name}; nothing was removed from the main database.`);
}

/**
 * Archive every past school year that still has finished RFAs in the main database.
 * Makes a full backup of the main database first, writes and verifies each archive,
 * and only then removes the archived rows from the main database. Safe to run again.
 */
export function archivePastSchoolYears(actor: Pick<SessionUser, 'FULL_NAME' | 'EMAIL'>): Record<string, unknown> {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('eRFA is busy. Try again in a minute.');
  try {
    const current = currentSchoolYear();
    const { headers: rfaHeaders, values: rfaValues } = sheetRows('RFA');
    const idsByYear = new Map<number, Set<string>>();
    const fiscalByYear = new Map<number, Set<string>>();
    rfaValues.forEach((row) => {
      const record = rowRecord(rfaHeaders, row);
      const sy = schoolYearOf(record.DATE_FILED);
      if (!sy || sy >= current || !ARCHIVABLE_STATUSES.includes(String(record.STATUS))) return;
      if (!idsByYear.has(sy)) { idsByYear.set(sy, new Set()); fiscalByYear.set(sy, new Set()); }
      idsByYear.get(sy)!.add(String(record.RFA_ID));
      if (record.FISCAL_YEAR) fiscalByYear.get(sy)!.add(String(record.FISCAL_YEAR));
    });
    if (!idsByYear.size) return { archived: {}, message: 'Nothing to archive: no finished RFAs from past school years.' };

    const db = getDatabase();
    const stamp = Utilities.formatDate(new Date(), db.getSpreadsheetTimeZone() || 'Asia/Manila', 'yyyy-MM-dd HHmm');
    const backup = DriveApp.getFileById(db.getId()).makeCopy(`eRFA Database - backup before archive ${stamp}`);

    const allIds = new Set<string>();
    const archived: Record<string, number> = {};
    for (const [schoolYear, ids] of [...idsByYear.entries()].sort((a, b) => a[0] - b[0])) {
      const spreadsheet = openOrCreateArchive(schoolYear);
      for (const name of ARCHIVE_SHEETS) {
        const { headers, values } = sheetRows(name);
        const idIndex = headers.indexOf('RFA_ID');
        appendRows(spreadsheet, name, values.filter((row) => ids.has(String(row[idIndex]))));
      }
      const label = schoolYearLabel(schoolYear);
      const existing = archiveFor(schoolYear);
      const fiscalYears = [...new Set([...String(existing?.FISCAL_YEARS || '').split(',').filter(Boolean), ...fiscalByYear.get(schoolYear)!])].sort().join(',');
      const rfaCount = Number(existing?.RFA_COUNT || 0) + ids.size;
      if (existing) updateBy('ARCHIVES', 'SCHOOL_YEAR', String(schoolYear), { RFA_COUNT: rfaCount, FISCAL_YEARS: fiscalYears, ARCHIVED_AT: nowIso(), ARCHIVED_BY: actor.EMAIL });
      else insert('ARCHIVES', { SCHOOL_YEAR: schoolYear, LABEL: label, SPREADSHEET_ID: spreadsheet.getId(), RFA_COUNT: rfaCount, FISCAL_YEARS: fiscalYears, ARCHIVED_AT: nowIso(), ARCHIVED_BY: actor.EMAIL });
      archiveListCache = null;
      ids.forEach((id) => allIds.add(id));
      archived[label] = ids.size;
    }

    // Every archive is written and verified; now remove those rows from the main database.
    for (const name of ARCHIVE_SHEETS) keepOnly(name, (headers, row) => !allIds.has(String(row[headers.indexOf('RFA_ID')])));
    SpreadsheetApp.flush();
    resetPerRequestCache();
    resetArchiveCache();
    audit('SCHOOL_YEAR_ARCHIVED', actor, '', '', '', `Archived ${allIds.size} finished RFAs from past school years.`, { archived, backupId: backup.getId() });
    return { archived, backup: backup.getName(), message: `Archived ${allIds.size} RFAs: ${Object.entries(archived).map(([k, v]) => `${k} (${v})`).join(', ')}. Backup: "${backup.getName()}".` };
  } finally {
    lock.releaseLock();
  }
}
