import { audit } from './audit';
import { getSetting, insert, newId, nowIso, settingBoolean, withBatchedLogs } from './store';
import type { RfaRecord, SessionUser, UserRecord } from './types';

export const STEP_LABELS: Record<string, string> = {
  PREPARED_BY: 'Prepared By', RECOMMENDING_APPROVAL: 'Recommending Approval', REVIEWED_AND_NOTED: 'Reviewed and Noted By',
  REVIEWED_BY: 'Reviewed By', NOTED_BY: 'Noted By', INVOLVED_DEPARTMENT_HEAD: 'Involved Department Head', APPROVED_BY: 'Approved By'
};

interface EmailCopy { subject: (rfa: RfaRecord) => string; opening: (rfa: RfaRecord, step: string, remarks: string) => string; showRemarks?: boolean; showStep?: boolean }

const EMAIL_COPY: Record<string, EmailCopy> = {
  APPROVAL_REMINDER: {
    subject: (rfa) => `Reminder: ${rfa.RFA_NUMBER} is still awaiting your approval`,
    opening: (_rfa, step, days) => `This is a friendly reminder. A Request for Approval has been waiting${days ? ` ${days} days` : ''} for your review and decision${step ? ` as ${step}` : ''}.`,
    showStep: true
  },
  APPROVAL_REQUIRED: {
    subject: (rfa) => `Action required: ${rfa.RFA_NUMBER} is awaiting your approval`,
    opening: (_rfa, step) => `A Request for Approval is waiting for your review and decision${step ? ` as ${step}` : ''}.`,
    showStep: true
  },
  RFA_SUBMITTED: {
    subject: (rfa) => `${rfa.RFA_NUMBER} has been submitted`,
    opening: () => 'Your Request for Approval has been submitted and sent to the first approver. You will receive an email when it moves forward or needs your attention.',
    showStep: true
  },
  RFA_RESUBMITTED: {
    subject: (rfa) => `${rfa.RFA_NUMBER} has been resubmitted`,
    opening: () => 'Your revised Request for Approval has been resubmitted and sent back for approval.',
    showStep: true
  },
  RFA_RETURNED: {
    subject: (rfa) => `${rfa.RFA_NUMBER} was returned for revision`,
    opening: () => 'Your Request for Approval was returned for revision. Please review the remarks below, update your request, and resubmit it in eRFA.',
    showRemarks: true
  },
  RFA_DISAPPROVED: {
    subject: (rfa) => `${rfa.RFA_NUMBER} was disapproved`,
    opening: () => 'Your Request for Approval was disapproved. Please see the remarks below for the reason.',
    showRemarks: true
  },
  RFA_APPROVED: {
    subject: (rfa) => `${rfa.RFA_NUMBER} has been approved`,
    opening: () => 'Good news! Your Request for Approval has received final approval.'
  },
  RFA_CLOSED: {
    subject: (rfa) => `${rfa.RFA_NUMBER} has been closed`,
    opening: () => 'Your Request for Approval has been closed. No further action is needed.'
  },
  WORKFLOW_EXCEPTION: {
    subject: (rfa) => `${rfa.RFA_NUMBER} needs administrator attention`,
    opening: () => 'This Request for Approval could not be routed because no valid approver is configured for the next step. Please review the approval settings in eRFA.',
    showRemarks: true
  }
};

function formatPeso(rfa: RfaRecord): string {
  const centavos = Number(rfa.REQUESTED_AMOUNT || 0);
  const pesos = centavos ? centavos / 100 : Number(rfa.BUDGET_ALLOCATION || 0);
  if (!pesos) return '';
  return `PHP ${pesos.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Builds the plain-text email for a notification type. Exported for tests. */
export function buildEmail(type: string, recipientName: string, rfa: RfaRecord, remarks: string, link: string): { subject: string; body: string } {
  const copy = EMAIL_COPY[type] ?? { subject: (r: RfaRecord) => `${r.RFA_NUMBER} was updated`, opening: () => 'There is an update on your Request for Approval.' };
  const step = STEP_LABELS[String(rfa.CURRENT_STEP)] || '';
  const amount = formatPeso(rfa);
  const lines: Array<string | null> = [
    `Dear ${recipientName || 'eRFA user'},`, '',
    copy.opening(rfa, step, remarks), '',
    'Request details:',
    `  RFA Number: ${rfa.RFA_NUMBER}`,
    `  Request Title: ${rfa.REQUEST_TITLE || 'Untitled request'}`,
    `  Department: ${rfa.DEPARTMENT_NAME || '-'}`,
    `  Requested By: ${rfa.REQUESTED_BY || '-'}`,
    amount ? `  Requested Amount: ${amount}` : null,
    copy.showStep && step ? `  Current Step: ${step}` : null,
    copy.showRemarks && remarks ? '' : null,
    copy.showRemarks && remarks ? `Remarks: ${remarks}` : null,
    '',
    link ? `Open the request in eRFA: ${link}` : 'Please sign in to eRFA to view the request.',
    '',
    'All approval decisions must be made in eRFA. Please do not reply to this email; it is an automated notification.',
    '',
    'Thank you,',
    'eRFA - Good Samaritan Colleges'
  ];
  return { subject: `[eRFA] ${copy.subject(rfa)}`, body: lines.filter((line): line is string => line !== null).join('\n') };
}

interface OutgoingEmail {
  rfaId: string; type: string; toName: string; toEmail: string; subject: string; body: string;
  actorName: string; actorEmail: string;
}

/**
 * Notification emails. While a change is being saved (see withDeferredEmails) they are not sent
 * on the spot: they are queued and a one-time background job sends them within about a minute,
 * so Approve/Submit answer faster. If the queue cannot be used, they are sent immediately.
 * Background jobs (reminders, the queue itself) send immediately.
 */
export function notify(
  type: string,
  recipient: Pick<UserRecord, 'FULL_NAME' | 'EMAIL'>,
  rfa: RfaRecord,
  actor: SessionUser | null,
  remarks = ''
): void {
  const frontendUrl = getSetting('FRONTEND_URL').replace(/\/$/, '');
  const link = frontendUrl ? `${frontendUrl}${frontendUrl.includes('#') ? '' : '/#'}/rfa/${encodeURIComponent(rfa.RFA_ID)}` : '';
  const { subject, body } = buildEmail(type, recipient.FULL_NAME, rfa, remarks, link);
  const email: OutgoingEmail = { rfaId: rfa.RFA_ID, type, toName: recipient.FULL_NAME, toEmail: recipient.EMAIL, subject, body, actorName: actor?.FULL_NAME ?? '', actorEmail: actor?.EMAIL ?? '' };
  if (deferring) outbox.push(email);
  else sendNow([email]);
}

const outbox: OutgoingEmail[] = [];
let deferring = 0;

/** Run a change with its emails collected, then queued for the background sender. */
export function withDeferredEmails<T>(operation: () => T): T {
  deferring += 1;
  try { return operation(); }
  finally {
    deferring -= 1;
    if (!deferring && outbox.length) releaseOutbox(outbox.splice(0));
  }
}

export const EMAIL_QUEUE_PREFIX = 'ERFA_EMAILQ_';
const EMAIL_QUEUE_TRIGGER_KEY = 'ERFA_EMAILQ_SCHEDULED_AT';
export const EMAIL_QUEUE_HANDLER = 'sendQueuedEmails';
const MAX_PROPERTY_CHARS = 8500;           // Apps Script keeps at most 9 KB per stored value
const SCHEDULE_STALE_MS = 15 * 60 * 1000;   // reschedule if a planned run never happened

function releaseOutbox(emails: OutgoingEmail[]): void {
  if (!settingBoolean('EMAIL_ENABLED')) { sendNow(emails); return; } // logs them as not sent, as before
  const fits = emails.filter((email) => JSON.stringify(email).length <= MAX_PROPERTY_CHARS);
  const tooLarge = emails.filter((email) => !fits.includes(email));
  try {
    if (fits.length) queueForLater(fits);
  } catch {
    sendNow(fits); // the queue is unavailable: send now rather than lose them
  }
  if (tooLarge.length) sendNow(tooLarge);
}

function queueForLater(emails: OutgoingEmail[]): void {
  const properties = PropertiesService.getScriptProperties();
  const scheduledAt = Number(properties.getProperty(EMAIL_QUEUE_TRIGGER_KEY) || 0);
  if (!scheduledAt || Date.now() - scheduledAt > SCHEDULE_STALE_MS) {
    ScriptApp.newTrigger(EMAIL_QUEUE_HANDLER).timeBased().after(5 * 1000).create();
    properties.setProperty(EMAIL_QUEUE_TRIGGER_KEY, String(Date.now()));
  }
  const stamp = Date.now();
  const entries: Record<string, string> = {};
  emails.forEach((email, index) => { entries[`${EMAIL_QUEUE_PREFIX}${stamp}_${String(index).padStart(3, '0')}_${newId('m')}`] = JSON.stringify(email); });
  properties.setProperties(entries);
}

/**
 * Background job (scheduled automatically): send every queued email. Takes the queue under the
 * script lock, sends without holding it, then writes the delivery log under the lock again.
 */
export function sendQueuedEmails(): { sent: number; failed: number } {
  const properties = PropertiesService.getScriptProperties();
  const lock = LockService.getScriptLock();
  let emails: OutgoingEmail[] = [];
  if (!lock.tryLock(30000)) return { sent: 0, failed: 0 }; // try again on the next run
  try {
    const stored = properties.getProperties();
    const keys = Object.keys(stored).filter((key) => key.startsWith(EMAIL_QUEUE_PREFIX) && key !== EMAIL_QUEUE_TRIGGER_KEY).sort();
    emails = keys.map((key) => { try { return JSON.parse(stored[key]) as OutgoingEmail; } catch { return null; } }).filter((email): email is OutgoingEmail => Boolean(email));
    keys.forEach((key) => properties.deleteProperty(key));
    properties.deleteProperty(EMAIL_QUEUE_TRIGGER_KEY);
    try { ScriptApp.getProjectTriggers().filter((trigger) => trigger.getHandlerFunction() === EMAIL_QUEUE_HANDLER).forEach((trigger) => ScriptApp.deleteTrigger(trigger)); } catch { /* finished one-time triggers may already be gone */ }
  } finally { lock.releaseLock(); }
  const results = emails.map((email) => deliver(email));
  if (results.length) {
    if (!lock.tryLock(30000)) { results.forEach(logDelivery); return countResults(results); }
    try { withBatchedLogs(() => results.forEach(logDelivery)); } finally { lock.releaseLock(); }
  }
  return countResults(results);
}

/** How many emails are waiting in the queue (for the admin status page and tests). */
export function queuedEmailCount(): number {
  try { return Object.keys(PropertiesService.getScriptProperties().getProperties()).filter((key) => key.startsWith(EMAIL_QUEUE_PREFIX) && key !== EMAIL_QUEUE_TRIGGER_KEY).length; }
  catch { return 0; }
}

interface Delivery { email: OutgoingEmail; sentAt: string; error: string; disabled: boolean }

function deliver(email: OutgoingEmail): Delivery {
  try {
    if (!settingBoolean('EMAIL_ENABLED')) return { email, sentAt: '', error: 'Email delivery is disabled by system configuration.', disabled: true };
    MailApp.sendEmail({ to: email.toEmail, subject: email.subject, body: email.body, name: 'eRFA' });
    return { email, sentAt: nowIso(), error: '', disabled: false };
  } catch (error) {
    return { email, sentAt: '', error: error instanceof Error ? error.message : String(error), disabled: false };
  }
}

function logDelivery({ email, sentAt, error, disabled }: Delivery): void {
  const actor = email.actorEmail || email.actorName ? { FULL_NAME: email.actorName, EMAIL: email.actorEmail } as SessionUser : null;
  insert('NOTIFICATIONS', {
    NOTIFICATION_ID: newId('ntf'), RFA_ID: email.rfaId, RECIPIENT: email.toName,
    RECIPIENT_EMAIL: email.toEmail, NOTIFICATION_TYPE: email.type, SUBJECT: email.subject,
    SENT_AT: sentAt, STATUS: sentAt ? 'SENT' : (disabled ? 'PENDING' : 'FAILED'), ERROR_MESSAGE: error, RETRY_COUNT: 0
  });
  if (sentAt) audit('EMAIL_SENT', actor, email.rfaId, '', '', email.type, { recipient: email.toEmail });
  else audit('EMAIL_FAILED', actor, email.rfaId, '', '', error, { recipient: email.toEmail, type: email.type });
}

function countResults(results: Delivery[]): { sent: number; failed: number } {
  return { sent: results.filter((r) => r.sentAt).length, failed: results.filter((r) => !r.sentAt).length };
}

function sendNow(emails: OutgoingEmail[]): void {
  emails.forEach((email) => logDelivery(deliver(email)));
}
