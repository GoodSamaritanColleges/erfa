import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, ApiError, getToken, onSessionProblem, peekSession, setToken, tokenExpiresAt } from './api';
import type { SessionUser } from './types';

interface AuthContextValue {
  user: SessionUser | null;
  loading: boolean;
  error: string;
  /** True when the Google sign-in expired mid-visit; the page stays open behind a sign-in prompt. */
  sessionExpired: boolean;
  acceptGoogleCredential: (token: string) => Promise<void>;
  /** Re-sign-in from the expired-session prompt without reloading the current page. */
  renewCredential: (token: string) => Promise<void>;
  signOut: () => void;
}
const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  // After a reload, open straight away as the user remembered in this tab (while the sign-in is
  // still valid); the server confirms in the background and corrects anything that changed.
  const [user, setUser] = useState<SessionUser | null>(() => {
    const token = getToken();
    const remembered = peekSession<SessionUser>();
    return token && remembered && tokenExpiresAt(token) > Date.now() ? remembered : null;
  });
  const [loading, setLoading] = useState(() => Boolean(getToken()) && !user);
  const [error, setError] = useState('');
  const [sessionExpired, setSessionExpired] = useState(false);

  const loadSession = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    setError('');
    try { setUser((await api<{ user: SessionUser }>('session')).user); setSessionExpired(false); }
    catch (caught) {
      // A brief connection problem while confirming a remembered user keeps them signed in.
      if (quiet && caught instanceof ApiError && caught.code === 'NETWORK_ERROR') return;
      setToken(''); setUser(null); setError(caught instanceof Error ? caught.message : 'Sign-in failed.');
    }
    finally { setLoading(false); }
  }, []);

  // Runs once on start; quiet when a remembered user is already shown.
  useEffect(() => { if (getToken()) void loadSession(Boolean(user)); }, [loadSession]);

  const signOut = useCallback(() => { setToken(''); setUser(null); setError(''); setSessionExpired(false); }, []);

  useEffect(() => onSessionProblem((problem, message) => {
    if (problem === 'expired') { setSessionExpired(true); return; }
    setToken(''); setUser(null); setSessionExpired(false); setError(message);
  }), []);

  const acceptGoogleCredential = useCallback(async (token: string) => { setToken(token); await loadSession(); }, [loadSession]);

  const renewCredential = useCallback(async (token: string) => {
    const previousEmail = user?.EMAIL?.toLowerCase() ?? '';
    setToken(token);
    try {
      const next = (await api<{ user: SessionUser }>('session')).user;
      setUser(next);
      setSessionExpired(false);
      // A different account signs in as a fresh visit rather than inheriting this page.
      if (previousEmail && next.EMAIL.toLowerCase() !== previousEmail) window.location.hash = '#/';
    } catch (caught) {
      setToken(''); setUser(null); setSessionExpired(false);
      setError(caught instanceof Error ? caught.message : 'Sign-in failed.');
    }
  }, [user?.EMAIL]);

  const value = useMemo(() => ({ user, loading, error, sessionExpired, acceptGoogleCredential, renewCredential, signOut }), [user, loading, error, sessionExpired, acceptGoogleCredential, renewCredential, signOut]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider.');
  return value;
}
