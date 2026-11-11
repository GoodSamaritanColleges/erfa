import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { ErrorNotice, Spinner, StatusBadge } from '../components';
import { currentSchoolYear, isFiscalYear, money, schoolYearLabel, schoolYearOptions } from '../format';

type DetailRow = { rfaId: string; rfaNumber: string; dateFiled: string; departmentId: string; department: string; involvedDepartment: string; title: string; purpose: string; requester: string; expenseClassification: string; amount: number; fiscalYear: string; status: string };
type Report = { fiscalYear: string; departments: Array<{ DEPARTMENT_ID: string; DEPARTMENT_NAME: string }>; deptRows: Array<{ departmentName: string }>; rows: DetailRow[]; totals: { totalOpex: number; totalCapex: number; total: number; rfaCount: number } };

export function DepartmentExpenseReportPage() {
  const [params] = useSearchParams();
  const [fiscalYear, setFiscalYear] = useState(params.get('fiscalYear') || String(currentSchoolYear()));
  const [departmentId, setDepartmentId] = useState(params.get('departmentId') || '');
  const [expenseClassification, setExpenseClassification] = useState('');
  const [status, setStatus] = useState('');
  const [query, setQuery] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isFiscalYear(fiscalYear)) { setLoading(false); return; }
    let current = true;
    setLoading(true);
    void api<Report>('expense.monitoring', { fiscalYear, departmentId, expenseClassification, status, query, fromDate, toDate })
      .then((next) => { if (current) { setReport(next); setError(''); } })
      .catch((caught: Error) => { if (current) setError(caught.message); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [fiscalYear, departmentId, expenseClassification, status, query, fromDate, toDate]);

  function exportCsv() {
    if (!report) return;
    const lines: Array<Array<string | number>> = [
      ['Good Samaritan Colleges', 'Expense Monitoring — Filtered Records'],
      ['School Year', schoolYearLabel(report.fiscalYear)],
      ['Department', report.departments.find((item) => item.DEPARTMENT_ID === departmentId)?.DEPARTMENT_NAME || 'All departments'],
      ['Type', expenseClassification || 'All'], ['Status', status || 'Recorded only'],
      [],
      ['RFA Number', 'Date Filed', 'Requesting Department', 'Involved Department', 'Title', 'Purpose', 'Requester', 'Type', 'Amount', 'School Year', 'Status'],
      ...report.rows.map((row) => [row.rfaNumber, row.dateFiled, row.department, row.involvedDepartment, row.title, row.purpose, row.requester, row.expenseClassification, row.amount, schoolYearLabel(row.fiscalYear), row.status]),
      [],
      ['TOTALS', 'Total OPEX', report.totals.totalOpex, 'Total CAPEX', report.totals.totalCapex, 'Combined', report.totals.total, 'RFAs', report.totals.rfaCount]
    ];
    const csv = lines.map((line) => line.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `erfa-expense-monitoring-sy${report.fiscalYear}-${Number(report.fiscalYear) + 1}.csv`; anchor.click();
    URL.revokeObjectURL(url);
  }

  return <>
    <header className="page-header"><div><span className="eyebrow orange">EXPENSE MONITORING</span><h1>Department Expense Report</h1><p>Filtered recorded RFA expenses. Amounts are attributed once to the requesting department.</p></div></header>
    <ErrorNotice message={error} />
    <section className="form-card report-filters">
      <label className="field"><span>School Year</span><select value={fiscalYear} onChange={(event) => setFiscalYear(event.target.value)}>{schoolYearOptions().map((option) => <option key={option.value} value={option.value}>{option.label}{option.value === String(currentSchoolYear()) ? ' (current)' : ''}</option>)}</select></label>
      <label className="field"><span>Department</span><select value={departmentId} onChange={(event) => setDepartmentId(event.target.value)}><option value="">All departments</option>{report?.departments.map((item) => <option key={item.DEPARTMENT_ID} value={item.DEPARTMENT_ID}>{item.DEPARTMENT_NAME}</option>)}</select></label>
      <label className="field"><span>Type</span><select value={expenseClassification} onChange={(event) => setExpenseClassification(event.target.value)}><option value="">All types</option><option value="OPEX">OPEX</option><option value="CAPEX">CAPEX</option></select></label>
      <label className="field"><span>RFA status</span><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">Recorded only</option>{['DRAFT','SUBMITTED','PENDING_REVIEW','PENDING_AUTHORITY_APPROVAL','PENDING_RECOMMENDING_APPROVAL','RETURNED','DISAPPROVED','APPROVED','IMPLEMENTATION','CLOSED','CANCELLED'].map((item) => <option key={item} value={item}>{item.replaceAll('_',' ')}</option>)}</select></label>
      <label className="field"><span>Search RFA / title</span><input value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      <label className="field"><span>Date from</span><input type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} /></label>
      <label className="field"><span>Date to</span><input type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} /></label>
      <button className="button secondary" disabled={!report} onClick={exportCsv}>Export CSV</button>
    </section>
    {loading ? <Spinner label="Loading expenses" /> : report && <>
      <section className="metric-grid">
        <Metric label="Total OPEX" value={money(report.totals.totalOpex)} />
        <Metric label="Total CAPEX" value={money(report.totals.totalCapex)} />
        <Metric label="Combined Total" value={money(report.totals.total)} />
        <Metric label="Number of RFAs" value={String(report.totals.rfaCount)} />
      </section>
      <section className="table-panel"><header><h2>Filtered expense records</h2><span className="muted">Use the filters above; export downloads the same filtered set.</span></header>
        <div className="table-wrap"><table><thead><tr><th>RFA</th><th>Date Filed</th><th>Requester</th><th>Department</th><th>Involved</th><th>Type</th><th>Title / Purpose</th><th>Amount</th><th>Status</th></tr></thead><tbody>
          {report.rows.length ? report.rows.map((row) => <tr key={row.rfaId}><td data-label="RFA"><Link className="rfa-number" to={`/rfa/${row.rfaId}`}>{row.rfaNumber}</Link></td><td data-label="Date">{row.dateFiled}</td><td data-label="Requester">{row.requester}</td><td data-label="Department">{row.department}</td><td data-label="Involved">{row.involvedDepartment || '—'}</td><td data-label="Type"><b>{row.expenseClassification || '—'}</b></td><td data-label="Title / Purpose"><span className="cell-primary">{row.title}</span><small>{row.purpose}</small></td><td data-label="Amount" className="amount-cell">{money(row.amount)}</td><td data-label="Status"><StatusBadge status={row.status} /></td></tr>) : <tr><td colSpan={9}>No recorded expenses match these filters.</td></tr>}
        </tbody></table></div>
      </section>
    </>}
  </>;
}

function Metric({ label, value }: { label: string; value: string }) { return <div className="metric-card"><span>{label}</span><b>{value}</b></div>; }
