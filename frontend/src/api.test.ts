import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, string>();
vi.stubGlobal('sessionStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); }
});
vi.stubEnv('VITE_API_URL', 'https://example.test/exec');

const b64 = (value: object) => btoa(JSON.stringify(value)).replace(/=+$/, '');
const token = (expSeconds: number) => `${b64({ alg: 'none' })}.${b64({ exp: expSeconds })}.sig`;
const ok = (data: unknown) => ({ ok: true, json: async () => ({ ok: true, data }) });
const fail = (code: string) => ({ ok: true, json: async () => ({ ok: false, error: { code, message: 'nope' } }) });

async function load() {
  vi.resetModules();
  return import('./api');
}

beforeEach(() => { store.clear(); vi.restoreAllMocks(); });

describe('api session handling', () => {
  it('reads the expiry time from a Google ID token', async () => {
    const { tokenExpiresAt } = await load();
    expect(tokenExpiresAt(token(2_000_000_000))).toBe(2_000_000_000_000);
    expect(tokenExpiresAt('not-a-token')).toBe(0);
  });

  it('reports an expired sign-in before calling the server, keeping the page', async () => {
    const api = await load();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    api.setToken(token(Math.floor(Date.now() / 1000) - 10));
    const seen: string[] = [];
    api.onSessionProblem((problem) => { seen.push(problem); });
    await expect(api.api('rfa.list')).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
    expect(seen).toEqual(['expired']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('treats a server UNAUTHORIZED reply as an expired sign-in', async () => {
    const api = await load();
    vi.stubGlobal('fetch', vi.fn(async () => fail('UNAUTHORIZED')));
    api.setToken(token(Math.floor(Date.now() / 1000) + 3600));
    const seen: string[] = [];
    api.onSessionProblem((problem) => { seen.push(problem); });
    await expect(api.api('rfa.forApproval')).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
    expect(seen).toEqual(['expired']);
  });
});

describe('instant display of last-loaded data', () => {
  it('remembers the last good list and forgets it after any write or sign-out', async () => {
    const api = await load();
    const fetchMock = vi.fn(async () => ok([{ RFA_ID: 'r1' }]));
    vi.stubGlobal('fetch', fetchMock);
    api.setToken(token(Math.floor(Date.now() / 1000) + 3600));
    expect(api.peek('rfa.list', { query: '' })).toBeUndefined();
    await api.api('rfa.list', { query: '' });
    expect(api.peek('rfa.list', { query: '' })).toEqual([{ RFA_ID: 'r1' }]);

    fetchMock.mockImplementationOnce(async () => ok({ saved: true }));
    await api.api('rfa.approve', { rfaId: 'r1' });
    expect(api.peek('rfa.list', { query: '' })).toBeUndefined();

    await api.api('rfa.list', { query: '' });
    api.setToken('');
    expect(api.peek('rfa.list', { query: '' })).toBeUndefined();
  });
});
