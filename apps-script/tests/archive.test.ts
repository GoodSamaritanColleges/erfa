import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SHEETS } from '../src/constants';

type Cell = string | number | boolean;
type Book = Map<string, Cell[][]>; // sheet name -> rows (row 0 = headers for archive books)
const main: Book = new Map();
const books = new Map<string, Book>();
const archivesSheet: Array<Record<string, Cell>> = [];
const settings = new Map<string, string>();
const events: string[] = [];

const row = (name: keyof typeof SHEETS, values: Record<string, Cell>): Cell[] => (SHEETS[name] as readonly string[]).map((h) => values[h] ?? '');
const live = (rows: Cell[][] | undefined) => (rows ?? []).filter((r) => r.some((c) => c !== ''));

function mainSheet(name: string) {
  return {
    getLastRow: () => { const rows = main.get(name) ?? []; let n = rows.length; while (n > 0 && rows[n - 1].every((c) => c === '')) n -= 1; return n + 1; },
    getRange: (r: number, _c: number, n: number, cols: number) => ({
      getValues: () => (main.get(name) ?? []).slice(r - 2, r - 2 + n).map((x) => x.slice(0, cols)),
      clearContent: () => { events.push(`clear:${name}`); const rows = main.get(name)!; for (let i = r - 2; i < r - 2 + n; i += 1) rows[i] = rows[i].map(() => ''); },
      setValues: (vals: Cell[][]) => { const rows = main.get(name)!; vals.forEach((v, i) => { rows[r - 2 + i] = [...v]; }); }
    })
  };
}

function bookSheet(book: Book, name: string) {
  if (!book.has(name)) book.set(name, []);
  const rows = () => book.get(name)!;
  const sheet = {
    setName: (n: string) => { book.set(n, rows()); book.delete(name); return bookSheet(book, n); },
    getLastRow: () => rows().length,
    setFrozenRows: () => undefined,
    getRange: (r: number, _c: number, n: number, cols: number) => ({
      setValues: (vals: Cell[][]) => { events.push(`write:${name}`); vals.forEach((v, i) => { rows()[r - 1 + i] = [...v]; }); return { setFontWeight: () => undefined }; },
      getValues: () => rows().slice(r - 1, r - 1 + n).map((x) => x.slice(0, cols))
    })
  };
  return sheet;
}

vi.mock('../src/store', () => ({
  all: (name: string) => {
    if (name === 'ARCHIVES') return archivesSheet.map((r) => ({ ...r }));
    const headers = SHEETS[name as keyof typeof SHEETS] as readonly string[];
    return live(main.get(name)).map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i]])));
  },
  getDatabase: () => ({ getSheetByName: (n: string) => (main.has(n) ? mainSheet(n) : null), getId: () => 'db', getSpreadsheetTimeZone: () => 'Asia/Manila' }),
  getSetting: (k: string) => settings.get(k) ?? '',
  insert: (name: string, record: Record<string, Cell>) => { if (name === 'ARCHIVES') archivesSheet.push(record); },
  updateBy: (name: string, _key: string, value: string, updates: Record<string, Cell>) => { const r = archivesSheet.find((x) => String(x.SCHOOL_YEAR) === value); if (r) Object.assign(r, updates); },
  normalizeCell: (v: unknown) => v,
  nowIso: () => '2026-11-11T00:00:00.000Z',
  resetPerRequestCache: () => undefined
}));
vi.mock('../src/audit', () => ({ audit: (action: string) => { events.push(`audit:${action}`); } }));

beforeEach(() => {
  main.clear(); books.clear(); archivesSheet.length = 0; settings.clear(); events.length = 0;
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-11T08:00:00Z')); // current school year: 2026 (June 2026 - May 2027)
  main.set('RFA', [
    row('RFA', { RFA_ID: 'old-closed', DATE_FILED: '2025-09-01', STATUS: 'CLOSED', FISCAL_YEAR: '2025', REQUESTER_EMAIL: 'req@x.edu' }),
    row('RFA', { RFA_ID: 'old-approved', DATE_FILED: '2026-05-20', STATUS: 'APPROVED', FISCAL_YEAR: '2026', REQUESTER_EMAIL: 'req@x.edu' }),
    row('RFA', { RFA_ID: 'old-pending', DATE_FILED: '2025-10-01', STATUS: 'PENDING_REVIEW', FISCAL_YEAR: '2025' }),
    row('RFA', { RFA_ID: 'this-year', DATE_FILED: '2026-06-02', STATUS: 'CLOSED', FISCAL_YEAR: '2026' })
  ]);
  main.set('RFA_APPROVALS', [row('RFA_APPROVALS', { APPROVAL_ID: 'a1', RFA_ID: 'old-closed' }), row('RFA_APPROVALS', { APPROVAL_ID: 'a2', RFA_ID: 'this-year' })]);
  main.set('RFA_ATTACHMENTS', [row('RFA_ATTACHMENTS', { ATTACHMENT_ID: 'f1', RFA_ID: 'old-closed', DRIVE_FILE_ID: 'drive1' })]);
  main.set('RFA_AUDIT', [row('RFA_AUDIT', { LOG_ID: 'l1', RFA_ID: 'old-closed' }), row('RFA_AUDIT', { LOG_ID: 'l2', RFA_ID: '' })]);
  main.set('NOTIFICATIONS', [row('NOTIFICATIONS', { NOTIFICATION_ID: 'n1', RFA_ID: 'old-approved' })]);
  main.set('BUDGET_TRANSACTIONS', [row('BUDGET_TRANSACTIONS', { TRANSACTION_ID: 't1', RFA_ID: 'old-closed' })]);

  let created = 0;
  const spreadsheet = (id: string) => {
    const book = books.get(id)!;
    return { getId: () => id, getSheets: () => [bookSheet(book, 'Sheet1')], insertSheet: (n: string) => bookSheet(book, n), getSheetByName: (n: string) => (book.has(n) ? bookSheet(book, n) : null) };
  };
  vi.stubGlobal('Utilities', { formatDate: (d: Date, _tz: string, fmt: string) => (fmt === 'yyyy-MM-dd' ? d.toISOString().slice(0, 10) : '2026-11-11 1600') });
  vi.stubGlobal('LockService', { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => undefined }) });
  vi.stubGlobal('SpreadsheetApp', {
    flush: () => undefined,
    create: () => { created += 1; const id = `archive${created}`; books.set(id, new Map()); events.push(`create:${id}`); return spreadsheet(id); },
    openById: (id: string) => spreadsheet(id)
  });
  vi.stubGlobal('DriveApp', { getFileById: () => ({ makeCopy: (n: string) => { events.push('backup'); return { getId: () => 'backup1', getName: () => n }; }, getParents: () => ({ hasNext: () => false }), moveTo: () => undefined }) });
});

describe('school years', () => {
  it('runs June to May by default and can be changed in Settings', async () => {
    const { schoolYearOf, schoolYearLabel } = await import('../src/archive');
    expect(schoolYearOf('2026-05-31')).toBe(2025);
    expect(schoolYearOf('2026-06-01')).toBe(2026);
    expect(schoolYearLabel(2025)).toBe('SY 2025–2026');
    settings.set('SCHOOL_YEAR_START_MONTH', '1');
    expect(schoolYearOf('2026-05-31')).toBe(2026);
    expect(schoolYearLabel(2026)).toBe('SY 2026');
  });
});

describe('archivePastSchoolYears', () => {
  it('previews only finished RFAs from past school years', async () => {
    const { previewArchive } = await import('../src/archive');
    expect(previewArchive()).toEqual({ 'SY 2025–2026': 2 });
    expect(live(main.get('RFA'))).toHaveLength(4);
  });

  it('backs up first, moves finished past-year RFAs and their records, keeps budgets and current work', async () => {
    const archive = await import('../src/archive');
    const result = archive.archivePastSchoolYears({ FULL_NAME: 'Admin', EMAIL: 'admin@x.edu' }) as { archived: Record<string, number> };

    expect(result.archived).toEqual({ 'SY 2025–2026': 2 });
    expect(events[0]).toBe('backup');
    expect(events.indexOf('create:archive1')).toBeLessThan(events.findIndex((e) => e.startsWith('clear:')));

    expect(live(main.get('RFA')).map((r) => r[0])).toEqual(['old-pending', 'this-year']);
    expect(live(main.get('RFA_APPROVALS')).map((r) => r[0])).toEqual(['a2']);
    expect(live(main.get('RFA_ATTACHMENTS'))).toHaveLength(0);
    expect(live(main.get('RFA_AUDIT')).map((r) => r[0])).toEqual(['l2']);
    expect(live(main.get('NOTIFICATIONS'))).toHaveLength(0);
    expect(live(main.get('BUDGET_TRANSACTIONS'))).toHaveLength(1); // budget ledger never moves

    expect(archivesSheet).toEqual([expect.objectContaining({ SCHOOL_YEAR: 2025, LABEL: 'SY 2025–2026', SPREADSHEET_ID: 'archive1', RFA_COUNT: 2, FISCAL_YEARS: '2025,2026' })]);
    expect(events).toContain('audit:SCHOOL_YEAR_ARCHIVED');
  });

  it('keeps archived RFAs readable by school year and for expense reports', async () => {
    const archive = await import('../src/archive');
    archive.archivePastSchoolYears({ FULL_NAME: 'Admin', EMAIL: 'admin@x.edu' });
    archive.resetArchiveCache();
    expect(archive.archiveYears()).toEqual([{ schoolYear: 2025, label: 'SY 2025–2026', rfaCount: 2 }]);
    const ids = (rows: Array<{ RFA_ID?: unknown }>) => rows.map((r) => r.RFA_ID).sort();
    expect(ids(archive.archivedRows(2025, 'RFA'))).toEqual(['old-approved', 'old-closed']);
    expect(archive.findArchivedRfa('old-closed')?.schoolYear).toBe(2025);
    expect(archive.findArchivedAttachment('f1')?.attachment).toMatchObject({ DRIVE_FILE_ID: 'drive1' });
    expect(ids(archive.rfasWithArchives('2025'))).toEqual(['old-closed', 'old-approved', 'old-pending', 'this-year'].sort());
    expect(ids(archive.rfasWithArchives('2019'))).toEqual(['old-pending', 'this-year']);
  });

  it('does nothing, not even a backup, when there is nothing to archive', async () => {
    main.set('RFA', [row('RFA', { RFA_ID: 'this-year', DATE_FILED: '2026-06-02', STATUS: 'CLOSED' })]);
    const { archivePastSchoolYears } = await import('../src/archive');
    expect(archivePastSchoolYears({ FULL_NAME: 'Admin', EMAIL: 'admin@x.edu' })).toMatchObject({ archived: {} });
    expect(events).not.toContain('backup');
  });
});
