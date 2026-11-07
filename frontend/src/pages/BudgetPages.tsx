import { useEffect, useState } from 'react';
import { api } from '../api';
import { ErrorNotice, Spinner } from '../components';
import { fiscalYearPattern, isFiscalYear, money } from '../format';

type Department = { DEPARTMENT_ID: string; DEPARTMENT_NAME: string };
type DeptRow = { departmentId: string; departmentName: string; fiscalYear: string; totalOpex: number; totalCapex: number; total: number; rfaCount: number };
type DetailRow = { rfaId: string; rfaNumber: string; dateFiled: string; department: string; involvedDepartment: string; title: string; purpose: string; requester: string; expenseClassification: string; amount: number; fiscalYear: string; status: string };
type MonitoringData = { fiscalYear: string; departments: Department[]; deptRows: DeptRow[]; rows: DetailRow[]; totals: { totalOpex: number; totalCapex: number; total: number; rfaCount: number }; filters?: Record<string, string> };

export function BudgetManagementPage() {
  const [fiscalYear, setFiscalYear] = useState(String(new Date().getFullYear()));
  const [departmentId, setDepartmentId] = useState('');
  const [expenseClassification, setExpenseClassification] = useState('');
  const [status, setStatus] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [data, setData] = useState<MonitoringData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const yearValid = isFiscalYear(fiscalYear);

  useEffect(() => {
    if (!yearValid) { setLoading(false); return; }
    let current = true;
    setLoading(true);
    void api<MonitoringData>('expense.monitoring', { fiscalYear, departmentId, expenseClassification, status, fromDate, toDate })
      .then((next) => { if (current) { setData(next); setError(''); } })
      .catch((caught: Error) => { if (current) setError(caught.message); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [fiscalYear, departmentId, expenseClassification, status, fromDate, toDate, yearValid]);

  function exportCsv() {
    if (!data) return;
    const lines: Array<Array<string | number>> = [
      ['Good Samaritan Colleges', 'Expense Monitoring — Department Totals'],
      ['Fiscal Year', data.fiscalYear],
      ['Filters', `Department=${departmentId || 'All'} | Type=${expenseClassification || 'All'} | Status=${status || 'Recorded (Approved/Implementation/Closed)'} | Dates=${fromDate || 'Any'} to ${toDate || 'Any'}`],
      [],
      ['Department', 'Fiscal Year', 'Total OPEX', 'Total CAPEX', 'Combined Total', 'Number of RFAs'],
      ...data.deptRows.map((row) => [row.departmentName, row.fiscalYear, row.totalOpex, row.totalCapex, row.total, row.rfaCount]),
      ['ALL DEPARTMENTS', data.fiscalYear, data.totals.totalOpex, data.totals.totalCapex, data.totals.total, data.totals.rfaCount],
      [],
      ['Detail — Filtered RFA records (one row per RFA; involved department does not double-count)'],
      ['RFA Number', 'Date Filed', 'Requesting Department', 'Involved Department', 'Title', 'Purpose', 'Requester', 'Type', 'Amount', 'Fiscal Year', 'Status'],
      ...data.rows.map((row) => [row.rfaNumber, row.dateFiled, row.department, row.involvedDepartment, row.title, row.purpose, row.requester, row.expenseClassification, row.amount, row.fiscalYear, row.status])
    ];
    const csv = lines.map((line) => line.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `erfa-expense-monitoring-fy${fiscalYear}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return <div>
    <header className="page-header"><div><span className="eyebrow orange">EXPENSE MONITORING</span><h1>Department Expense Monitoring</h1><p>Recorded RFA amounts grouped by department. Total = Total OPEX + Total CAPEX. No budget subtraction applies.</p></div></header>
    <ErrorNotice message={error} />
    <section className="form-card report-filters">
      <label className="field"><span>Fiscal Year</span><input inputMode="numeric" maxLength={4} pattern={fiscalYearPattern} title="Enter a four-digit fiscal year, for example 2026." value={fiscalYear} onChange={(e) => setFiscalYear(e.target.value)} /></label>
      <label className="field"><span>Department</span><select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}><option value="">All departments</option>{data?.departments.map((item) => <option key={item.DEPARTMENT_ID} value={item.DEPARTMENT_ID}>{item.DEPARTMENT_NAME}</option>)}</select></label>
      <label className="field"><span>Type</span><select value={expenseClassification} onChange={(e) => setExpenseClassification(e.target.value)}><option value="">All types</option><option value="OPEX">OPEX</option><option value="CAPEX">CAPEX</option></select></label>
      <label className="field"><span>RFA status</span><select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Recorded only</option>{['DRAFT','SUBMITTED','PENDING_REVIEW','PENDING_AUTHORITY_APPROVAL','PENDING_RECOMMENDING_APPROVAL','RETURNED','DISAPPROVED','APPROVED','IMPLEMENTATION','CLOSED','CANCELLED'].map((item) => <option key={item} value={item}>{item.replaceAll('_',' ')}</option>)}</select></label>
      <label className="field"><span>From date</span><input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} /></label>
      <label className="field"><span>To date</span><input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} /></label>
      <button className="button primary" disabled={!data || loading} onClick={exportCsv}>Export CSV</button>
    </section>
    {!yearValid && <p className="muted">Enter a four-digit fiscal year.</p>}
    {loading ? <Spinner label="Loading expenses" /> : data && <>
      <section className="metric-grid">
        <Metric label="Total OPEX" value={money(data.totals.totalOpex)} />
        <Metric label="Total CAPEX" value={money(data.totals.totalCapex)} />
        <Metric label="Combined Total" value={money(data.totals.total)} />
        <Metric label="Number of RFAs" value={String(data.totals.rfaCount)} />
      </section>
      <section className="table-panel"><header><h2>Expenses by department · FY {data.fiscalYear}</h2><span className="muted">Each RFA is attributed once to its requesting department.</span></header>
        <div className="table-wrap"><table><thead><tr><th>Department</th><th>Fiscal Year</th><th>Total OPEX</th><th>Total CAPEX</th><th>Combined Total</th><th>Number of RFAs</th></tr></thead><tbody>
          {data.deptRows.length ? data.deptRows.map((row) => <tr key={row.departmentId}><td data-label="Department"><span className="cell-primary">{row.departmentName}</span></td><td data-label="Fiscal Year">{row.fiscalYear}</td><td data-label="OPEX" className="amount-cell">{money(row.totalOpex)}</td><td data-label="CAPEX" className="amount-cell">{money(row.totalCapex)}</td><td data-label="Total" className="amount-cell">{money(row.total)}</td><td data-label="Count">{row.rfaCount}</td></tr>) : <tr><td colSpan={6}>No recorded expenses match these filters.</td></tr>}
          {data.deptRows.length > 0 && <tr><td><b>All departments</b></td><td>{data.fiscalYear}</td><td className="amount-cell"><b>{money(data.totals.totalOpex)}</b></td><td className="amount-cell"><b>{money(data.totals.totalCapex)}</b></td><td className="amount-cell"><b>{money(data.totals.total)}</b></td><td><b>{data.totals.rfaCount}</b></td></tr>}
        </tbody></table></div>
      </section>
      <section className="table-panel"><header><h2>Filtered RFA records</h2><span className="muted">Exported in CSV together with the grouped totals.</span></header>
        <div className="table-wrap"><table><thead><tr><th>RFA</th><th>Date Filed</th><th>Department</th><th>Involved</th><th>Type</th><th>Title</th><th>Amount</th><th>Status</th></tr></thead><tbody>
          {data.rows.length ? data.rows.map((row) => <tr key={row.rfaId}><td data-label="RFA">{row.rfaNumber}</td><td data-label="Date">{row.dateFiled}</td><td data-label="Department">{row.department}</td><td data-label="Involved">{row.involvedDepartment || '—'}</td><td data-label="Type"><b>{row.expenseClassification || '—'}</b></td><td data-label="Title"><span className="cell-primary">{row.title}</span><small>{row.requester}</small></td><td data-label="Amount" className="amount-cell">{money(row.amount)}</td><td data-label="Status">{row.status}</td></tr>) : <tr><td colSpan={8}>No records match these filters.</td></tr>}
        </tbody></table></div>
      </section>
    </>}
  </div>;
}

function Metric({ label, value }: { label: string; value: string }) { return <div className="metric-card"><span>{label}</span><b>{value}</b></div>; }
