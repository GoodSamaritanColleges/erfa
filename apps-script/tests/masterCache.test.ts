import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SHEETS } from '../src/constants';
import { authenticate, requireCapability } from '../src/auth';
import { all, insert, resetPerRequestCache, updateBy } from '../src/store';
import { mutateMasterData, readMasterData } from '../src/masterCache';
import type { SheetRecord } from '../src/types';

vi.mock('../src/audit', () => ({ audit: vi.fn() }));

const rows = new Map<string, unknown[][]>();
const properties = new Map<string, string>();
const cacheRows = new Map<string, string>();
const reads = vi.fn();
const cache = { get: vi.fn((key: string) => cacheRows.get(key) ?? null), put: vi.fn((key: string, value: string, _ttl: number) => { cacheRows.set(key, value); }) };
const propertyStore = { getProperty: vi.fn((key: string) => properties.get(key) ?? null), setProperty: vi.fn((key: string, value: string) => { properties.set(key, value); }) };
let sequence = 0;

function record(name: keyof typeof SHEETS, fields: SheetRecord): unknown[] {
  return SHEETS[name].map((header) => fields[header] ?? '');
}

const db = { getSheetByName: (name: string) => ({
  getLastRow: () => (rows.get(name)?.length || 0) + 1,
  getRange: (start: number, _column: number, count: number) => ({
    getValues: () => { reads(name); return rows.get(name)!.slice(start - 2, start - 2 + count).map((row) => [...row]); },
    setValues: (values: unknown[][]) => { rows.get(name)!.splice(start - 2, values.length, ...values); }
  }),
  appendRow: (row: unknown[]) => { rows.get(name)!.push(row); }
}) };
const open = vi.fn(() => db);

beforeEach(() => {
  vi.clearAllMocks();
  cache.get.mockImplementation((key) => cacheRows.get(key) ?? null);
  propertyStore.getProperty.mockImplementation((key) => properties.get(key) ?? null);
  propertyStore.setProperty.mockImplementation((key, value) => { properties.set(key, value); });
  rows.clear(); properties.clear(); cacheRows.clear(); resetPerRequestCache();
  properties.set('ERFA_SPREADSHEET_ID', 'database');
  rows.set('SETTINGS', [record('SETTINGS', { KEY: 'GOOGLE_CLIENT_ID', VALUE: 'client' }), record('SETTINGS', { KEY: 'ALLOWED_DOMAIN', VALUE: '' })]);
  rows.set('USERS', [record('USERS', { USER_ID: 'u1', EMAIL: 'admin@example.edu', FULL_NAME: 'Admin', ACTIVE: true, IS_ADMIN: true, CAN_CREATE_RFA: true, CAN_APPROVE_RFA: true, DEPARTMENT_ID: 'd1' })]);
  rows.set('DEPARTMENTS', [record('DEPARTMENTS', { DEPARTMENT_ID: 'd1', DEPARTMENT_NAME: 'Office', ACTIVE: true })]);
  rows.set('BUDGET_TRANSACTIONS', []);
  cacheRows.set('idtoken:digest', JSON.stringify({ aud: 'client', iss: 'accounts.google.com', email_verified: 'true', email: 'admin@example.edu', exp: 4102444800 }));
  vi.stubGlobal('PropertiesService', { getScriptProperties: () => propertyStore });
  vi.stubGlobal('CacheService', { getScriptCache: () => cache });
  vi.stubGlobal('SpreadsheetApp', { openById: open, flush: vi.fn() });
  vi.stubGlobal('Utilities', { getUuid: () => `generation-${++sequence}`, computeDigest: () => [1], base64EncodeWebSafe: () => 'digest', DigestAlgorithm: { SHA_256: 'sha256' } });
});

describe('server-side master-data caching', () => {
  it('reuses SETTINGS, USERS and DEPARTMENTS across request-cache resets without Sheets access', () => {
    expect(authenticate('token').DEPARTMENT_NAME).toBe('Office');
    expect(reads.mock.calls.map(([name]) => name)).toEqual(['SETTINGS', 'USERS', 'DEPARTMENTS']);
    reads.mockClear(); open.mockClear(); resetPerRequestCache();
    expect(authenticate('token').EMAIL).toBe('admin@example.edu');
    expect(reads).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(cache.put.mock.calls.map(([, , ttl]) => ttl)).toEqual([300, 60, 300]);
  });

  it('invalidates disabled-user and capability state after administrative writes', () => {
    authenticate('token');
    updateBy('USERS', 'USER_ID', 'u1', { CAN_APPROVE_RFA: false });
    resetPerRequestCache();
    expect(() => requireCapability(authenticate('token'), 'CAN_APPROVE_RFA')).toThrow('permission');
    updateBy('USERS', 'USER_ID', 'u1', { ACTIVE: false });
    resetPerRequestCache();
    expect(() => authenticate('token')).toThrow('inactive');
  });

  it('invalidates settings, departments and inserted users through the common write paths', () => {
    authenticate('token');
    updateBy('SETTINGS', 'KEY', 'GOOGLE_CLIENT_ID', { VALUE: 'new-client' });
    resetPerRequestCache();
    expect(() => authenticate('token')).toThrow('audience');
    updateBy('SETTINGS', 'KEY', 'GOOGLE_CLIENT_ID', { VALUE: 'client' });
    updateBy('DEPARTMENTS', 'DEPARTMENT_ID', 'd1', { DEPARTMENT_NAME: 'Updated' });
    insert('USERS', { USER_ID: 'u2', EMAIL: 'other@example.edu' });
    resetPerRequestCache();
    expect(authenticate('token').DEPARTMENT_NAME).toBe('Updated');
    expect(all('USERS')).toHaveLength(2);
  });

  it('falls back to Sheets on misses, corrupted entries and cache service failure', () => {
    all('USERS'); resetPerRequestCache();
    const key = [...cacheRows.keys()].find((key) => key.includes(':USERS:'))!;
    cacheRows.set(key, '{invalid');
    all('USERS'); expect(reads).toHaveBeenCalledTimes(2);
    resetPerRequestCache(); cache.get.mockImplementation(() => { throw new Error('cache unavailable'); });
    expect(all('USERS')).toHaveLength(1);
    expect(reads).toHaveBeenCalledTimes(3);
  });

  it('does not cache financial/transactional records across requests', () => {
    all('BUDGET_TRANSACTIONS'); resetPerRequestCache(); all('BUDGET_TRANSACTIONS');
    expect(cache.get).not.toHaveBeenCalled();
  });

  it('prevents a pre-write reader from repopulating the current generation', () => {
    const source = vi.fn(() => {
      mutateMasterData('USERS', () => undefined);
      return [{ EMAIL: 'old@example.edu' }];
    });
    readMasterData('USERS', source);
    expect(cache.put).not.toHaveBeenCalled();
  });

  it('keeps cache bypassed if a master write fails', () => {
    all('USERS');
    expect(() => mutateMasterData('USERS', () => { throw new Error('failed'); })).toThrow('failed');
    resetPerRequestCache(); cache.get.mockClear();
    all('USERS');
    expect(cache.get).not.toHaveBeenCalled();
    expect(reads).toHaveBeenCalledTimes(2);
  });

  it('bypasses caches if generation lookup or final publication fails', () => {
    all('USERS'); resetPerRequestCache();
    propertyStore.getProperty.mockImplementationOnce(() => { throw new Error('properties unavailable'); });
    expect(all('USERS')).toHaveLength(1);
    expect(reads).toHaveBeenCalledTimes(2);
    propertyStore.setProperty.mockImplementation((key, value) => {
      if (!value.startsWith('writing:')) throw new Error('publication failed');
      properties.set(key, value);
    });
    expect(() => updateBy('USERS', 'USER_ID', 'u1', { ACTIVE: false })).toThrow('publication failed');
    resetPerRequestCache();
    expect(() => authenticate('token')).toThrow('inactive');
  });

  it('refreshes an administrator-changed department assignment on the next request', () => {
    authenticate('token');
    insert('DEPARTMENTS', { DEPARTMENT_ID: 'd2', DEPARTMENT_NAME: 'New Office' });
    updateBy('USERS', 'USER_ID', 'u1', { DEPARTMENT_ID: 'd2' });
    resetPerRequestCache();
    expect(authenticate('token').DEPARTMENT_NAME).toBe('New Office');
  });

  it('preserves issuer, expiry, and verified-email checks even on cache hits', () => {
    for (const invalid of [{ iss: 'invalid' }, { exp: 1 }, { email_verified: 'false' }]) {
      cacheRows.set('idtoken:digest', JSON.stringify({ aud: 'client', iss: 'accounts.google.com', email_verified: 'true', email: 'admin@example.edu', exp: 4102444800, ...invalid }));
      expect(() => authenticate('token')).toThrow();
    }
  });
});
