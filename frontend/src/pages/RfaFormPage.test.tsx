import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { RfaFormPage } from './RfaFormPage';

vi.mock('../api', () => ({ api: vi.fn(), fileToBase64: vi.fn() }));
vi.mock('../auth', () => ({
  useAuth: () => ({ user: { FULL_NAME: 'Requester', DEPARTMENT_NAME: 'IT', POSITION: 'Staff' } })
}));

describe('RfaFormPage expense classification', () => {
  it('shows the school year automatically instead of asking for a fiscal year', () => {
    const html = renderToStaticMarkup(<MemoryRouter initialEntries={['/rfa/new']}><RfaFormPage /></MemoryRouter>);

    expect(html).toContain('School Year');
    expect(html).toMatch(/SY \d{4}–\d{4}/);
    expect(html).toContain('Set automatically from the filing date');
    expect(html).not.toContain('Fiscal Year');
  });

  it('requires OPEX or CAPEX classification without a budget-balance gate', () => {
    const html = renderToStaticMarkup(<MemoryRouter initialEntries={['/rfa/new']}><RfaFormPage /></MemoryRouter>);

    expect(html).toContain('Expense Classification');
    expect(html).toContain('OPEX');
    expect(html).toContain('CAPEX');
    expect(html).not.toContain('Remaining');
    expect(html).not.toContain('purchase request');
    expect(html).not.toContain('Alternate Department Head');
    expect(html).toContain('Recommending Approval');
    expect(html).toContain('Reviewed and Noted By');
    expect(html).toContain('Approved By');
  });
});
