import { describe, expect, it } from 'vitest';
import { dateInputValue, fiscalYearPattern, isFiscalYear, statusLabel, stepLabel } from './format';

describe('display formatting', () => {
  it('uses recognizable institutional status terminology', () => {
    expect(statusLabel('PENDING_REVIEW')).toBe('Reviewed & Noted');
    expect(stepLabel('APPROVED_BY')).toBe('Approved By');
  });

  it('hydrates HTML date inputs from canonical dates or persisted ISO timestamps', () => {
    expect(dateInputValue('2026-09-10')).toBe('2026-09-10');
    expect(dateInputValue('2026-09-10T00:00:00.000Z')).toBe('2026-09-10');
    expect(dateInputValue('10/09/2026')).toBe('');
  });

  it('accepts only the canonical four-digit fiscal-year format', () => {
    expect(fiscalYearPattern).toBe('[0-9]{4}');
    expect(isFiscalYear('2026')).toBe(true);
    expect(isFiscalYear('026')).toBe(false);
    expect(isFiscalYear('20266')).toBe(false);
    expect(isFiscalYear('20A6')).toBe(false);
    expect(isFiscalYear('')).toBe(false);
  });
});

describe('school years (June to May)', () => {
  it('files May under the old school year and June under the new one', async () => {
    const { schoolYearOf, schoolYearLabel } = await import('./format');
    expect(schoolYearOf('2027-05-31')).toBe(2026);
    expect(schoolYearOf('2027-06-01')).toBe(2027);
    expect(schoolYearOf(new Date('2027-05-31T16:30:00Z'))).toBe(2027); // already June 1 in Manila
    expect(schoolYearLabel(2026)).toBe('SY 2026–2027');
  });
});
