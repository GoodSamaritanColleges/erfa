import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { ErrorNotice, Spinner, StatusBadge } from '../components';
import { money } from '../format';

type ExpenseRow = { rfaId: string; rfaNumber: string; dateApproved: string; requester: string; department: string; title: string; purpose: string; amount: number; status: string };
type Report = { fiscalYear: string; departments: Array<{ DEPARTMENT_ID: string; DEPARTMENT_NAME: string }>; annualBudget: number; used: number; remaining: number; rows: ExpenseRow[] };

export function DepartmentExpenseReportPage() {
  const [params] = useSearchParams();
  const [fiscalYear, setFiscalYear] = useState(params.get('fiscalYear') || String(new Date().getFullYear()));
  const [departmentId, setDepartmentId] = useState(params.get('departmentId') || '');
  const [query, setQuery] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!/^\d{4}$/.test(fiscalYear)) { setLoading(false); return; }
    let current = true;
    setLoading(true);
    void api<Report>('admin.budget.expenses', { fiscalYear, departmentId, query, fromDate, toDate })
      .then((next) => { if (current) { setReport(next); setError(''); } })
      .catch((caught: Error) => { if (current) setError(caught.message); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [fiscalYear, departmentId, query, fromDate, toDate]);

  function exportCsv() {
    if (!report) return;
    const lines: Array<Array<string | number>> = [
      ['Good Samaritan Colleges', 'Department Expense Report'],
      ['Fiscal Year', report.fiscalYear],
      ['Department', report.departments.find((item) => item.DEPARTMENT_ID === departmentId)?.DEPARTMENT_NAME || 'All departments'],
      ['Annual Budget', report.annualBudget], ['Used', report.used], ['Remaining', report.remaining], [],
      ['RFA Number', 'Date Approved', 'Requester', 'Department', 'Title', 'Purpose', 'Approved RFA Expense', 'Current Status'],
      ...report.rows.map((row) => [row.rfaNumber, row.dateApproved, row.requester, row.department, row.title, row.purpose, row.amount, row.status])
    ];
    const csv = lines.map((line) => line.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `erfa-expenses-fy${report.fiscalYear}.csv`; anchor.click();
    URL.revokeObjectURL(url);
  }

  return <>
    <header className="page-header"><div><span className="eyebrow orange">ADMINISTRATION</span><h1>Department Expense Report</h1><p>Approved RFAs are the department’s budget expenses.</p></div></header>
    <ErrorNotice message={error} />
    <section className="form-card report-filters">
      <label className="field"><span>Fiscal Year</span><input inputMode="numeric" maxLength={4} value={fiscalYear} onChange={(event) => setFiscalYear(event.target.value)} /></label>
      <label className="field"><span>Department</span><select value={departmentId} onChange={(event) => setDepartmentId(event.target.value)}><option value="">All departments</option>{report?.departments.map((item) => <option key={item.DEPARTMENT_ID} value={item.DEPARTMENT_ID}>{item.DEPARTMENT_NAME}</option>)}</select></label>
      <label className="field"><span>Search RFA / title</span><input value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      <label className="field"><span>Approved from</span><input type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} /></label>
      <label className="field"><span>Approved to</span><input type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} /></label>
      <button className="button secondary" disabled={!report} onClick={exportCsv}>Export CSV</button>
    </section>
    {loading ? <Spinner label="Loading expenses" /> : report && <>
      <section className="metric-grid"><Metric label="Annual Budget" value={money(report.annualBudget)} /><Metric label="Used" value={money(report.used)} /><Metric label="Remaining" value={money(report.remaining)} /></section>
      <section className="table-panel"><header><h2>Approved RFA expenses</h2><span className="muted">Used is based on all valid approved RFA expenses; search and date filters affect the rows only.</span></header>
        <div className="table-wrap"><table><thead><tr><th>RFA</th><th>Approved</th><th>Requester</th><th>Department</th><th>Title / Purpose</th><th>Expense</th><th>Status</th></tr></thead><tbody>
          {report.rows.length ? report.rows.map((row) => <tr key={row.rfaId}><td data-label="RFA"><Link className="rfa-number" to={`/rfa/${row.rfaId}`}>{row.rfaNumber}</Link></td><td data-label="Approved">{row.dateApproved}</td><td data-label="Requester">{row.requester}</td><td data-label="Department">{row.department}</td><td data-label="Title / Purpose"><span className="cell-primary">{row.title}</span><small>{row.purpose}</small></td><td data-label="Expense" className="amount-cell">{money(row.amount)}</td><td data-label="Status"><StatusBadge status={row.status} /></td></tr>) : <tr><td colSpan={7}>No approved RFA expenses match these filters.</td></tr>}
        </tbody></table></div>
      </section>
    </>}
  </>;
}

function Metric({ label, value }: { label: string; value: string }) { return <div className="metric-card"><span>{label}</span><b>{value}</b></div>; }
