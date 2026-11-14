import { beforeEach, describe, expect, it, vi } from 'vitest';

// A small in-memory spreadsheet that counts calls, to check the save path does less work.
type Row = unknown[];
const sheets = new Map<string, Row[]>(); // includes the header row at index 0
const calls = { fullReads: 0, rowReads: 0, appendRow: 0, setValues: 0 };

function fakeSheet(name: string) {
  const data = () => sheets.get(name)!;
  return {
    getLastRow: () => data().length,
    appendRow: (row: Row) => { calls.appendRow += 1; data().push([...row]); },
    getRange: (row: number, col: number, rows = 1, cols = 1) => ({
      getValues: () => {
        if (rows === 1 && row > 1) calls.rowReads += 1; else calls.fullReads += 1;
        return data().slice(row - 1, row - 1 + rows).map((r) => r.slice(col - 1, col - 1 + cols));
      },
      setValues: (values: Row[]) => {
        calls.setValues += 1;
        values.forEach((value, i) => { const target = row - 1 + i; while (data().length <= target) data().push([]); data()[target] = [...value]; });
      },
      clearContent: () => undefined
    })
  };
}

vi.stubGlobal('PropertiesService', { getScriptProperties: () => ({ getProperty: () => 'db', setProperty: () => undefined }) });
vi.stubGlobal('SpreadsheetApp', { openById: () => ({ getSheetByName: (name: string) => (sheets.has(name) ? fakeSheet(name) : null), getSpreadsheetTimeZone: () => 'Asia/Manila' }), flush: () => undefined });
vi.stubGlobal('CacheService', { getScriptCache: () => ({ get: () => null, put: () => undefined }) });
vi.stubGlobal('Utilities', { getUuid: () => Math.random().toString(36).slice(2), formatDate: () => '' });

const { SHEETS } = await import('../src/constants');
const store = await import('../src/store');

function seed(name: keyof typeof SHEETS, rows: Array<Record<string, unknown>>) {
  const headers = [...SHEETS[name]] as string[];
  sheets.set(name, [headers, ...rows.map((r) => headers.map((h) => r[h] ?? ''))]);
}

beforeEach(() => {
  sheets.clear();
  Object.keys(calls).forEach((k) => { calls[k as keyof typeof calls] = 0; });
  store.resetPerRequestCache();
  seed('RFA', [{ RFA_ID: 'r1', STATUS: 'DRAFT', VERSION: 1 }, { RFA_ID: 'r2', STATUS: 'DRAFT', VERSION: 1 }]);
  seed('RFA_AUDIT', []);
  seed('NOTIFICATIONS', []);
});

describe('faster saves', () => {
  it('updates one row without re-reading the whole sheet, and keeps its copy in step', () => {
    store.all('RFA');
    calls.fullReads = 0;
    store.updateBy('RFA', 'RFA_ID', 'r2', { STATUS: 'SUBMITTED' });
    expect(calls.fullReads).toBe(0);
    expect(calls.rowReads).toBe(1);
    expect(store.all('RFA').find((r) => r.RFA_ID === 'r2')?.STATUS).toBe('SUBMITTED');
    expect(calls.fullReads).toBe(0); // still served from this request's copy
    expect(sheets.get('RFA')![2][1]).toBe(''); // RFA_NUMBER untouched
  });

  it('falls back to a full search when the remembered row moved', () => {
    store.all('RFA');
    sheets.get('RFA')!.splice(1, 1); // someone removed r1 directly in the sheet
    store.updateBy('RFA', 'RFA_ID', 'r2', { STATUS: 'SUBMITTED' });
    const statusCol = (SHEETS.RFA as readonly string[]).indexOf('STATUS');
    expect(sheets.get('RFA')![1][statusCol]).toBe('SUBMITTED');
  });

  it('adds new rows to its copy instead of reloading the sheet', () => {
    store.all('RFA');
    calls.fullReads = 0;
    store.insert('RFA', { RFA_ID: 'r3', STATUS: 'DRAFT' });
    expect(store.all('RFA').map((r) => r.RFA_ID)).toEqual(['r1', 'r2', 'r3']);
    expect(calls.fullReads).toBe(0);
  });

  it('writes audit and notification rows in one batch per sheet', () => {
    store.withBatchedLogs(() => {
      for (let i = 0; i < 4; i += 1) store.insert('RFA_AUDIT', { LOG_ID: `l${i}`, ACTION: 'X' });
      store.insert('NOTIFICATIONS', { NOTIFICATION_ID: 'n1' });
      expect(sheets.get('RFA_AUDIT')!.length).toBe(1); // nothing written yet
    });
    expect(calls.appendRow).toBe(0);
    expect(calls.setValues).toBe(2);
    expect(sheets.get('RFA_AUDIT')!.slice(1).map((r) => r[0])).toEqual(['l0', 'l1', 'l2', 'l3']);
  });

  it('writes pending log rows before anything reads them, and on failure too', () => {
    store.withBatchedLogs(() => {
      store.insert('RFA_AUDIT', { LOG_ID: 'a' });
      expect(store.all('RFA_AUDIT').map((r) => r.LOG_ID)).toEqual(['a']);
    });
    expect(() => store.withBatchedLogs(() => { store.insert('RFA_AUDIT', { LOG_ID: 'b' }); throw new Error('boom'); })).toThrow('boom');
    expect(sheets.get('RFA_AUDIT')!.slice(1).map((r) => r[0])).toEqual(['a', 'b']);
  });
});
