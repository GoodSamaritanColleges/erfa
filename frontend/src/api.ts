const API_URL = import.meta.env.VITE_API_URL as string | undefined;
const TOKEN_KEY = 'erfa_google_id_token';
const coalescedReads = new Set(['session', 'dashboard.rfas', 'rfa.list', 'rfa.forApproval', 'rfa.detail', 'rfa.eligibleApprovers', 'admin.data', 'admin.budget.summary', 'admin.budget.overview', 'admin.budget.management', 'admin.category.list', 'admin.budget.report', 'admin.budget.detail', 'budget.context']);
const pendingReads = new Map<string, Promise<unknown>>();

export class ApiError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

export function getToken(): string { return sessionStorage.getItem(TOKEN_KEY) ?? ''; }
export function setToken(token: string): void { if (token) sessionStorage.setItem(TOKEN_KEY, token); else sessionStorage.removeItem(TOKEN_KEY); }
export function isConfigured(): boolean { return Boolean(API_URL && import.meta.env.VITE_GOOGLE_CLIENT_ID); }

export async function api<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  if (!API_URL) throw new ApiError('CONFIGURATION_REQUIRED', 'The eRFA API URL is not configured.');
  const idToken = getToken();
  const key = coalescedReads.has(action) ? JSON.stringify([action, payload, idToken]) : '';
  if (key && pendingReads.has(key)) return pendingReads.get(key) as Promise<T>;
  const request = (async () => {
    let response: Response;
    try {
      response = await fetch(API_URL, {
        method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action, payload, idToken })
      });
    } catch {
      throw new ApiError('NETWORK_ERROR', 'Unable to reach eRFA. Check your internet connection and try again.');
    }
    if (!response.ok) throw new ApiError('HTTP_ERROR', `eRFA returned HTTP ${response.status}.`);
    const result = await response.json() as { ok: boolean; data?: T; error?: { code: string; message: string } };
    if (!result.ok || result.data === undefined) throw new ApiError(result.error?.code ?? 'SERVER_ERROR', result.error?.message ?? 'The request could not be completed.');
    return result.data;
  })();
  if (!key) return request;
  const shared = request.finally(() => { if (pendingReads.get(key) === shared) pendingReads.delete(key); });
  pendingReads.set(key, shared);
  return shared;
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.readAsDataURL(file);
  });
}
