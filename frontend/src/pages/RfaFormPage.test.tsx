import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { RfaFormPage } from './RfaFormPage';

vi.mock('../api', () => ({ api: vi.fn(), fileToBase64: vi.fn() }));
vi.mock('../auth', () => ({
  useAuth: () => ({ user: { FULL_NAME: 'Requester', DEPARTMENT_NAME: 'IT', POSITION: 'Staff' } })
}));

describe('RfaFormPage fiscal year input', () => {
  it('renders the canonical four-digit HTML pattern accepted by the backend', () => {
    const html = renderToStaticMarkup(<MemoryRouter initialEntries={['/rfa/new']}><RfaFormPage /></MemoryRouter>);

    expect(html).toContain('pattern="[0-9]{4}"');
    expect(html).toContain('title="Enter a four-digit fiscal year, for example 2026."');
  });
});
