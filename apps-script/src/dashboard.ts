import { adminBudgetSummary } from './budget';
import { toBoolean } from './core';
import { dashboardRfas } from './workflow';
import type { SessionUser } from './types';

/** Targeted dashboard read, not a general application bootstrap/report endpoint. */
export function dashboardHome(user: SessionUser): Record<string, unknown> {
  const result = dashboardRfas(user);
  let budget: Record<string, unknown> | null = null;
  if (toBoolean(user.IS_ADMIN)) {
    // Preserve the previous dashboard's optional financial-summary failure behavior.
    try { budget = adminBudgetSummary(user, String(new Date().getFullYear())); }
    catch { budget = null; }
  }
  return { ...result, budget };
}
