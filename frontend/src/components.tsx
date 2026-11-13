import { AlertTriangle, BarChart3, Files, CheckCircle2, FilePlus2, FileText, Home, ListTodo, LoaderCircle, LogOut, Settings2, ShieldCheck, Wallet, X } from 'lucide-react';
import { Component, Suspense, useEffect, useState, type ErrorInfo, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { api, onDataChanged } from './api';
import { useAuth } from './auth';
import { GoogleSignInButton } from './googleSignIn';
import { statusLabel } from './format';
import type { Rfa, RfaStatus } from './types';

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return <div className="spinner-wrap" role="status"><LoaderCircle className="spin" /><span>{label}...</span></div>;
}

export function PageFallback() {
  return <div className="page-fallback" aria-busy="true" aria-label="Loading page">
    <div className="skeleton" style={{ height: 12, width: 120, marginBottom: 10 }} />
    <div className="skeleton" style={{ height: 26, width: 260, marginBottom: 10 }} />
    <div className="skeleton" style={{ height: 14, width: 360, marginBottom: 24 }} />
    <div className="panel">
      {Array.from({ length: 4 }).map((_, i) => <div key={i} className="skeleton-row"><div className="skeleton skeleton-cell" style={{ width: 90 }} /><div className="skeleton skeleton-cell" style={{ flex: 1 }} /><div className="skeleton skeleton-cell" style={{ width: 70 }} /></div>)}
    </div>
  </div>;
}

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? '').join('') || '?';
}

const PENDING_REFRESH_MS = 120_000;

/**
 * Number of RFAs waiting for this user's decision. Refreshes on every page change
 * (served from the 30-second read cache, so this is cheap), when the tab regains focus,
 * and every 2 minutes while the tab is visible. Any approve/return/disapprove clears the
 * read cache, so the count updates on the next page the user opens.
 */
function usePendingCount(enabled: boolean, pathname: string): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!enabled) { setCount(0); return; }
    let alive = true;
    const load = () => {
      if (document.visibilityState === 'hidden') return;
      api<Rfa[]>('rfa.forApproval').then((rows) => { if (alive) setCount(Array.isArray(rows) ? rows.length : 0); }).catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, PENDING_REFRESH_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    const stopListening = onDataChanged(load);
    return () => { alive = false; window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('focus', onVisible); stopListening(); };
  }, [enabled, pathname]);
  return count;
}

function CountBubble({ count, className = '' }: { count: number; className?: string }) {
  if (count <= 0) return null;
  return <span className={`count-bubble ${className}`} aria-hidden>{count > 99 ? '99+' : count}</span>;
}

/** Signs the user back in over the current page, so anything typed on it is kept. */
function SessionExpiredDialog() {
  const { user, renewCredential, signOut } = useAuth();
  const [busy, setBusy] = useState(false);
  return <div className="dialog-backdrop" role="presentation">
    <section className="dialog session-dialog" role="alertdialog" aria-modal="true" aria-labelledby="session-expired-title">
      <header><h2 id="session-expired-title">Please sign in again</h2></header>
      <div className="dialog-body">
        <p>For your security, your Google sign-in lasts about an hour. Sign in again{user ? ` as ${user.EMAIL}` : ''} to continue. Anything you typed on this page is kept; just repeat your last action after signing in.</p>
        {busy ? <Spinner label="Verifying your Google account" /> : <GoogleSignInButton onCredential={(credential) => { setBusy(true); void renewCredential(credential).finally(() => setBusy(false)); }} />}
        <div className="dialog-actions"><button className="button ghost" onClick={signOut}>Sign out instead</button></div>
      </div>
    </section>
  </div>;
}

/** Shows a friendly message instead of a blank page if something unexpected breaks. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true }; }
  componentDidCatch(error: Error, info: ErrorInfo): void { console.error('[eRFA] Unexpected error', error, info.componentStack); }
  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return <div className="crash-panel" role="alert">
      <AlertTriangle />
      <h2>Something went wrong on this page</h2>
      <p>This can happen right after eRFA is updated. Reloading usually fixes it. Your submitted RFAs are safe.</p>
      <button className="button primary" onClick={() => window.location.reload()}>Reload eRFA</button>
    </div>;
  }
}

export function StatusBadge({ status }: { status: RfaStatus | string }) {
  return <span className={`status status-${status.toLowerCase()}`}>{statusLabel(status)}</span>;
}

export function ErrorNotice({ message }: { message: string }) {
  return message ? <div className="notice error" role="alert"><AlertTriangle size={18} />{message}</div> : null;
}

export function SuccessNotice({ message }: { message: string }) {
  return message ? <div className="notice success" role="status"><CheckCircle2 size={18} />{message}</div> : null;
}

export function Dialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
    <section className="dialog" role="dialog" aria-modal="true" aria-label={title}>
      <header><h2>{title}</h2><button className="icon-button" onClick={onClose} aria-label="Close"><X /></button></header>
      {children}
    </section>
  </div>;
}

export function Layout() {
  const { user, signOut, sessionExpired } = useAuth();
  const { pathname } = useLocation();
  const pending = usePendingCount(Boolean(user?.CAN_APPROVE_RFA), pathname);
  const [adminMenuOpen, setAdminMenuOpen] = useState(false);
  // Each page opens at the top instead of keeping the previous page's scroll position.
  useEffect(() => { setAdminMenuOpen(false); window.scrollTo(0, 0); }, [pathname]);
  useEffect(() => {
    const base = 'eRFA | Electronic Request for Approval';
    document.title = pending > 0 ? `(${pending}) ${base}` : base;
  }, [pending]);
  if (!user) return null;
  const pendingLabel = pending > 0 ? `${pending} request${pending === 1 ? '' : 's'} awaiting your action` : '';
  const canSeeAll = user.ALL_RFAS_SCOPE === 'all' || user.ALL_RFAS_SCOPE === 'approved';
  const pageTitle = pathname === '/' ? 'Dashboard' : pathname === '/rfas' ? 'My RFAs' : pathname === '/all-rfas' ? 'All RFAs' : pathname === '/rfa/new' ? 'Create RFA' : pathname === '/approvals' ? 'For My Action' : pathname === '/admin' ? 'Administration' : pathname.startsWith('/admin/expense-monitoring') || pathname.startsWith('/admin/budgets') ? 'Expense Monitoring' : pathname.startsWith('/admin/expense-reports') || pathname.startsWith('/admin/budget-reports') ? 'Expense Reports' : pathname.startsWith('/rfa/') ? 'RFA Detail' : 'Electronic Request for Approval';

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="sidebar-brand">
        <img src={`${import.meta.env.BASE_URL}gsc-logo.png`} alt="Good Samaritan Colleges" />
      </div>

      <nav className="sidebar-nav" aria-label="Main navigation">
        <span className="sidebar-nav-label">Navigation</span>
        <NavLink to="/" end><Home /> Dashboard</NavLink>
        <NavLink to="/rfas"><ListTodo /> My RFAs</NavLink>
        {canSeeAll && <NavLink to="/all-rfas"><Files /> All RFAs</NavLink>}
        {user.CAN_CREATE_RFA && <NavLink to="/rfa/new"><FilePlus2 /> Create RFA</NavLink>}
        {user.CAN_APPROVE_RFA && <NavLink to="/approvals" aria-label={pendingLabel ? `For My Action, ${pendingLabel}` : undefined}><ShieldCheck /> For My Action<CountBubble count={pending} className="nav-count" /></NavLink>}
        {user.IS_ADMIN && <span className="sidebar-nav-label">Administration</span>}
        {user.IS_ADMIN && <NavLink to="/admin" end><Settings2 /> Administration</NavLink>}
        {user.IS_ADMIN && <NavLink to="/admin/expense-monitoring"><Wallet /> Expense Monitoring</NavLink>}
        {user.IS_ADMIN && <NavLink to="/admin/expense-reports"><BarChart3 /> Expense Reports</NavLink>}
      </nav>

      <div className="sidebar-footer">
        <div className="sidebar-user">
          <span className="avatar-wrap"><span className="avatar" aria-hidden>{initials(user.FULL_NAME)}</span><CountBubble count={pending} className="avatar-count" /></span>
          <div>
            <b>{user.FULL_NAME}</b>
            <small>{user.POSITION || user.DEPARTMENT_NAME || user.EMAIL}</small>
          </div>
        </div>
        <button className="button ghost" onClick={signOut}><LogOut /> Sign out</button>
      </div>
    </aside>

    <div className="main-area">
      <header className="content-header">
        <div className="content-header-left">
          <FileText size={15} />
          <div><span className="content-header-context">Electronic Request for Approval</span><b>{pageTitle}</b></div>
        </div>
        <div className="content-header-right">
          <span className="content-header-user" title={user.FULL_NAME}>{user.FULL_NAME}</span>
          {pending > 0
            ? <Link to="/approvals" className="avatar-wrap avatar-link" title={pendingLabel} aria-label={pendingLabel}><span className="avatar small" aria-hidden>{initials(user.FULL_NAME)}</span><CountBubble count={pending} className="avatar-count" /></Link>
            : <span className="avatar-wrap"><span className="avatar small" aria-hidden>{initials(user.FULL_NAME)}</span></span>}
        </div>
      </header>

      <main className="page"><ErrorBoundary key={pathname}><Suspense fallback={<PageFallback />}><Outlet /></Suspense></ErrorBoundary></main>

      <footer className="site-footer">
        <span>eRFA - Good Samaritan Colleges</span>
        <span>Approvals are recorded electronically with a complete audit trail.</span>
      </footer>
    </div>

    {sessionExpired && <SessionExpiredDialog />}

    {/* Mobile navigation — visible only via CSS media query at ≤900px */}
    <nav className="mobile-nav" aria-label="Mobile navigation">
      <NavLink to="/" end><Home />Home</NavLink>
      <NavLink to="/rfas"><ListTodo />My RFAs</NavLink>
      {canSeeAll && <NavLink to="/all-rfas"><Files />All RFAs</NavLink>}
      {user.CAN_CREATE_RFA && <NavLink to="/rfa/new"><FilePlus2 />Create</NavLink>}
      {user.CAN_APPROVE_RFA && <NavLink to="/approvals" aria-label={pendingLabel ? `For My Action, ${pendingLabel}` : undefined}><span className="mobile-icon-wrap"><ShieldCheck /><CountBubble count={pending} className="mobile-count" /></span>Action</NavLink>}
      {/* Admin pages share one button so every item fits on a phone */}
      {user.IS_ADMIN && <button type="button" className={`mobile-admin-toggle${pathname.startsWith('/admin') ? ' active' : ''}`} aria-expanded={adminMenuOpen} aria-controls="mobile-admin-menu" onClick={() => setAdminMenuOpen((open) => !open)}><Settings2 />Admin</button>}
    </nav>
    {user.IS_ADMIN && adminMenuOpen && <>
      <button type="button" className="mobile-admin-backdrop" aria-label="Close menu" onClick={() => setAdminMenuOpen(false)} />
      <div id="mobile-admin-menu" className="mobile-admin-menu" role="menu">
        <NavLink to="/admin" end role="menuitem"><Settings2 />Administration</NavLink>
        <NavLink to="/admin/expense-monitoring" role="menuitem"><Wallet />Expense Monitoring</NavLink>
        <NavLink to="/admin/expense-reports" role="menuitem"><BarChart3 />Expense Reports</NavLink>
      </div>
    </>}
  </div>;
}
