import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { Layout } from './components';

vi.mock('./auth', () => ({
  useAuth: () => ({ user: {
    FULL_NAME: 'Admin', EMAIL: 'admin@example.edu', IS_ADMIN: true,
    CAN_CREATE_RFA: true, CAN_APPROVE_RFA: true
  }, signOut: vi.fn() })
}));

describe('sidebar active navigation', () => {
  it.each([
    ['/', '/'],
    ['/rfas', '/rfas'],
    ['/rfa/new', '/rfa/new'],
    ['/approvals', '/approvals'],
    ['/admin', '/admin'],
    ['/admin/budgets', '/admin/budgets'],
    ['/admin/budget-reports', '/admin/budget-reports']
  ])('marks only %s as active', (route, expectedHref) => {
    const html = renderToStaticMarkup(<MemoryRouter initialEntries={[route]}><Layout /></MemoryRouter>);
    for (const navClass of route === '/admin/budget-reports' ? ['sidebar-nav'] : ['sidebar-nav', 'mobile-nav']) {
      const nav = html.match(new RegExp(`<nav class="${navClass}"[^>]*>(.*?)</nav>`))?.[1] || '';
      const activeHrefs = [...nav.matchAll(/<a(?=[^>]*class="active")(?=[^>]*href="([^"]+)")[^>]*>/g)].map((match) => match[1]);
      expect(activeHrefs).toEqual([expectedHref]);
    }
  });
});
