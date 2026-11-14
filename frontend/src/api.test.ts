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
  it('remembers the last good list and forgets it after a non-RFA change or sign-out', async () => {
    const api = await load();
    const fetchMock = vi.fn(async () => ok([{ RFA_ID: 'r1' }]));
    vi.stubGlobal('fetch', fetchMock);
    api.setToken(token(Math.floor(Date.now() / 1000) + 3600));
    expect(api.peek('rfa.list', { query: '' })).toBeUndefined();
    await api.api('rfa.list', { query: '' });
    expect(api.peek('rfa.list', { query: '' })).toEqual([{ RFA_ID: 'r1' }]);

    fetchMock.mockImplementationOnce(async () => ok({ saved: true }));
    await api.api('admin.settings.save', {});
    expect(api.peek('rfa.list', { query: '' })).toBeUndefined();

    await api.api('rfa.list', { query: '' });
    api.setToken('');
    expect(api.peek('rfa.list', { query: '' })).toBeUndefined();
  });
});

describe('remembered pages across a reload', () => {
  const signed = (email: string) => `${b64({ alg: 'none' })}.${b64({ exp: Math.floor(Date.now() / 1000) + 3600, email })}.sig`;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

  it('restores the user and last-seen lists for the same account after a reload', async () => {
    let api = await load();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(ok({ user: { EMAIL: 'a@x.edu' } })).mockResolvedValueOnce(ok([{ RFA_ID: 'r1' }])));
    api.setToken(signed('a@x.edu'));
    await api.api('session');
    await api.api('rfa.list', { query: '' });
    await settle();
    api = await load(); // a page reload: module state is gone, the tab's sessionStorage remains
    expect(api.peekSession()).toEqual({ EMAIL: 'a@x.edu' });
    expect(api.peek('rfa.list', { query: '' })).toEqual([{ RFA_ID: 'r1' }]);
  });

  it('never shows one account the pages remembered for another', async () => {
    let api = await load();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok([{ RFA_ID: 'r1' }])));
    api.setToken(signed('a@x.edu'));
    await api.api('rfa.list', {});
    await settle();
    store.set('erfa_google_id_token', signed('b@x.edu'));
    api = await load();
    expect(api.peek('rfa.list', {})).toBeUndefined();
    api.setToken(signed('a@x.edu'));
    api.setToken(signed('c@x.edu'));
    expect(api.peek('rfa.list', {})).toBeUndefined();
  });

  it('after a decision keeps the lists, takes the RFA off For My Action and forgets its page', async () => {
    const api = await load();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ok([{ RFA_ID: 'r1' }, { RFA_ID: 'r2' }]))   // rfa.forApproval
      .mockResolvedValueOnce(ok([{ RFA_ID: 'r1' }]))                     // rfa.list
      .mockResolvedValueOnce(ok({ rfa: { RFA_ID: 'r1' } }))               // rfa.detail
      .mockResolvedValueOnce(ok({ counts: 1 }))                           // dashboard.home
      .mockResolvedValueOnce(ok({ RFA_ID: 'r1' }));                       // rfa.approve
    vi.stubGlobal('fetch', fetchMock);
    api.setToken(signed('a@x.edu'));
    await api.api('rfa.forApproval', {});
    await api.api('rfa.list', {});
    await api.api('rfa.detail', { rfaId: 'r1' });
    await api.api('dashboard.home', {});
    await api.api('rfa.approve', { rfaId: 'r1' });
    expect(api.peek('rfa.forApproval', {})).toEqual([{ RFA_ID: 'r2' }]);
    expect(api.peek('rfa.list', {})).toEqual([{ RFA_ID: 'r1' }]);
    expect(api.peek('rfa.detail', { rfaId: 'r1' })).toBeUndefined();
    expect(api.peek('dashboard.home', {})).toBeUndefined();
  });

  it('forgets everything on sign-out and after other changes', async () => {
    const api = await load();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok([{ RFA_ID: 'r1' }])));
    api.setToken(signed('a@x.edu'));
    await api.api('rfa.list', {});
    await api.api('admin.user.save', { userId: 'u1' });
    expect(api.peek('rfa.list', {})).toBeUndefined();
    await api.api('rfa.list', {});
    api.setToken('');
    await settle();
    expect(store.has('erfa_view_cache_v1')).toBe(false);
    expect(api.peek('rfa.list', {})).toBeUndefined();
  });

  it('prefetches a read once and ignores its failure', async () => {
    const api = await load();
    const fetchMock = vi.fn().mockResolvedValue(fail('SERVER_ERROR'));
    vi.stubGlobal('fetch', fetchMock);
    api.setToken(signed('a@x.edu'));
    api.prefetch('rfa.detail', { rfaId: 'r1' });
    api.prefetch('rfa.detail', { rfaId: 'r1' });
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    api.prefetch('rfa.approve', { rfaId: 'r1' }); // never prefetches a change
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
