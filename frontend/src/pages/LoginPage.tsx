import { useEffect, useRef, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { ErrorNotice, Spinner } from '../components';
import { isConfigured } from '../api';
import { useAuth } from '../auth';

declare global {
  interface Window { google?: { accounts: { id: { initialize: (options: Record<string, unknown>) => void; renderButton: (element: HTMLElement, options: Record<string, unknown>) => void } } } }
}

export function LoginPage() {
  const { user, loading, error, acceptGoogleCredential } = useAuth();
  const button = useRef<HTMLDivElement>(null);
  const [scriptError, setScriptError] = useState('');
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;

  useEffect(() => {
    if (!clientId || !button.current) return;
    const render = () => {
      if (!window.google || !button.current) return;
      window.google.accounts.id.initialize({ client_id: clientId, callback: (response: { credential: string }) => void acceptGoogleCredential(response.credential), auto_select: false });
      window.google.accounts.id.renderButton(button.current, { theme: 'outline', size: 'large', width: 320, text: 'signin_with' });
    };
    const existing = document.querySelector<HTMLScriptElement>('script[data-gis]');
    if (existing) { render(); return; }
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client'; script.async = true; script.defer = true; script.dataset.gis = 'true'; script.onload = render;
    script.onerror = () => setScriptError('Google Sign-In could not be loaded. Check your connection and browser privacy settings.');
    document.head.appendChild(script);
  }, [clientId, acceptGoogleCredential]);

  if (user) return <Navigate to="/" replace />;
  return <main className="login-page">
    <aside className="login-aside" style={{ backgroundImage: `linear-gradient(rgba(15,43,77,.36),rgba(15,43,77,.72)),url('${import.meta.env.BASE_URL}gscbg.jpg')` }}>
      <div className="login-aside-content">
        <span>GOOD SAMARITAN COLLEGES</span>
        <b>Clear approvals. Complete accountability.</b>
        <p>Preserves the institutional RFA form with electronic routing, Drive attachments, Workspace email, and append-only history.</p>
      </div>
    </aside>
    <section className="login-card">
      <img src={`${import.meta.env.BASE_URL}gsc-logo.png`} alt="Good Samaritan Colleges" className="login-logo" />
      <div className="login-title">
        <span>INTERNAL CONTROLS INITIATIVE</span>
        <h1>Electronic Request for Approval</h1>
        <p>Create, route, review, and track institutional RFAs in one secure workspace.</p>
      </div>
      {!isConfigured() && <ErrorNotice message="This deployment is not configured. Set VITE_API_URL and VITE_GOOGLE_CLIENT_ID, then rebuild the frontend." />}
      <ErrorNotice message={error || scriptError} />
      {loading ? <Spinner label="Verifying your Google account" /> : <div ref={button} className="google-button" />}
      <p className="login-help">Use the Google Workspace account registered by your eRFA administrator. There is no public self-registration.</p>
    </section>
  </main>;
}
