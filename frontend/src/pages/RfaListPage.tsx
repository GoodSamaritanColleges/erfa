import { Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { ErrorNotice, Spinner } from '../components';
import type { Rfa } from '../types';
import { Empty, RfaTable } from './DashboardPage';

export function RfaListPage({ approvalsOnly = false }: { approvalsOnly?: boolean }) {
  const [rfas, setRfas] = useState<Rfa[]>([]);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => {
      setLoading(true);
      void api<Rfa[]>(approvalsOnly ? 'rfa.forApproval' : 'rfa.list', approvalsOnly ? {} : { query, status })
        .then(setRfas)
        .catch((e: Error) => setError(e.message))
        .finally(() => setLoading(false));
    }, 200);
    return () => clearTimeout(timer);
  }, [query, status, approvalsOnly]);

  return <>
    <header className="page-header">
      <div>
        <span className="eyebrow orange">{approvalsOnly ? 'APPROVAL QUEUE' : 'REQUEST REGISTER'}</span>
        <h1>{approvalsOnly ? 'For My Action' : 'My RFAs'}</h1>
        <p>{approvalsOnly
          ? 'Requests currently assigned to you. Review every detail before deciding.'
          : 'Search, filter, and follow each request from draft through closeout.'}
        </p>
      </div>
    </header>
    <ErrorNotice message={error} />
    {!approvalsOnly && <div className="filters">
      <label className="search-field">
        <Search size={16} />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="RFA number, title, requester, or department" aria-label="Search RFAs" />
      </label>
      <label>
        <span className="sr-only">Status</span>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          {['DRAFT','PENDING_RECOMMENDING_APPROVAL','PENDING_REVIEW','PENDING_AUTHORITY_APPROVAL','RETURNED','DISAPPROVED','APPROVED','IMPLEMENTATION','CLOSED','CANCELLED','EXCEPTION'].map((item) => <option key={item} value={item}>{item.replaceAll('_',' ')}</option>)}
        </select>
      </label>
    </div>}
    <section className="panel flush">
      {loading
        ? <Spinner label="Loading RFAs" />
        : rfas.length
          ? <RfaTable rfas={rfas} />
          : <Empty title={approvalsOnly ? 'No requests need your action' : 'No matching RFAs'} text={approvalsOnly ? 'Your queue is clear.' : 'Try a different search or create a new Request for Approval.'} />}
    </section>
  </>;
}
