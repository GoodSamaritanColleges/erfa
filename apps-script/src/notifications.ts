import { audit } from './audit';
import { getSetting, insert, newId, nowIso, settingBoolean } from './store';
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
