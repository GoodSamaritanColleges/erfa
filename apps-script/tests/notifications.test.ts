import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/store', () => ({ getSetting: () => '', insert: vi.fn(), newId: () => 'id', nowIso: () => 'now', settingBoolean: () => false }));
vi.mock('../src/audit', () => ({ audit: vi.fn() }));

import { buildEmail } from '../src/notifications';

const rfa = {
  RFA_ID: 'rfa_1', RFA_NUMBER: 'RFA-2026-0001', REQUEST_TITLE: 'Laboratory supplies', DEPARTMENT_NAME: 'Office of the VPAA',
  REQUESTED_BY: 'Kristine D. Ramos', REQUESTED_AMOUNT: 100000, CURRENT_STEP: 'RECOMMENDING_APPROVAL'
} as never;
const link = 'https://kyojin03.github.io/erfa/#/rfa/rfa_1';

describe('buildEmail', () => {
  it('writes a clear action-required email with friendly step names', () => {
    const { subject, body } = buildEmail('APPROVAL_REQUIRED', 'Alona T. Aquino', rfa, 'This RFA is awaiting your approval action for the RECOMMENDING_APPROVAL section.', link);
    expect(subject).toBe('[eRFA] Action required: RFA-2026-0001 is awaiting your approval');
    expect(body).toContain('Dear Alona T. Aquino,');
    expect(body).toContain('waiting for your review and decision as Recommending Approval.');
    expect(body).toContain('Requested Amount: PHP 1,000.00');
    expect(body).toContain(`Open the request in eRFA: ${link}`);
    expect(body).not.toContain('RECOMMENDING_APPROVAL');
    expect(body).toContain('Thank you,\neRFA - Good Samaritan Colleges');
  });

  it('includes approver remarks when an RFA is returned', () => {
    const { subject, body } = buildEmail('RFA_RETURNED', 'Kristine D. Ramos', rfa, 'Please attach the quotation.', link);
    expect(subject).toBe('[eRFA] RFA-2026-0001 was returned for revision');
    expect(body).toContain('Remarks: Please attach the quotation.');
  });

  it('keeps blank lines between paragraphs', () => {
    const { body } = buildEmail('RFA_SUBMITTED', 'Kristine D. Ramos', rfa, '', link);
    expect(body.startsWith('Dear Kristine D. Ramos,\n\nYour Request for Approval has been submitted')).toBe(true);
  });
});
