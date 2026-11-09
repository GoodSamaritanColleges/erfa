import { AlertTriangle, BarChart3, CheckCircle2, FilePlus2, FileText, Home, ListTodo, LoaderCircle, LogOut, Settings2, ShieldCheck, Wallet, X } from 'lucide-react';
import { Suspense, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from './auth';
import { statusLabel } from './format';
import type { RfaStatus } from './types';

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
  const { user, signOut } = useAuth();
  const { pathname } = useLocation();
  if (!user) return null;
  const pageTitle = pathname === '/' ? 'Dashboard' : pathname === '/rfas' ? 'My RFAs' : pathname === '/rfa/new' ? 'Create RFA' : pathname === '/approvals' ? 'For My Action' : pathname === '/admin' ? 'Administration' : pathname.startsWith('/admin/expense-monitoring') || pathname.startsWith('/admin/budgets') ? 'Expense Monitoring' : pathname.startsWith('/admin/expense-reports') || pathname.startsWith('/admin/budget-reports') ? 'Expense Reports' : pathname.startsWith('/rfa/') ? 'RFA Detail' : 'Electronic Request for Approval';

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="sidebar-brand">
        <img src={`${import.meta.env.BASE_URL}gsc-logo.png`} alt="Good Samaritan Colleges" />
      </div>

      <nav className="sidebar-nav" aria-label="Main navigation">
        <span className="sidebar-nav-label">Navigation</span>
        <NavLink to="/" end><Home /> Dashboard</NavLink>
        <NavLink to="/rfas"><ListTodo /> My RFAs</NavLink>
        {user.CAN_CREATE_RFA && <NavLink to="/rfa/new"><FilePlus2 /> Create RFA</NavLink>}
        {user.CAN_APPROVE_RFA && <NavLink to="/approvals"><ShieldCheck /> For My Action</NavLink>}
        {user.IS_ADMIN && <span className="sidebar-nav-label">Administration</span>}
        {user.IS_ADMIN && <NavLink to="/admin" end><Settings2 /> Administration</NavLink>}
        {user.IS_ADMIN && <NavLink to="/admin/expense-monitoring"><Wallet /> Expense Monitoring</NavLink>}
        {user.IS_ADMIN && <NavLink to="/admin/expense-reports"><BarChart3 /> Expense Reports</NavLink>}
      </nav>

      <div className="sidebar-footer">
        <div className="sidebar-user">
          <span className="avatar" aria-hidden>{initials(user.FULL_NAME)}</span>
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
          <span className="avatar small" aria-hidden>{initials(user.FULL_NAME)}</span>
        </div>
      </header>

      <main className="page"><Suspense fallback={<PageFallback />}><Outlet /></Suspense></main>

      <footer className="site-footer">
        <span>eRFA - Good Samaritan Colleges</span>
        <span>Approvals are recorded electronically with a complete audit trail.</span>
      </footer>
    </div>

    {/* Mobile navigation — visible only via CSS media query at ≤900px */}
    <nav className="mobile-nav" aria-label="Mobile navigation">
      <NavLink to="/" end><Home />Home</NavLink>
      <NavLink to="/rfas"><ListTodo />My RFAs</NavLink>
      {user.CAN_CREATE_RFA && <NavLink to="/rfa/new"><FilePlus2 />Create</NavLink>}
      {user.CAN_APPROVE_RFA && <NavLink to="/approvals"><ShieldCheck />Action</NavLink>}
      {user.IS_ADMIN && <NavLink to="/admin" end><Settings2 />Admin</NavLink>}
      {user.IS_ADMIN && <NavLink to="/admin/expense-monitoring"><Wallet />Expenses</NavLink>}
      {user.IS_ADMIN && <NavLink to="/admin/expense-reports"><BarChart3 />Reports</NavLink>}
    </nav>
  </div>;
}
