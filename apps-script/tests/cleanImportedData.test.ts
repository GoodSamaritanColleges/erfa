import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanImportedData } from '../src/admin';

const sheetsData = new Map<string, { headers: string[]; rows: string[][] }>();
vi.mock('../src/store', () => ({
  all: vi.fn((name: string) => {
    const s = sheetsData.get(name);
    if (!s) return [];
    return s.rows.map((r) => Object.fromEntries(s.headers.map((h, i) => [h, r[i]])));
  }),
  allTail: vi.fn(() => []),
  findBy: vi.fn(() => undefined),
  getSetting: vi.fn(() => ''),
  getDatabase: vi.fn(() => ({
    getSheetByName: (name: string) => {
      const s = sheetsData.get(name);
      if (!s) return null;
      return {
        getLastRow: () => s.rows.length + 1,
        getRange: (row: number, col: number, numRows: number, numCols: number) => ({
          getValues: () => s.rows.slice(row - 2, row - 2 + numRows).map((r) => r.slice(col - 1, col - 1 + numCols))
        }),
        deleteRow: (row: number) => { s.rows.splice(row - 2, 1); }
      };
    }
  }))
}));
vi.mock('../src/audit', () => ({ audit: vi.fn() }));
vi.mock('../src/auth', () => ({ requireCapability: vi.fn() }));

const admin = { USER_ID: 'admin', FULL_NAME: 'Admin', EMAIL: 'admin@x.edu', IS_ADMIN: true } as never;

beforeEach(() => {
  vi.clearAllMocks();
  sheetsData.clear();
  sheetsData.set('USERS', { headers: ['USER_ID', 'FULL_NAME', 'EMAIL', 'IS_ADMIN', 'ACTIVE'], rows: [
    ['a1', 'Admin', 'admin@x.edu', 'TRUE', 'TRUE'],
    ['u1', 'Bad1', 'bad1@x.edu', 'FALSE', 'TRUE'],
    ['u2', 'Bad2', 'bad2@x.edu', 'FALSE', 'TRUE']
  ]});
  sheetsData.set('DEPARTMENTS', { headers: ['DEPARTMENT_ID', 'DEPARTMENT_NAME'], rows: [['d1', 'IT']] });
  sheetsData.set('DEPARTMENT_HEADS', { headers: ['HEAD_ID', 'DEPARTMENT_ID', 'USER_ID'], rows: [['h1', 'd1', 'u1']] });
});

describe('cleanImportedData', () => {
  it('keeps admins and rules, deletes other users/departments/heads', () => {
    expect(() => cleanImportedData(admin, { confirm: 'NO' })).toThrow('DELETE');
    const result = cleanImportedData(admin, { confirm: 'DELETE' }) as { usersDeleted: number };
    expect(result.usersDeleted).toBe(2);
    expect(sheetsData.get('USERS')!.rows).toHaveLength(1);
    expect(sheetsData.get('DEPARTMENTS')!.rows).toHaveLength(0);
    expect(sheetsData.get('DEPARTMENT_HEADS')!.rows).toHaveLength(0);
  });
});
