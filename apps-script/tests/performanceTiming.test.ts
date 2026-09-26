import { afterEach, describe, expect, it, vi } from 'vitest';
import { beginPerformance, performanceSnapshot, timed } from '../src/performance';

afterEach(() => { vi.restoreAllMocks(); beginPerformance(false); });

describe('opt-in performance timings', () => {
  it('does not collect metadata when disabled', () => {
    beginPerformance(false);
    expect(timed('handlerMs', () => 42)).toBe(42);
    expect(performanceSnapshot()).toBeUndefined();
  });
  it('records elapsed times including failures and resets per request', () => {
    let clock = 100;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    beginPerformance(true);
    timed('handlerMs', () => { clock += 12; });
    expect(() => timed('failureMs', () => { clock += 3; throw new Error('failed'); })).toThrow();
    expect(performanceSnapshot()).toEqual({ handlerMs: 12, failureMs: 3, executionMs: 15 });
    beginPerformance(true);
    expect(performanceSnapshot()).toEqual({ executionMs: 0 });
  });
});
