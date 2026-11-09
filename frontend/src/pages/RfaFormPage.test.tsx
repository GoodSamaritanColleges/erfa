import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { RfaFormPage } from './RfaFormPage';

vi.mock('../api', () => ({ api: vi.fn(), fileToBase64: vi.fn() }));
vi.mock('../auth', () => ({
  useAuth: () => ({ user: { FULL_NAME: 'Requester', DEPARTMENT_NAME: 'IT', POSITION: 'Staff' } })
}));

describe('RfaFormPage expense classification', () => {
  it('renders the canonical four-digit HTML pattern accepted by the backend', () => {
    const html = renderToStaticMarkup(<MemoryRouter initialEntries={['/rfa/new']}><RfaFormPage /></MemoryRouter>);

    expect(html).toContain('pattern="[0-9]{4}"');
    expect(html).toContain('title="Enter a four-digit fiscal year, for example 2026."');
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
