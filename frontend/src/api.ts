const API_URL = import.meta.env.VITE_API_URL as string | undefined;
const TOKEN_KEY = 'erfa_google_id_token';
const coalescedReads = new Set(['session', 'dashboard.home', 'dashboard.rfas', 'rfa.list', 'rfa.all', 'rfa.forApproval', 'rfa.detail', 'rfa.archives', 'rfa.eligibleApprovers', 'rfa.departments', 'rfa.fixedRoute', 'expense.monitoring', 'admin.audit', 'admin.data', 'admin.budget.summary', 'admin.budget.overview', 'admin.budget.management', 'admin.category.list', 'admin.budget.report', 'admin.budget.expenses', 'admin.budget.detail', 'budget.context']);
const pendingReads = new Map<string, Promise<unknown>>();
// Short-lived cache for list/lookup reads so moving between pages is instant.
// Any write (non-read action) or sign-out clears it, so users never act on stale data after their own changes.
const cachedReads = new Set(['dashboard.home', 'dashboard.rfas', 'rfa.list', 'rfa.all', 'rfa.archives', 'rfa.forApproval', 'rfa.departments', 'rfa.fixedRoute', 'admin.category.list', 'budget.context']);
const READ_CACHE_TTL_MS = 30_000;
const readCache = new Map<string, { at: number; data: unknown }>();
export function clearReadCache(): void { readCache.clear(); }

// Notified after every successful change (approve, submit, save…), so counts like the
// For My Action bubble refresh immediately instead of on the next page change.
const changeListeners = new Set<() => void>();
export function onDataChanged(listener: () => void): () => void { changeListeners.add(listener); return () => { changeListeners.delete(listener); }; }

// Last successful answer per read, kept for the whole visit (not just 30 s) so a page can
// show it instantly while a fresh copy loads. Cleared by any write and by sign-out.
const lastGood = new Map<string, unknown>();
const viewKey = (action: string, payload: Record<string, unknown>) => JSON.stringify([action, payload]);

// The last-seen data and the signed-in user are also kept in this tab's sessionStorage, so a
// page reload shows them at once instead of waiting on the server. They belong to one account
// (by email from the sign-in token) and are dropped on sign-out, on any change, or for another
// account. sessionStorage ends with the tab, so nothing stays on a shared computer afterwards.
const STORE_KEY = 'erfa_view_cache_v1';
const STORE_LIMIT_CHARS = 1_500_000;
let storedSession: unknown;
function tokenEmail(token: string): string {
  try {
    const part = token.split('.')[1] ?? '';
    const json = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/'))) as { email?: string };
    return String(json.email ?? '').toLowerCase();
  } catch { return ''; }
}
function forgetStored(): void { storedSession = undefined; try { sessionStorage.removeItem(STORE_KEY); } catch { /* storage unavailable */ } }
let persistQueued = false;
function persistSoon(): void {
  if (persistQueued) return;
  persistQueued = true;
  setTimeout(() => {
    persistQueued = false;
    const owner = tokenEmail(getToken());
    if (!owner) return;
    try {
      const text = JSON.stringify({ owner, session: storedSession, views: [...lastGood] });
      if (text.length > STORE_LIMIT_CHARS) { sessionStorage.removeItem(STORE_KEY); return; }
      sessionStorage.setItem(STORE_KEY, text);
    } catch { try { sessionStorage.removeItem(STORE_KEY); } catch { /* storage unavailable */ } }
  }, 0);
}
(function restoreStored() {
  try {
    const owner = tokenEmail(sessionStorage.getItem('erfa_google_id_token') ?? '');
    const saved = JSON.parse(sessionStorage.getItem(STORE_KEY) || 'null') as { owner?: string; session?: unknown; views?: Array<[string, unknown]> } | null;
    if (!saved || !owner || saved.owner !== owner) { sessionStorage.removeItem(STORE_KEY); return; }
    storedSession = saved.session;
    for (const [key, value] of saved.views ?? []) lastGood.set(key, value);
  } catch { /* storage unavailable or damaged: start empty */ }
})();
/** The signed-in user from earlier in this tab, so a reload can open the app at once. */
export function peekSession<T>(): T | undefined { return storedSession as T | undefined; }
/** Last data loaded for this read during this visit, or undefined. Pages show it while refreshing. */
export function peek<T>(action: string, payload: Record<string, unknown> = {}): T | undefined {
  return lastGood.get(viewKey(action, payload)) as T | undefined;
}

// Session problems are broadcast so the app can ask the user to sign in again
// without leaving the page (a half-filled RFA form stays on screen).
type SessionProblem = 'expired' | 'revoked';
const sessionListeners = new Set<(problem: SessionProblem, message: string) => void>();
export function onSessionProblem(listener: (problem: SessionProblem, message: string) => void): () => void {
  sessionListeners.add(listener);
  return () => { sessionListeners.delete(listener); };
}
function reportSessionProblem(problem: SessionProblem, message: string): void { sessionListeners.forEach((listener) => listener(problem, message)); }

/** Expiry time (ms) from the Google ID token itself, or 0 if it cannot be read. */
export function tokenExpiresAt(token: string): number {
  try {
    const part = token.split('.')[1] ?? '';
    const json = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/'))) as { exp?: number };
    return typeof json.exp === 'number' ? json.exp * 1000 : 0;
  } catch { return 0; }
}
const EXPIRY_MARGIN_MS = 30_000;
const SESSION_EXPIRED_MESSAGE = 'Your sign-in has expired. Please sign in again to continue — your work on this page is kept.';

export class ApiError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

export function getToken(): string { return sessionStorage.getItem(TOKEN_KEY) ?? ''; }
export function setToken(token: string): void {
  clearReadCache();
  // A different account never sees the previous account's remembered pages.
  if (token && tokenEmail(token) !== tokenEmail(getToken())) { lastGood.clear(); forgetStored(); }
  if (token) sessionStorage.setItem(TOKEN_KEY, token);
  else { sessionStorage.removeItem(TOKEN_KEY); lastGood.clear(); forgetStored(); }
}
export function isConfigured(): boolean { return Boolean(API_URL && import.meta.env.VITE_GOOGLE_CLIENT_ID); }

export async function api<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  if (!API_URL) throw new ApiError('CONFIGURATION_REQUIRED', 'The eRFA API URL is not configured.');
  const idToken = getToken();
  if (idToken && action !== 'session') {
    const expiresAt = tokenExpiresAt(idToken);
    if (expiresAt && expiresAt - EXPIRY_MARGIN_MS <= Date.now()) {
      reportSessionProblem('expired', SESSION_EXPIRED_MESSAGE);
      throw new ApiError('SESSION_EXPIRED', SESSION_EXPIRED_MESSAGE);
    }
  }
  const diagnostic = sessionStorage.getItem('erfa_perf') === '1';
  const key = coalescedReads.has(action) ? JSON.stringify([action, payload, idToken]) : '';
  if (!key) { clearReadCache(); lastGood.clear(); persistSoon(); }
  const cacheable = Boolean(key) && cachedReads.has(action);
  if (cacheable) {
    const hit = readCache.get(key);
    if (hit && Date.now() - hit.at < READ_CACHE_TTL_MS) return hit.data as T;
  }
  if (key && pendingReads.has(key)) return pendingReads.get(key) as Promise<T>;
  const request = (async () => {
    const start = performance.now();
    let received = start;
    let parsed = start;
    let backend: Record<string, number> | undefined;
    try {
    let response: Response;
    try {
      response = await fetch(API_URL, {
        method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action, payload, idToken, ...(diagnostic ? { performance: true } : {}) })
      });
    } catch {
      throw new ApiError('NETWORK_ERROR', 'Unable to reach eRFA. Check your internet connection and try again.');
    }
    received = performance.now();
    if (!response.ok) throw new ApiError('HTTP_ERROR', `eRFA returned HTTP ${response.status}.`);
    const result = await response.json() as { ok: boolean; data?: T; error?: { code: string; message: string }; performance?: Record<string, number> };
    parsed = performance.now();
    backend = result.performance;
    if (!result.ok || result.data === undefined) {
      const code = result.error?.code ?? 'SERVER_ERROR';
      if (action !== 'session' && code === 'UNAUTHORIZED') { reportSessionProblem('expired', SESSION_EXPIRED_MESSAGE); throw new ApiError('SESSION_EXPIRED', SESSION_EXPIRED_MESSAGE); }
      if (action !== 'session' && (code === 'INACTIVE_USER' || code === 'NOT_REGISTERED')) reportSessionProblem('revoked', result.error?.message ?? 'Your eRFA access has ended.');
      throw new ApiError(code, result.error?.message ?? 'The request could not be completed.');
    }
    if (cacheable) readCache.set(key, { at: Date.now(), data: result.data });
    else if (!key) { clearReadCache(); lastGood.clear(); queueMicrotask(() => changeListeners.forEach((listener) => listener())); }
    if (key && action !== 'session') lastGood.set(viewKey(action, payload), result.data);
    if (action === 'session') storedSession = (result.data as { user?: unknown }).user;
    if (key) persistSoon();
    return result.data;
    } finally {
      if (diagnostic) console.info('[eRFA PERF]', /^[a-z.]+$/.test(action) ? action : 'request', {
        browserStartMs: Math.round(start),
        responseReceivedMs: received === start ? null : Math.round(received - start),
        bodyAndParseMs: parsed === start ? null : Math.round(parsed - received),
        totalMs: Math.round(performance.now() - start),
        backend
      });
    }
  })();
  if (!key) return request;
  const shared = request.finally(() => { if (pendingReads.get(key) === shared) pendingReads.delete(key); });
  pendingReads.set(key, shared);
  return shared;
}

/**
 * Load a read in the background so the page that needs it opens instantly. Errors are ignored
 * (the page loads normally if a prefetch failed), and a recent copy is never fetched twice.
 */
const recentPrefetch = new Map<string, number>();
export function prefetch(action: string, payload: Record<string, unknown> = {}): void {
  if (!coalescedReads.has(action) || !getToken()) return;
  const key = viewKey(action, payload);
  const last = recentPrefetch.get(key) ?? 0;
  if (Date.now() - last < READ_CACHE_TTL_MS) return;
  recentPrefetch.set(key, Date.now());
  api(action, payload).catch(() => recentPrefetch.delete(key));
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.readAsDataURL(file);
  });
}
