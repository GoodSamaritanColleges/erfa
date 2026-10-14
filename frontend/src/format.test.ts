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
