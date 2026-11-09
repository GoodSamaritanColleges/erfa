import { beforeEach, describe, expect, it, vi } from 'vitest';
import { importUsersFromList } from '../src/importUsers';
import type { SheetRecord } from '../src/types';

const sheets = new Map<string, SheetRecord[]>();
vi.mock('../src/store', () => ({
  all: vi.fn((name: string) => (sheets.get(name) || []).map((row) => ({ ...row }))),
  findBy: vi.fn((name: string, key: string, value: string) => sheets.get(name)?.find((row) => String(row[key]) === value)),
  insert: vi.fn((name: string, row: SheetRecord) => { sheets.set(name, [...(sheets.get(name) || []), row]); }),
  updateBy: vi.fn((name: string, key: string, value: string, update: SheetRecord) => { const row = sheets.get(name)?.find((item) => String(item[key]) === value); if (row) Object.assign(row, update); }),
  newId: vi.fn((prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 8)}`),
  nowIso: vi.fn(() => '2026-09-30T00:00:00Z')
}));
vi.mock('../src/audit', () => ({ audit: vi.fn() }));
vi.mock('../src/auth', () => ({ requireCapability: vi.fn() }));

const admin = { USER_ID: 'admin', FULL_NAME: 'Admin', EMAIL: 'a@x.edu', IS_ADMIN: true } as never;

beforeEach(() => {
  vi.clearAllMocks();
  sheets.clear();
  sheets.set('DEPARTMENTS', []);
  sheets.set('USERS', []);
  sheets.set('DEPARTMENT_HEADS', []);
});

describe('importUsersFromList', () => {
  it('inserts missing and overwrites department/designation for existing', () => {
    sheets.set('USERS', [{ USER_ID: 'u1', FULL_NAME: 'Existing', EMAIL: 'existing@x.edu', DEPARTMENT_ID: 'old', POSITION: 'Old', ACTIVE: true }]);
    const result = importUsersFromList(admin, {
      departments: [{ departmentName: 'IT', departmentCode: 'IT', isAcademic: false }, { departmentName: 'IT', departmentCode: 'IT', isAcademic: false }],
      users: [
        { fullName: 'Existing', email: 'existing@x.edu', departmentCode: 'IT', position: 'Dean' },
        { fullName: 'New User', email: 'new@x.edu', departmentCode: 'IT', canCreateRfa: true, canApproveRfa: true, position: 'Clerk' },
        { fullName: 'No Email', email: '', departmentCode: 'IT' }
      ],
      heads: [{ departmentCode: 'IT', userEmail: 'new@x.edu' }]
    }) as { createdDepartments: string[]; createdUsers: string[]; updatedUsers: string[]; createdHeads: string[]; skippedUsers: unknown[] };
    expect(result.createdDepartments).toHaveLength(1);
    expect(result.createdUsers).toEqual(['new@x.edu']);
    expect(result.updatedUsers).toEqual(['existing@x.edu']);
    expect(result.createdHeads).toHaveLength(1);
    const existing = (sheets.get('USERS') || []).find((u) => u.EMAIL === 'existing@x.edu') as Record<string, unknown>;
    expect(existing.POSITION).toBe('Dean');
    expect(existing.DEPARTMENT_ID).toBeTruthy();
    expect((sheets.get('USERS') || [])).toHaveLength(2);
  });
});
