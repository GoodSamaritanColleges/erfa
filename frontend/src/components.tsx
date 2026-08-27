import { AlertTriangle, CheckCircle2, FileText, Home, LayoutGrid, ListTodo, LoaderCircle, Send, ShieldCheck, X } from 'lucide-react';
import { type ReactNode } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from './auth';
import { statusLabel } from './format';
import type { RfaStatus } from './types';

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return <div className="spinner-wrap" role="status"><LoaderCircle className="spin" /><span>{label}...</span></div>;
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
  if (!user) return null;

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="sidebar-brand">
        <img src={`${import.meta.env.BASE_URL}gsc-logo.png`} alt="Good Samaritan Colleges" />
      </div>

      <nav className="sidebar-nav" aria-label="Main navigation">
        <span className="sidebar-nav-label">Navigation</span>
        <NavLink to="/" end><Home /> Dashboard</NavLink>
        <NavLink to="/rfas"><ListTodo /> My RFAs</NavLink>
        {user.CAN_CREATE_RFA && <NavLink to="/rfa/new"><Send /> Create RFA</NavLink>}
        {user.CAN_APPROVE_RFA && <NavLink to="/approvals"><ShieldCheck /> For My Action</NavLink>}
        {user.IS_ADMIN && <NavLink to="/admin"><LayoutGrid /> Administration</NavLink>}
      </nav>

      <div className="sidebar-footer">
        <div className="sidebar-user">
          <b>{user.FULL_NAME}</b>
          <small>{user.POSITION || user.DEPARTMENT_NAME || user.EMAIL}</small>
        </div>
        <button className="button ghost" onClick={signOut}>Sign out</button>
      </div>
    </aside>

    <div className="main-area">
      <header className="content-header">
        <div className="content-header-left">
          <FileText size={15} />
          <span>Electronic Request for Approval</span>
        </div>
      </header>

      <main className="page"><Outlet /></main>

      <footer className="site-footer">
        <span>eRFA - Good Samaritan Colleges</span>
        <span>Approvals are recorded electronically with a complete audit trail.</span>
      </footer>
    </div>

    {/* Mobile navigation — visible only via CSS media query at ≤900px */}
    <nav className="mobile-nav" aria-label="Mobile navigation">
      <NavLink to="/" end>Dashboard</NavLink>
      <NavLink to="/rfas">My RFAs</NavLink>
      {user.CAN_CREATE_RFA && <NavLink to="/rfa/new">Create RFA</NavLink>}
      {user.CAN_APPROVE_RFA && <NavLink to="/approvals">For My Action</NavLink>}
      {user.IS_ADMIN && <NavLink to="/admin">Admin</NavLink>}
    </nav>
  </div>;
}
