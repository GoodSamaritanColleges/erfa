import { Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, peek } from '../api';
import { useAuth } from '../auth';
import { ErrorNotice } from '../components';
import type { ArchiveYear, Rfa } from '../types';
import { Empty, RfaTable } from './DashboardPage';

type ListMode = 'mine' | 'approvals' | 'all';

const COPY: Record<ListMode, { eyebrow: string; title: string; text: string; empty: string; emptyText: string }> = {
  mine: { eyebrow: 'REQUEST REGISTER', title: 'My RFAs', text: 'The requests you filed. Search, filter, and follow each one from draft through closeout.', empty: 'No matching RFAs', emptyText: 'Try a different search or create a new Request for Approval.' },
  approvals: { eyebrow: 'APPROVAL QUEUE', title: 'For My Action', text: 'Requests currently assigned to you. Review every detail before deciding.', empty: 'No requests need your action', emptyText: 'Your queue is clear.' },
  all: { eyebrow: 'INSTITUTION REGISTER', title: 'All RFAs', text: 'Every submitted request across all departments. Drafts stay private to their requesters.', empty: 'No matching RFAs', emptyText: 'Try a different search or filter.' }
};

export function RfaListPage({ mode = 'mine' }: { mode?: ListMode }) {
  const { user } = useAuth();
  const approvalsOnly = mode === 'approvals';
  const approvedOnlyScope = mode === 'all' && user?.ALL_RFAS_SCOPE === 'approved';
  const copy = COPY[mode];
  const action = approvalsOnly ? 'rfa.forApproval' : mode === 'all' ? 'rfa.all' : 'rfa.list';
  const emptyFilters = approvalsOnly ? {} : { query: '', status: '', expenseClassification: '', fiscalYear: '' };
  // Show the list loaded earlier in this visit straight away; a fresh copy replaces it in the background.
  const [rfas, setRfas] = useState<Rfa[]>(() => peek<Rfa[]>(action, emptyFilters) ?? []);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [expenseClassification, setExpenseClassification] = useState('');
  const [fiscalYear, setFiscalYear] = useState('');
  const [schoolYear, setSchoolYear] = useState('');
  const [archives, setArchives] = useState<ArchiveYear[]>(() => peek<ArchiveYear[]>('rfa.archives') ?? []);
  const [loading, setLoading] = useState(() => !peek<Rfa[]>(action, emptyFilters));
  const [error, setError] = useState('');
  const previousQuery = useRef(query);

  useEffect(() => {
    let current = true;
    const delay = query === previousQuery.current ? 0 : 250;
    previousQuery.current = query;
    const payload = approvalsOnly ? {} : { query, status, expenseClassification, fiscalYear, ...(schoolYear ? { schoolYear } : {}) };
    const known = peek<Rfa[]>(action, payload);
    if (known) setRfas(known);
    setLoading(true);
    const timer = setTimeout(() => {
      void api<Rfa[]>(action, payload)
        .then((next) => { if (current) { setRfas(next); setError(''); } })
        .catch((caught: Error) => { if (current) setError(caught.message); })
        .finally(() => { if (current) setLoading(false); });
    }, delay);
    return () => { current = false; clearTimeout(timer); };
  }, [query, status, expenseClassification, fiscalYear, schoolYear, approvalsOnly, action]);

  // Past school years that were archived; loaded once and cached for the visit.
  useEffect(() => {
    if (approvalsOnly) return;
    let current = true;
    api<ArchiveYear[]>('rfa.archives').then((rows) => { if (current) setArchives(Array.isArray(rows) ? rows : []); }).catch(() => undefined);
    return () => { current = false; };
  }, [approvalsOnly]);

  return <>
    <header className="page-header">
      <div>
        <span className="eyebrow orange">{copy.eyebrow}</span>
        <h1>{copy.title}</h1>
        <p>{approvedOnlyScope ? 'Approved, in-implementation, and closed requests across all departments, for procurement.' : copy.text}</p>
      </div>
    </header>
    <ErrorNotice message={error} />
    {!approvalsOnly && <div className={`filters${archives.length ? ' with-year' : ''}`}>
      {archives.length > 0 && <label>
        <span className="sr-only">School year</span>
        <select value={schoolYear} onChange={(e) => setSchoolYear(e.target.value)} aria-label="School year">
          <option value="">Current school year</option>
          {archives.map((year) => <option key={year.schoolYear} value={String(year.schoolYear)}>{year.label}</option>)}
        </select>
      </label>}
      <label className="search-field">
        <Search size={16} />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search number, title, name, department…" aria-label="Search RFAs" />
      </label>
      <label>
        <span className="sr-only">Status</span>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          {['DRAFT','PENDING_RECOMMENDING_APPROVAL','PENDING_REVIEW','PENDING_AUTHORITY_APPROVAL','RETURNED','DISAPPROVED','APPROVED','IMPLEMENTATION','CLOSED','CANCELLED','EXCEPTION'].map((item) => <option key={item} value={item}>{item.replaceAll('_',' ')}</option>)}
        </select>
      </label>
      <label>
        <span className="sr-only">Expense classification</span>
        <select value={expenseClassification} onChange={(e) => setExpenseClassification(e.target.value)}>
          <option value="">All types</option>
          <option value="OPEX">OPEX</option>
          <option value="CAPEX">CAPEX</option>
        </select>
      </label>
      <label>
        <span className="sr-only">Fiscal year</span>
        <input value={fiscalYear} onChange={(e) => setFiscalYear(e.target.value)} placeholder="Year, e.g. 2026" inputMode="numeric" aria-label="Fiscal year" />
      </label>
    </div>}
    <section className={`panel flush${loading && rfas.length ? ' is-refreshing' : ''}`} aria-busy={loading}>
      {loading && !rfas.length
        ? <ListSkeleton />
        : rfas.length
          ? <RfaTable rfas={rfas} review={approvalsOnly} schoolYear={schoolYear} />
          : <Empty title={copy.empty} text={copy.emptyText} />}
    </section>
  </>;
}

function ListSkeleton() {
  return <div aria-label="Loading RFAs" role="status">
    {Array.from({ length: 6 }).map((_, i) => <div key={i} className="skeleton-row">
      <div className="skeleton skeleton-cell" style={{ width: 96 }} />
      <div className="skeleton skeleton-cell" style={{ flex: 1 }} />
      <div className="skeleton skeleton-cell" style={{ width: 110 }} />
      <div className="skeleton skeleton-cell" style={{ width: 80 }} />
    </div>)}
  </div>;
}
