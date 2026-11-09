import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SHEETS } from '../src/constants';

type Cell = string | number | boolean;
const sheets = new Map<string, Cell[][]>();
const settings = new Map<string, string>();
const auditCalls: unknown[][] = [];
const trashedFiles: string[] = [];
const trashedFolders: string[] = [];

function row(name: keyof typeof SHEETS, values: Record<string, Cell>): Cell[] {
  return (SHEETS[name] as readonly string[]).map((h) => values[h] ?? '');
}

function fakeSheet(name: string) {
  return {
    getLastRow: () => {
      const rows = sheets.get(name) ?? [];
      let last = rows.length;
      while (last > 0 && rows[last - 1].every((c) => c === '')) last -= 1;
      return last + 1;
    },
    getRange: (r: number, _c: number, n: number, cols: number) => ({
      getValues: () => (sheets.get(name) ?? []).slice(r - 2, r - 2 + n).map((x) => x.slice(0, cols)),
      clearContent: () => { const rows = sheets.get(name)!; for (let i = r - 2; i < r - 2 + n; i += 1) rows[i] = rows[i].map(() => ''); },
      setValues: (vals: Cell[][]) => { const rows = sheets.get(name)!; vals.forEach((v, i) => { rows[r - 2 + i] = [...v]; }); }
    })
  };
}

vi.mock('../src/store', () => ({
  getDatabase: () => ({ getSheetByName: (n: string) => (sheets.has(n) ? fakeSheet(n) : null), getId: () => 'db1', getSpreadsheetTimeZone: () => 'Asia/Manila' }),
  getSetting: (k: string) => settings.get(k) ?? '',
  setSetting: (k: string, v: string) => { settings.set(k, v); },
  resetPerRequestCache: () => undefined
}));
vi.mock('../src/audit', () => ({ audit: (...args: unknown[]) => { auditCalls.push(args); } }));

const folder = (name: string) => {
  const f = { name, getName: () => f.name, setName: (n: string) => { f.name = n; }, setTrashed: () => { trashedFolders.push(f.name); } };
  return f;
};
const iter = <T>(items: T[]) => { let i = 0; return { hasNext: () => i < items.length, next: () => items[i++] }; };

beforeEach(() => {
  sheets.clear(); settings.clear(); auditCalls.length = 0; trashedFiles.length = 0; trashedFolders.length = 0;
  sheets.set('USERS', [row('USERS', { USER_ID: 'u1', EMAIL: 'admin@x.edu', IS_ADMIN: true }), row('USERS', { USER_ID: 'u2', EMAIL: 'vp@other.edu' })]);
  sheets.set('DEPARTMENTS', [row('DEPARTMENTS', { DEPARTMENT_ID: 'd1' })]);
  sheets.set('DEPARTMENT_HEADS', [row('DEPARTMENT_HEADS', { HEAD_ID: 'h1' })]);
  sheets.set('APPROVAL_MATRIX', [row('APPROVAL_MATRIX', { MATRIX_ID: 'm1' })]);
  sheets.set('DEPARTMENT_BUDGETS', [row('DEPARTMENT_BUDGETS', { BUDGET_ID: 'b1' })]);
  sheets.set('EXPENSE_CATEGORIES', [row('EXPENSE_CATEGORIES', { CATEGORY_ID: 'c1' })]);
  sheets.set('RFA', [row('RFA', { RFA_ID: 'r1', RFA_NUMBER: 'RFA-2026-0001' }), row('RFA', { RFA_ID: 'r2', RFA_NUMBER: 'RFA-2026-0002' })]);
  sheets.set('RFA_APPROVALS', [row('RFA_APPROVALS', { APPROVAL_ID: 'a1', RFA_ID: 'r1' })]);
  sheets.set('RFA_ATTACHMENTS', [row('RFA_ATTACHMENTS', { ATTACHMENT_ID: 'f1', RFA_ID: 'r1', DRIVE_FILE_ID: 'drive1' })]);
  sheets.set('NOTIFICATIONS', [row('NOTIFICATIONS', { NOTIFICATION_ID: 'n1', RFA_ID: 'r1' })]);
  sheets.set('RFA_AUDIT', [row('RFA_AUDIT', { LOG_ID: 'l1', RFA_ID: 'r1', ACTION: 'RFA_CREATED' }), row('RFA_AUDIT', { LOG_ID: 'l2', RFA_ID: '', ACTION: 'USER_CREATED' })]);
  sheets.set('BUDGET_TRANSACTIONS', [row('BUDGET_TRANSACTIONS', { TRANSACTION_ID: 't1', RFA_ID: 'r1' }), row('BUDGET_TRANSACTIONS', { TRANSACTION_ID: 't2', RFA_ID: '', TRANSACTION_TYPE: 'ADJUSTMENT_INCREASE' })]);
  settings.set('LAST_RFA_YEAR', '2026'); settings.set('LAST_RFA_SEQUENCE', '2'); settings.set('ATTACHMENT_ROOT_FOLDER_ID', 'root');

  const year = { getFolders: () => iter([folder('RFA-2026-0001'), folder('Shared notes')]) };
  vi.stubGlobal('LockService', { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => undefined }) });
  vi.stubGlobal('SpreadsheetApp', { flush: () => undefined });
  vi.stubGlobal('Utilities', { formatDate: () => '2026-11-09 1600' });
  vi.stubGlobal('DriveApp', {
    getFileById: (id: string) => ({ makeCopy: (n: string) => ({ getId: () => `backup:${n}` }), setTrashed: () => { trashedFiles.push(id); } }),
    getFolderById: () => ({ getFolders: () => iter([year]) })
  });
});

const live = (name: string) => (sheets.get(name) ?? []).filter((r) => r.some((c) => c !== ''));

describe('resetRfas', () => {
  it('previews counts without changing anything', async () => {
    const { previewRfaReset } = await import('../src/resetRfas');
    expect(previewRfaReset()).toEqual({ RFA: 2, RFA_APPROVALS: 1, RFA_ATTACHMENTS: 1, NOTIFICATIONS: 1, RFA_AUDIT: 1, BUDGET_TRANSACTIONS: 1 });
    expect(live('RFA')).toHaveLength(2);
  });

  it('removes only RFA data, keeps accounts and configuration, restarts numbering', async () => {
    const { resetRfas } = await import('../src/resetRfas');
    const result = resetRfas({ FULL_NAME: 'Admin', EMAIL: 'admin@x.edu' }) as { backup: { backupId: string } };

    ['RFA', 'RFA_APPROVALS', 'RFA_ATTACHMENTS', 'NOTIFICATIONS'].forEach((name) => expect(live(name)).toHaveLength(0));
    expect(live('RFA_AUDIT').map((r) => r[0])).toEqual(['l2']);
    expect(live('BUDGET_TRANSACTIONS').map((r) => r[0])).toEqual(['t2']);

    expect(live('USERS')).toHaveLength(2);
    ['DEPARTMENTS', 'DEPARTMENT_HEADS', 'APPROVAL_MATRIX', 'DEPARTMENT_BUDGETS', 'EXPENSE_CATEGORIES'].forEach((name) => expect(live(name)).toHaveLength(1));

    expect(settings.get('LAST_RFA_SEQUENCE')).toBe('0');
    expect(settings.get('LAST_RFA_YEAR')).toBe('2026');
    expect(result.backup.backupId).toContain('backup before RFA reset');
    expect(trashedFiles).toEqual(['drive1']);
    expect(trashedFolders).toEqual(['RFA-2026-0001 (pilot, removed)']);
    expect(auditCalls[0][0]).toBe('RFAS_RESET');
  });
});
