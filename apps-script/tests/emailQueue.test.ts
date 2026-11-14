import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RfaRecord, SessionUser } from '../src/types';

const settings = new Map<string, string>();
const logged: Array<Record<string, unknown>> = [];
vi.mock('../src/store', () => ({
  getSetting: (k: string) => settings.get(k) ?? '',
  settingBoolean: (k: string) => (settings.get(k) ?? '').toUpperCase() === 'TRUE',
  insert: (_name: string, row: Record<string, unknown>) => { logged.push(row); },
  newId: (p: string) => `${p}_${Math.random().toString(36).slice(2, 8)}`,
  nowIso: () => '2026-11-14T00:00:00.000Z',
  withBatchedLogs: <T>(op: () => T) => op()
}));
vi.mock('../src/audit', () => ({ audit: vi.fn() }));

const props = new Map<string, string>();
const sent: string[] = [];
let triggers: string[] = [];
let createTriggerFails = false;
vi.stubGlobal('PropertiesService', { getScriptProperties: () => ({
  getProperty: (k: string) => props.get(k) ?? null,
  setProperty: (k: string, v: string) => { props.set(k, v); },
  setProperties: (entries: Record<string, string>) => { Object.entries(entries).forEach(([k, v]) => props.set(k, v)); },
  getProperties: () => Object.fromEntries(props),
  deleteProperty: (k: string) => { props.delete(k); }
}) });
vi.stubGlobal('LockService', { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => undefined }) });
vi.stubGlobal('MailApp', { sendEmail: (m: { to: string }) => { sent.push(m.to); } });
vi.stubGlobal('ScriptApp', {
  newTrigger: (handler: string) => { const b = { timeBased: () => b, after: () => b, create: () => { if (createTriggerFails) throw new Error('no'); triggers.push(handler); return {}; } }; return b; },
  getProjectTriggers: () => triggers.map((h) => ({ getHandlerFunction: () => h })),
  deleteTrigger: (t: { getHandlerFunction: () => string }) => { triggers = triggers.filter((h) => h !== t.getHandlerFunction()); }
});

const { notify, queuedEmailCount, sendQueuedEmails, withDeferredEmails } = await import('../src/notifications');
const rfa = { RFA_ID: 'r1', RFA_NUMBER: 'RFA-2026-0001', REQUEST_TITLE: 'Chairs', CURRENT_STEP: 'APPROVED_BY' } as RfaRecord;
const actor = { FULL_NAME: 'Head', EMAIL: 'head@example.edu' } as SessionUser;
const person = (email: string) => ({ FULL_NAME: email, EMAIL: email });

beforeEach(() => {
  settings.clear(); settings.set('EMAIL_ENABLED', 'TRUE'); settings.set('FRONTEND_URL', 'https://erfa.example.edu');
  props.clear(); sent.length = 0; logged.length = 0; triggers = []; createTriggerFails = false;
});

describe('email queue', () => {
  it('queues emails from a save and schedules one background run, sending nothing yet', () => {
    withDeferredEmails(() => {
      notify('APPROVAL_REQUIRED', person('a@example.edu'), rfa, actor);
      notify('APPROVAL_REQUIRED', person('b@example.edu'), rfa, actor);
    });
    withDeferredEmails(() => notify('RFA_APPROVED', person('c@example.edu'), rfa, actor));
    expect(sent).toEqual([]);
    expect(queuedEmailCount()).toBe(3);
    expect(triggers).toEqual(['sendQueuedEmails']); // only one run scheduled
  });

  it('the background run sends them in order, logs them and cleans up', () => {
    withDeferredEmails(() => { notify('APPROVAL_REQUIRED', person('a@example.edu'), rfa, actor); notify('RFA_APPROVED', person('b@example.edu'), rfa, actor); });
    expect(sendQueuedEmails()).toEqual({ sent: 2, failed: 0 });
    expect(sent).toEqual(['a@example.edu', 'b@example.edu']);
    expect(logged.map((r) => r.STATUS)).toEqual(['SENT', 'SENT']);
    expect(queuedEmailCount()).toBe(0);
    expect(triggers).toEqual([]);
    expect([...props.keys()]).toEqual([]);
  });

  it('sends right away if the background run cannot be scheduled', () => {
    createTriggerFails = true;
    withDeferredEmails(() => notify('APPROVAL_REQUIRED', person('a@example.edu'), rfa, actor));
    expect(sent).toEqual(['a@example.edu']);
    expect(queuedEmailCount()).toBe(0);
  });

  it('outside a save (reminders, background jobs) it sends immediately as before', () => {
    notify('APPROVAL_REMINDER', person('a@example.edu'), rfa, null);
    expect(sent).toEqual(['a@example.edu']);
    expect(triggers).toEqual([]);
  });

  it('a failed send is logged as FAILED for the daily retry', () => {
    withDeferredEmails(() => notify('APPROVAL_REQUIRED', person('a@example.edu'), rfa, actor));
    vi.stubGlobal('MailApp', { sendEmail: () => { throw new Error('quota'); } });
    expect(sendQueuedEmails()).toEqual({ sent: 0, failed: 1 });
    expect(logged[0]).toMatchObject({ STATUS: 'FAILED', ERROR_MESSAGE: 'quota' });
    vi.stubGlobal('MailApp', { sendEmail: (m: { to: string }) => { sent.push(m.to); } });
  });
});
