import { useEffect, useRef, useState } from 'react';

declare global {
  interface Window { google?: { accounts: { id: { initialize: (options: Record<string, unknown>) => void; renderButton: (element: HTMLElement, options: Record<string, unknown>) => void } } } }
}

const GIS_SRC = 'https://accounts.google.com/gsi/client';
let gisPromise: Promise<void> | null = null;

/** Load Google Identity Services once; later callers share the same promise. */
function loadGoogleIdentity(): Promise<void> {
  if (window.google?.accounts?.id) return Promise.resolve();
  if (gisPromise) return gisPromise;
  gisPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = GIS_SRC; script.async = true; script.defer = true; script.dataset.gis = 'true';
    script.onload = () => resolve();
    script.onerror = () => { gisPromise = null; reject(new Error('Google Sign-In could not be loaded. Check your connection and browser privacy settings.')); };
    document.head.appendChild(script);
  });
  return gisPromise;
}

/** Renders the official "Sign in with Google" button and reports the ID token. */
export function GoogleSignInButton({ onCredential, className = 'google-button' }: { onCredential: (credential: string) => void; className?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const callback = useRef(onCredential);
  const [error, setError] = useState('');
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;
  callback.current = onCredential;

  useEffect(() => {
    if (!clientId) return;
    let alive = true;
    loadGoogleIdentity().then(() => {
      if (!alive || !host.current || !window.google) return;
      window.google.accounts.id.initialize({ client_id: clientId, callback: (response: { credential: string }) => callback.current(response.credential), auto_select: false });
      window.google.accounts.id.renderButton(host.current, { theme: 'outline', size: 'large', width: Math.min(320, Math.max(240, Math.floor(host.current.clientWidth || 320))), text: 'signin_with' });
    }).catch((caught: Error) => { if (alive) setError(caught.message); });
    return () => { alive = false; };
  }, [clientId]);

  return <>
    {error && <div className="notice error" role="alert">{error}</div>}
    <div ref={host} className={className} />
  </>;
}
