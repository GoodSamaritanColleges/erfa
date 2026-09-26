import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dashboardHome } from '../src/dashboard';
import { adminBudgetSummary } from '../src/budget';
import { dashboardRfas } from '../src/workflow';
import type { SessionUser } from '../src/types';

vi.mock('../src/budget', () => ({ adminBudgetSummary: vi.fn() }));
vi.mock('../src/workflow', () => ({ dashboardRfas: vi.fn() }));
beforeEach(() => { vi.resetAllMocks(); vi.mocked(dashboardRfas).mockReturnValue({ rfas: [], approvals: [] }); });
describe('targeted dashboard consolidation', () => {
  it('does no financial work for a requester', () => {
    expect(dashboardHome({ IS_ADMIN: false } as SessionUser)).toEqual({ rfas: [], approvals: [], budget: null });
    expect(adminBudgetSummary).not.toHaveBeenCalled();
  });
  it('returns the existing authorized summary for admins and keeps summary errors optional', () => {
    vi.mocked(adminBudgetSummary).mockReturnValue({ totals: {} });
    expect(dashboardHome({ IS_ADMIN: true } as SessionUser).budget).toEqual({ totals: {} });
    vi.mocked(adminBudgetSummary).mockImplementation(() => { throw new Error('unavailable'); });
    expect(dashboardHome({ IS_ADMIN: true } as SessionUser).budget).toBeNull();
  });
});
