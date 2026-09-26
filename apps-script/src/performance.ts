let enabled = false;
let started = 0;
let timings: Record<string, number> = {};

export function beginPerformance(active: boolean, requestStarted = Date.now()): void {
  enabled = active;
  started = requestStarted;
  timings = {};
}

// Fixed labels only: never pass payloads, tokens, user identifiers or URLs.
export function timed<T>(label: string, operation: () => T): T {
  if (!enabled) return operation();
  const start = Date.now();
  try { return operation(); }
  finally { timings[label] = (timings[label] || 0) + Date.now() - start; }
}

export function performanceSnapshot(): Record<string, number> | undefined {
  return enabled ? { ...timings, executionMs: Date.now() - started } : undefined;
}
