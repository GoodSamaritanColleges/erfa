import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SHEETS } from '../src/constants';

const settings = new Map<string, string>();
let roleRows: unknown[][] = [];
vi.mock('../src/store', () => ({
  all: (name: string) => {
    if (name !== 'ROLES') return [];
    const headers = SHEETS.ROLES as readonly string[];
    return roleRows.filter((r) => r.some((c) => c !== '')).map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i]])));
  },
  getSetting: (k: string) => settings.get(k) ?? '',
  setSetting: (k: string, v: string) => { settings.set(k, v); },
  nowIso: () => '2026-11-12T00:00:00.000Z',
  getDatabase: () => ({
    getSheetByName: () => ({
      getLastRow: () => roleRows.length + 1,
      getRange: (row: number, _c: number, n: number) => ({
        setValues: (vals: unknown[][]) => { if (row >= 2) vals.forEach((v, i) => { roleRows[row - 2 + i] = v; }); },
        clearContent: () => { for (let i = row - 2; i < row - 2 + n; i += 1) roleRows[i] = roleRows[i].map(() => ''); }
      })
    }),
    insertSheet: vi.fn()
  })
}));

const user = (id: string, email: string) => ({ USER_ID: id, FULL_NAME: id, EMAIL: email, ACTIVE: true, CAN_APPROVE_RFA: true }) as never;
const usersById = new Map([['u1', user('u1', 'u1@x.edu')], ['u2', user('u2', 'u2@x.edu')], ['u3', user('u3', 'u3@x.edu')]]);

beforeEach(() => {
  settings.clear(); roleRows = [];
  vi.stubGlobal('SpreadsheetApp', { flush: () => undefined });
});

describe('approval roles', () => {
  it('seeds the original six roles from the older settings until roles are saved', async () => {
    settings.set('APPROVED_MANDATORY_USER_IDS', 'u1,u2');
    settings.set('PRESIDENT_USER_ID', 'u3');
    const { loadRoles } = await import('../src/roles');
    const roles = loadRoles();
    expect(roles.map((r) => r.ROLE_ID)).toEqual(['REVIEWED', 'APPROVED_FIRST', 'VP_FINANCE', 'VP_ACADEMIC', 'PRESIDENT', 'PRINCIPAL']);
    expect(roles.find((r) => r.ROLE_ID === 'VP_FINANCE')).toMatchObject({ USER_ID: 'u2', STAGE: 'APPROVED_BY', CONDITION: 'ALWAYS' });
    expect(roles.find((r) => r.ROLE_ID === 'PRESIDENT')).toMatchObject({ USER_ID: 'u3', CONDITION: 'AT_OR_ABOVE_THRESHOLD', EMAIL_ORDER: 2 });
  });

  it('saves roles, keeps their order, and mirrors the original roles into the older settings', async () => {
    const { saveRoles, loadRoles } = await import('../src/roles');
    saveRoles([
      { ROLE_ID: 'APPROVED_FIRST', TITLE: 'AVP for Finance', STAGE: 'APPROVED_BY', CONDITION: 'ALWAYS', EMAIL_ORDER: 0, ALL_RFAS_ACCESS: true, USER_ID: 'u1', ACTIVE: true },
      { ROLE_ID: '', TITLE: 'Finance Director', STAGE: 'APPROVED_BY', CONDITION: 'AT_OR_ABOVE_THRESHOLD', EMAIL_ORDER: 2, ALL_RFAS_ACCESS: false, USER_ID: 'u2', ACTIVE: true }
    ], usersById);
    const roles = loadRoles();
    expect(roles.map((r) => r.TITLE)).toEqual(['AVP for Finance', 'Finance Director']);
    expect(roles[1].ROLE_ID).toMatch(/^ROLE_/);
    expect(settings.get('APPROVED_MANDATORY_USER_IDS')).toBe('u1,');
  });

  it('rejects unsafe or incomplete roles', async () => {
    const { saveRoles } = await import('../src/roles');
    const base = { STAGE: 'APPROVED_BY', CONDITION: 'ALWAYS', EMAIL_ORDER: 1, ALL_RFAS_ACCESS: true, ACTIVE: true };
    expect(() => saveRoles([], usersById)).toThrow('at least one role');
    expect(() => saveRoles([{ ...base, TITLE: '', USER_ID: 'u1' }], usersById)).toThrow('needs a title');
    expect(() => saveRoles([{ ...base, TITLE: 'Approver', USER_ID: 'missing' }], usersById)).toThrow('active user with approval permission');
    expect(() => saveRoles([{ ...base, TITLE: 'AA', USER_ID: 'u1' }, { ...base, TITLE: 'BB', USER_ID: 'u1' }], usersById)).toThrow('two Approved By roles');
    expect(() => saveRoles([{ ...base, TITLE: 'Principal', CONDITION: 'JHS_SHS_OPTIONAL', USER_ID: 'u1' }], usersById)).toThrow('belongs to Reviewed and Noted By');
  });
});
