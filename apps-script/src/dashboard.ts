import { expenseMonitoringReport } from './budget';
import { toBoolean } from './core';
import { dashboardRfas } from './workflow';
import type { SessionUser } from './types';

/** Targeted dashboard read, not a general application bootstrap/report endpoint. */
export function dashboardHome(user: SessionUser): Record<string, unknown> {
  const result = dashboardRfas(user);
  let expenseMonitoring: Record<string, unknown> | null = null;
  if (toBoolean(user.IS_ADMIN)) {
    try { expenseMonitoring = expenseMonitoringReport(user, { fiscalYear: String(new Date().getFullYear()) }); }
    catch { expenseMonitoring = null; }
  }
  // `budget` retained as a deprecated alias for backward compatibility.
  return { ...result, expenseMonitoring, budget: expenseMonitoring };
}
