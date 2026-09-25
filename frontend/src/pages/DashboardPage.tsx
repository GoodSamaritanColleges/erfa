import { ArrowRight, CheckCircle2, Clock3, FilePenLine, RotateCcw, ShieldCheck } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { ErrorNotice, StatusBadge } from '../components';
import { date, money, stepLabel } from '../format';
import type { Rfa } from '../types';

function DashboardSkeleton() {
  return <>
    <div className="dashboard-greeting">
      <div className="skeleton" style={{ height: 22, width: 200, marginBottom: 8 }} />
      <div className="skeleton" style={{ height: 14, width: 300 }} />
      <div className="skeleton" style={{ height: 34, width: 130, marginTop: 12, borderRadius: 999 }} />
    </div>
    <div className="skeleton-metrics" aria-hidden>
      {Array.from({ length: 5 }).map((_, i) => <div key={i} className="skeleton skeleton-metric" />)}
    </div>
    <div className="panel">
      <div className="panel-header"><div className="skeleton" style={{ height: 14, width: 140 }} /><div className="skeleton" style={{ height: 14, width: 60 }} /></div>
      <div className="skeleton-row"><div className="skeleton skeleton-cell" style={{ width: 90 }} /><div className="skeleton skeleton-cell" style={{ width: 160, flex: 1 }} /><div className="skeleton skeleton-cell" style={{ width: 70 }} /></div>
      <div className="skeleton-row"><div className="skeleton skeleton-cell" style={{ width: 90 }} /><div className="skeleton skeleton-cell" style={{ width: 160, flex: 1 }} /><div className="skeleton skeleton-cell" style={{ width: 70 }} /></div>
    </div>
    <div className="panel">
      <div className="panel-header"><div className="skeleton" style={{ height: 14, width: 150 }} /><div className="skeleton" style={{ height: 14, width: 60 }} /></div>
      <div className="skeleton-row"><div className="skeleton skeleton-cell" style={{ width: 90 }} /><div className="skeleton skeleton-cell" style={{ width: 160, flex: 1 }} /><div className="skeleton skeleton-cell" style={{ width: 70 }} /></div>
      <div className="skeleton-row"><div className="skeleton skeleton-cell" style={{ width: 90 }} /><div className="skeleton skeleton-cell" style={{ width: 160, flex: 1 }} /><div className="skeleton skeleton-cell" style={{ width: 70 }} /></div>
    </div>
  </>;
}

export function DashboardPage() {
  const { user } = useAuth();
  const [rfas, setRfas] = useState<Rfa[]>([]);
  const [approvals, setApprovals] = useState<Rfa[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [budget, setBudget] = useState<{ totals: { allocated: number; committed: number; actualSpent: number; available: number }; rows: Array<{ departmentName: string; utilization: number }> } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api<{ rfas: Rfa[]; approvals: Rfa[] }>('dashboard.rfas').then(({ rfas: mine, approvals: action }) => {
      if (cancelled) return;
      setRfas(Array.isArray(mine) ? mine : []);
      setApprovals(Array.isArray(action) ? action : []);
    })
      .catch((e: Error) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [user?.CAN_APPROVE_RFA]);

  useEffect(() => {
    if (!user?.IS_ADMIN) return;
    void api<{ totals: { allocated: number; committed: number; actualSpent: number; available: number }; rows: Array<{ departmentName: string; utilization: number }> }>('admin.budget.summary', { fiscalYear: String(new Date().getFullYear()) }).then(setBudget).catch(() => undefined);
  }, [user?.IS_ADMIN]);

  const counts = useMemo(() => ({
    draft: rfas.filter((r) => (r.STATUS ?? '') === 'DRAFT').length,
    pending: rfas.filter((r) => (r.STATUS ?? '').startsWith('PENDING_') || (r.STATUS ?? '') === 'SUBMITTED').length,
    returned: rfas.filter((r) => (r.STATUS ?? '') === 'RETURNED').length,
    approved: rfas.filter((r) => ['APPROVED', 'IMPLEMENTATION'].includes(r.STATUS ?? '')).length,
    closed: rfas.filter((r) => (r.STATUS ?? '') === 'CLOSED').length
  }), [rfas]);

  if (loading) return <DashboardSkeleton />;

  const displayName = user?.FULL_NAME?.split(' ')[0] ?? 'there';

  return <>
    <div className="dashboard-greeting">
      <h1>Good day, {displayName}.</h1>
      <p>{approvals.length
        ? `You have ${approvals.length} request${approvals.length === 1 ? '' : 's'} waiting for your action.`
        : 'Your requests and approval work are up to date.'}
      </p>
      {user?.CAN_CREATE_RFA && <div style={{ marginTop: '0.75rem' }}>
        <Link className="button primary" to="/rfa/new">Create RFA <ArrowRight size={16} /></Link>
      </div>}
    </div>

    <ErrorNotice message={error} />

    <section className="metrics" aria-label="RFA summary">
      <Metric icon={<FilePenLine />} label="Draft" value={counts.draft} />
      <Metric icon={<Clock3 />} label="Pending" value={counts.pending} />
      <Metric icon={<RotateCcw />} label="Returned" value={counts.returned} />
      <Metric icon={<CheckCircle2 />} label="Approved" value={counts.approved} />
      <Metric icon={<ShieldCheck />} label="Closed" value={counts.closed} />
    </section>

    {user?.IS_ADMIN && budget && <section className="panel budget-dashboard">
      <header className="panel-header"><div><span className="eyebrow orange">BUDGET OVERVIEW</span><h2>Current fiscal year</h2></div><Link to="/admin/budgets">Manage budgets <ArrowRight size={14} /></Link></header>
      <div className="metric-grid"><MetricValue label="Institutional budget" value={money(budget.totals.allocated)} /><MetricValue label="Committed" value={money(budget.totals.committed)} /><MetricValue label="Actual spent" value={money(budget.totals.actualSpent)} /><MetricValue label="Available" value={money(budget.totals.available)} /></div>
      {budget.rows.length > 0 && <p className="muted">{budget.rows.slice(0, 4).map((row) => `${row.departmentName}: ${(row.utilization * 100).toFixed(0)}% utilized`).join(' · ')}</p>}
    </section>}

    {user?.CAN_APPROVE_RFA && <section className="panel">
      <header className="panel-header">
        <div>
          <span className="eyebrow orange">FOR MY ACTION</span>
          <h2>Pending approvals</h2>
        </div>
        <Link to="/approvals">View all <ArrowRight size={14} /></Link>
      </header>
      {approvals.length
        ? <RfaTable rfas={approvals.slice(0, 5)} review />
        : <Empty title="No requests need your action" text="New requests will appear here when the approval matrix assigns them to you." />}
    </section>}

    <section className="panel">
      <header className="panel-header">
        <div>
          <span className="eyebrow">RECENT ACTIVITY</span>
          <h2>Recently updated RFAs</h2>
        </div>
        <Link to="/rfas">View all <ArrowRight size={14} /></Link>
      </header>
      {rfas.length
        ? <RfaTable rfas={rfas.slice(0, 6)} />
        : <Empty title="No RFAs yet" text="Create your first Request for Approval to begin the electronic workflow." />}
    </section>
  </>;
}

function Metric({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return <div className="metric">
    <span className="metric-icon">{icon}</span>
    <div><strong>{value}</strong><span>{label}</span></div>
  </div>;
}

function MetricValue({ label, value }: { label: string; value: string }) { return <div className="metric-card"><span>{label}</span><b>{value}</b></div>; }

export function Empty({ title, text }: { title: string; text: string }) {
  return <div className="empty">
    <div className="empty-mark">RFA</div>
    <h3>{title}</h3>
    <p>{text}</p>
  </div>;
}

export function RfaTable({ rfas, review = false }: { rfas: Rfa[]; review?: boolean }) {
  return <div className="table-wrap">
    <table>
      <thead>
        <tr>
          <th>RFA Number</th>
          <th>Request</th>
          <th>Department</th>
          <th>Budget</th>
          {review && <th>Current Step</th>}
          <th>Status</th>
          <th>Date Filed</th>
          <th aria-label="Action" />
        </tr>
      </thead>
      <tbody>
        {rfas.map((rfa) => <tr key={rfa.RFA_ID}>
          <td data-label="RFA Number"><b>{rfa.RFA_NUMBER}</b></td>
          <td data-label="Request">
            <span className="cell-primary">{rfa.REQUEST_TITLE || 'Untitled draft'}</span>
            <small>{rfa.REQUESTED_BY}</small>
          </td>
          <td data-label="Department">{rfa.DEPARTMENT_NAME}</td>
          <td data-label="Budget">{money(rfa.BUDGET_ALLOCATION)}</td>
          {review && <td data-label="Current Step">{rfa.CURRENT_STEP ? stepLabel(rfa.CURRENT_STEP) : '—'}</td>}
          <td data-label="Status"><StatusBadge status={rfa.STATUS} /></td>
          <td data-label="Date Filed">{date(rfa.DATE_FILED)}</td>
          <td><Link className="row-link" to={`/rfa/${rfa.RFA_ID}`}>{review ? 'Review' : 'View'} <ArrowRight size={14} /></Link></td>
        </tr>)}
      </tbody>
    </table>
  </div>;
}
