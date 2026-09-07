import { audit } from './audit';
import { getSetting, insert, newId, nowIso, settingBoolean } from './store';
import type { RfaRecord, SessionUser, UserRecord } from './types';

const labels: Record<string, string> = {
  RECOMMENDING_APPROVAL: 'Recommending Approval', REVIEWED_AND_NOTED: 'Reviewed and Noted', REVIEWED_BY: 'Reviewed By', NOTED_BY: 'Noted By', APPROVED_BY: 'Approved By'
};

export function notify(
  type: string,
  recipient: Pick<UserRecord, 'FULL_NAME' | 'EMAIL'>,
  rfa: RfaRecord,
  actor: SessionUser | null,
  remarks = ''
): void {
  const actionRequired = type === 'APPROVAL_REQUIRED';
  const subject = actionRequired ? `[eRFA] Action required: ${rfa.RFA_NUMBER}` : `[eRFA] ${rfa.RFA_NUMBER} - ${type.replaceAll('_', ' ')}`;
  const frontendUrl = getSetting('FRONTEND_URL').replace(/\/$/, '');
  const link = frontendUrl ? `${frontendUrl}${frontendUrl.includes('#') ? '' : '/#'}/rfa/${encodeURIComponent(rfa.RFA_ID)}` : '';
  const body = [
    `Hello ${recipient.FULL_NAME || 'eRFA user'},`, '',
    `RFA Number: ${rfa.RFA_NUMBER}`,
    `Request Title: ${rfa.REQUEST_TITLE}`,
    `Department: ${rfa.DEPARTMENT_NAME}`,
    `Requester: ${rfa.REQUESTED_BY}`,
    `Current Step: ${labels[rfa.CURRENT_STEP] || rfa.CURRENT_STEP || rfa.STATUS}`,
    actionRequired ? 'Action Required: Review this request inside the eRFA web application.' : `Update: ${type.replaceAll('_', ' ')}`,
    remarks ? `Remarks: ${remarks}` : '',
    link ? `Secure Link: ${link}` : '', '',
    'Approval decisions must be completed inside eRFA. This email is only a notification.'
  ].filter(Boolean).join('\n');
  const log = {
    NOTIFICATION_ID: newId('ntf'), RFA_ID: rfa.RFA_ID, RECIPIENT: recipient.FULL_NAME,
    RECIPIENT_EMAIL: recipient.EMAIL, NOTIFICATION_TYPE: type, SUBJECT: subject,
    SENT_AT: '', STATUS: 'PENDING', ERROR_MESSAGE: '', RETRY_COUNT: 0
  };
  try {
    if (!settingBoolean('EMAIL_ENABLED')) throw new Error('Email delivery is disabled by system configuration.');
    MailApp.sendEmail({ to: recipient.EMAIL, subject, body, name: 'eRFA' });
    log.SENT_AT = nowIso();
    log.STATUS = 'SENT';
    insert('NOTIFICATIONS', log);
    audit('EMAIL_SENT', actor, rfa.RFA_ID, '', '', type, { recipient: recipient.EMAIL });
  } catch (error) {
    log.STATUS = settingBoolean('EMAIL_ENABLED') ? 'FAILED' : 'PENDING';
    log.ERROR_MESSAGE = error instanceof Error ? error.message : String(error);
    insert('NOTIFICATIONS', log);
    audit('EMAIL_FAILED', actor, rfa.RFA_ID, '', '', log.ERROR_MESSAGE, { recipient: recipient.EMAIL, type });
  }
}
