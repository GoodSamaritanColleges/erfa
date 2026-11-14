import { audit } from './audit';
import { normalizeEmail, toBoolean } from './core';
import { buildEmail, notify, sendQueuedEmails } from './notifications';
import { all, getSetting, nowIso, setSetting, settingBoolean, updateBy } from './store';
import type { RfaRecord, SheetRecord, UserRecord } from './types';
import { WAITING_STATUSES, waitingApprovers, waitingSince } from './workflow';

/**
 * Daily follow-ups (7 AM Manila, scheduled by installAutomaticMaintenance):
 *  1. Retry emails that failed in the last 14 days (up to 3 tries each).
 *  2. Remind approvers when an RFA has waited REMINDER_DAYS days (default 3) for them,
 *     then again every REMINDER_DAYS days while it keeps waiting.
 *  3. On Mondays, email administrators the list of RFAs waiting 7 days or more.
 * Runs at night on Google's servers, so it never slows down anyone using eRFA.
 */
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RETRIES = 3;
const RETRY_WINDOW_DAYS = 14;
const STUCK_DAYS = 7;

function reminderDays(): number {
  const days = Number(getSetting('REMINDER_DAYS') || 3);
  return Number.isFinite(days) && days >= 1 ? Math.floor(days) : 3;
}

function remindersEnabled(): boolean {
  const value = String(getSetting('REMINDERS_ENABLED') || 'TRUE');
  return value.toUpperCase() !== 'FALSE';
}

function frontendLink(rfa: RfaRecord): string {
  const base = String(getSetting('FRONTEND_URL') || '').replace(/\/$/, '');
  return base ? `${base}${base.includes('#') ? '' : '/#'}/rfa/${encodeURIComponent(rfa.RFA_ID)}` : '';
}

/** 1. Resend recently failed emails. */
export function retryFailedEmails(now = new Date()): { retried: number; sent: number } {
  if (!settingBoolean('EMAIL_ENABLED')) return { retried: 0, sent: 0 };
  const rfas = new Map(all<RfaRecord>('RFA').map((rfa) => [rfa.RFA_ID, rfa]));
  let retried = 0;
  let sent = 0;
  for (const row of all<SheetRecord>('NOTIFICATIONS')) {
    if (String(row.STATUS) !== 'FAILED' || Number(row.RETRY_COUNT || 0) >= MAX_RETRIES) continue;
    const rfa = rfas.get(String(row.RFA_ID));
    if (!rfa || !row.RECIPIENT_EMAIL) continue;
    // Only resend what still matters: approval emails while that person is still being waited on,
    // other updates only for RFAs changed in the last 14 days. Old failures are never resent.
    const type = String(row.NOTIFICATION_TYPE);
    const stillRelevant = type === 'APPROVAL_REQUIRED' || type === 'APPROVAL_REMINDER'
      ? waitingApprovers(rfa).some((w) => normalizeEmail(w.APPROVER_EMAIL) === normalizeEmail(row.RECIPIENT_EMAIL))
      : now.getTime() - (Date.parse(String(rfa.UPDATED_AT || '')) || 0) <= RETRY_WINDOW_DAYS * DAY_MS;
    if (!stillRelevant) continue;
    retried += 1;
    const tries = Number(row.RETRY_COUNT || 0) + 1;
    try {
      const { subject, body } = buildEmail(String(row.NOTIFICATION_TYPE), String(row.RECIPIENT || ''), rfa, '', frontendLink(rfa));
      MailApp.sendEmail({ to: String(row.RECIPIENT_EMAIL), subject, body, name: 'eRFA' });
      updateBy('NOTIFICATIONS', 'NOTIFICATION_ID', String(row.NOTIFICATION_ID), { STATUS: 'SENT', SENT_AT: nowIso(), RETRY_COUNT: tries, ERROR_MESSAGE: '' });
      sent += 1;
    } catch (error) {
      updateBy('NOTIFICATIONS', 'NOTIFICATION_ID', String(row.NOTIFICATION_ID), { RETRY_COUNT: tries, ERROR_MESSAGE: error instanceof Error ? error.message : String(error) });
    }
  }
  return { retried, sent };
}

/** 2. Remind approvers who have kept an RFA waiting. */
export function sendReminders(now = new Date()): { reminders: number } {
  if (!remindersEnabled() || !settingBoolean('EMAIL_ENABLED')) return { reminders: 0 };
  const every = reminderDays();
  const lastReminder = new Map<string, number>();
  for (const row of all<SheetRecord>('NOTIFICATIONS')) {
    if (String(row.NOTIFICATION_TYPE) !== 'APPROVAL_REMINDER' || String(row.STATUS) !== 'SENT') continue;
    const key = `${row.RFA_ID}|${normalizeEmail(row.RECIPIENT_EMAIL)}`;
    lastReminder.set(key, Math.max(lastReminder.get(key) || 0, Date.parse(String(row.SENT_AT || '')) || 0));
  }
  let reminders = 0;
  for (const rfa of all<RfaRecord>('RFA').filter((item) => WAITING_STATUSES.includes(item.STATUS))) {
    const since = Date.parse(waitingSince(rfa));
    if (!since) continue;
    const days = Math.floor((now.getTime() - since) / DAY_MS);
    if (days < every) continue;
    for (const row of waitingApprovers(rfa)) {
      const key = `${rfa.RFA_ID}|${normalizeEmail(row.APPROVER_EMAIL)}`;
      const last = lastReminder.get(key) || 0;
      if (last && now.getTime() - last < every * DAY_MS) continue;
      notify('APPROVAL_REMINDER', { FULL_NAME: String(row.APPROVER_NAME || ''), EMAIL: String(row.APPROVER_EMAIL || '') } as UserRecord, rfa, null, String(days));
      reminders += 1;
    }
  }
  return { reminders };
}

/** 3. Monday list of RFAs waiting 7 days or more, for administrators. */
export function stuckRfaDigest(now = new Date()): { stuck: number; emailed: boolean } {
  const stuck = all<RfaRecord>('RFA').filter((rfa) => WAITING_STATUSES.includes(rfa.STATUS)).map((rfa) => {
    const since = Date.parse(waitingSince(rfa));
    return { rfa, days: since ? Math.floor((now.getTime() - since) / DAY_MS) : 0, people: waitingApprovers(rfa).map((row) => String(row.APPROVER_NAME || row.APPROVER_EMAIL)) };
  }).filter((item) => item.days >= STUCK_DAYS).sort((a, b) => b.days - a.days);
  if (!stuck.length || !settingBoolean('EMAIL_ENABLED')) return { stuck: stuck.length, emailed: false };
  const admins = all<UserRecord>('USERS').filter((u) => toBoolean(u.IS_ADMIN) && toBoolean(u.ACTIVE) && u.EMAIL).map((u) => String(u.EMAIL));
  if (!admins.length) return { stuck: stuck.length, emailed: false };
  const lines = stuck.map(({ rfa, days, people }) => `- ${rfa.RFA_NUMBER || 'Draft'} · ${rfa.REQUEST_TITLE || 'Untitled'} · waiting ${days} days · with: ${people.join(', ') || 'no approver (check Approval roles)'}`);
  const body = [
    `${stuck.length} RFA${stuck.length === 1 ? ' has' : 's have'} been waiting ${STUCK_DAYS} days or more:`, '',
    ...lines, '',
    'Approvers are reminded automatically. If someone is away or has left, an administrator can hand their pending approvals to another person in eRFA: Administration → Users → Hand over pending approvals.', '',
    'eRFA - automatic follow-ups'
  ].join('\n');
  try { MailApp.sendEmail({ to: [...new Set(admins)].join(','), subject: `[eRFA] ${stuck.length} RFA${stuck.length === 1 ? '' : 's'} waiting ${STUCK_DAYS}+ days`, body, name: 'eRFA' }); }
  catch { return { stuck: stuck.length, emailed: false }; }
  return { stuck: stuck.length, emailed: true };
}

export function runDailyFollowUpsJob(now = new Date()): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  // Safety net: send anything still waiting in the email queue (normally sent within a minute).
  try { result.queued = sendQueuedEmails(); } catch (e) { result.queuedError = String(e); }
  try { result.retries = retryFailedEmails(now); } catch (e) { result.retriesError = String(e); }
  try { result.reminders = sendReminders(now); } catch (e) { result.remindersError = String(e); }
  const manilaWeekday = new Date(now.getTime() + 8 * 60 * 60 * 1000).getUTCDay();
  if (manilaWeekday === 1) { try { result.digest = stuckRfaDigest(now); } catch (e) { result.digestError = String(e); } }
  setSetting('LAST_FOLLOWUPS_AT', nowIso(), 'Last daily follow-up run (reminders, email retries) (set by eRFA)');
  audit('DAILY_FOLLOWUPS_RAN', null, '', '', '', 'Daily follow-ups ran.', result);
  return result;
}
