import { ArrowRight, CheckCircle2, Clock3, FilePenLine, RotateCcw, ShieldCheck } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, peek } from '../api';
import { useAuth } from '../auth';
import { ErrorNotice, StatusBadge } from '../components';
import { currentSchoolYear, date, money, schoolYearLabel } from '../format';
import type { Rfa } from '../types';

type DashboardExpenses = { totals: { totalOpex: number; totalCapex: number; total: number; rfaCount: number }; deptRows: Array<{ departmentName: string; total: number; rfaCount: number }> };
type DashboardBudget = { totals: { totalOpex: number; totalCapex: number; total: number; rfaCount: number }; deptRows: Array<{ departmentName: string; total: number; rfaCount: number }> };

function DashboardSkeleton() {
  return <>
    <div className="dashboard-greeting">
      <div className="skeleton" style={{ height: 34, width: 130, borderRadius: 999 }} />
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

type DashboardHome = { rfas: Rfa[]; approvals: Rfa[]; expenseMonitoring?: DashboardBudget | null; budget?: DashboardBudget | null };

export function DashboardPage() {
  const { user } = useAuth();
  // Show what was loaded earlier in this visit straight away, then refresh quietly.
  const [cached] = useState(() => peek<DashboardHome>('dashboard.home'));
  const [rfas, setRfas] = useState<Rfa[]>(() => (Array.isArray(cached?.rfas) ? cached.rfas : []));
  const [approvals, setApprovals] = useState<Rfa[]>(() => (Array.isArray(cached?.approvals) ? cached.approvals : []));
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(!cached);
  const [expenses, setExpenses] = useState<DashboardExpenses | null>(() => cached?.expenseMonitoring ?? cached?.budget ?? null);

  useEffect(() => {
    let cancelled = false;
    void api<DashboardHome>('dashboard.home').then(({ rfas: mine, approvals: action, expenseMonitoring, budget }) => {
      if (cancelled) return;
      setRfas(Array.isArray(mine) ? mine : []);
      setApprovals(Array.isArray(action) ? action : []);
      setExpenses(expenseMonitoring ?? budget ?? null);
      setError('');
    })
      .catch((e: Error) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [user?.CAN_APPROVE_RFA, user?.IS_ADMIN]);

  const counts = useMemo(() => ({
    draft: rfas.filter((r) => (r.STATUS ?? '') === 'DRAFT').length,
    pending: rfas.filter((r) => (r.STATUS ?? '').startsWith('PENDING_') || (r.STATUS ?? '') === 'SUBMITTED').length,
    returned: rfas.filter((r) => (r.STATUS ?? '') === 'RETURNED').length,
    approved: rfas.filter((r) => ['APPROVED', 'IMPLEMENTATION'].includes(r.STATUS ?? '')).length,
    closed: rfas.filter((r) => (r.STATUS ?? '') === 'CLOSED').length
  }), [rfas]);

  if (loading) return <DashboardSkeleton />;

  return <>
    {user?.CAN_CREATE_RFA && <div className="dashboard-greeting dashboard-hero">
      <Link className="button primary" to="/rfa/new">Create RFA <ArrowRight size={16} /></Link>
    </div>}

    <ErrorNotice message={error} />

    <section className="metrics" aria-label="RFA summary">
      <Metric tone="neutral" icon={<FilePenLine />} label="Draft" value={counts.draft} />
      <Metric tone="blue" icon={<Clock3 />} label="Pending" value={counts.pending} />
      <Metric tone="amber" icon={<RotateCcw />} label="Returned" value={counts.returned} />
      <Metric tone="green" icon={<CheckCircle2 />} label="Approved" value={counts.approved} />
      <Metric tone="navy" icon={<ShieldCheck />} label="Closed" value={counts.closed} />
    </section>

    {user?.IS_ADMIN && expenses && <section className="panel budget-dashboard">
      <header className="panel-header"><div><span className="eyebrow orange">EXPENSE MONITORING</span><h2>{schoolYearLabel(currentSchoolYear())} · current school year</h2></div><Link to="/admin/expense-monitoring">Expense monitoring <ArrowRight size={14} /></Link></header>
      <div className="metric-grid"><MetricValue label="Total OPEX" value={money(expenses.totals.totalOpex)} /><MetricValue label="Total CAPEX" value={money(expenses.totals.totalCapex)} /><MetricValue label="Combined Total" value={money(expenses.totals.total)} /><MetricValue label="RFAs" value={String(expenses.totals.rfaCount)} /></div>
      {(expenses.deptRows?.length ?? 0) > 0 && <p className="muted">{expenses.deptRows.slice(0, 4).map((row) => `${row.departmentName}: ${money(row.total)} (${row.rfaCount} RFAs)`).join(' · ')}</p>}
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

function Metric({ icon, label, value, tone = 'neutral' }: { icon: React.ReactNode; label: string; value: number; tone?: string }) {
  return <div className={`metric tone-${tone}`}>
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

export function RfaTable({ rfas, review = false, schoolYear = '' }: { rfas: Rfa[]; review?: boolean; schoolYear?: string }) {
  return <div className="table-wrap">
    <table>
      <thead>
        <tr>
          <th>RFA Number</th>
          <th>Request</th>
          <th>Department</th>
          <th>Requested Amount</th>
          <th>Status</th>
          <th>Date Filed</th>
          <th aria-label="Action" />
        </tr>
      </thead>
      <tbody>
        {rfas.map((rfa) => <tr key={rfa.RFA_ID}>
          <td data-label="RFA Number">{rfa.RFA_NUMBER ? <b>{rfa.RFA_NUMBER}</b> : <span className="draft-number">Draft</span>}</td>
          <td data-label="Request">
            <span className="cell-primary">{rfa.REQUEST_TITLE || 'Untitled draft'}</span>
            <small>{rfa.REQUESTED_BY}</small>
          </td>
          <td data-label="Department">{rfa.DEPARTMENT_NAME}</td>
          <td data-label="Requested Amount">{money(rfa.REQUESTED_AMOUNT ? rfa.REQUESTED_AMOUNT / 100 : rfa.BUDGET_ALLOCATION)}</td>
          <td data-label="Status"><StatusBadge status={rfa.STATUS} /></td>
          <td data-label="Date Filed">{date(rfa.DATE_FILED)}</td>
          <td><Link className="row-link" to={`/rfa/${rfa.RFA_ID}${schoolYear ? `?sy=${schoolYear}` : ''}`}>{review ? 'Review' : 'View'} <ArrowRight size={14} /></Link></td>
        </tr>)}
      </tbody>
    </table>
  </div>;
}
