import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { Dialog, ErrorNotice, Spinner, SuccessNotice } from '../components';
import { money } from '../format';

type Department = { DEPARTMENT_ID: string; DEPARTMENT_NAME: string };
type Category = { CATEGORY_ID: string; CATEGORY_NAME: string; DESCRIPTION: string; ACTIVE: boolean };
type BudgetRow = { budgetId: string; departmentId: string; departmentName: string; allocated: number; committed: number; actualSpent: number; available: number; utilization: number; allowOverBudget: boolean };
type ManagementData = { fiscalYear: string; departments: Department[]; rows: BudgetRow[]; totals: { allocated: number; committed: number; actualSpent: number; available: number } };
type Report = { rows: Array<{ rfaId: string; rfaNumber: string; dateFiled: string; departmentId: string; department: string; categoryId: string; category: string; purpose: string; requestedAmount: number; approvedAmount: number; committedAmount: number; actualAmount: number; financialStatus: string; rfaStatus: string }>; totals: { requested: number; approved: number; actual: number; committed: number }; departments: Department[]; categories: Category[]; categorySummary: Array<{ categoryId: string; category: string; rfaCount: number; committed: number; actual: number; totalFinancialActivity: number }>; transactions: Array<{ transactionId: string; timestamp: string; department: string; fiscalYear: string; type: string; rfaId: string; rfaNumber: string; category: string; amount: number; description: string; reference: string; actor: string }> };

export function BudgetManagementPage() {
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [data, setData] = useState<ManagementData | null>(null);
  const [mode, setMode] = useState<'list' | 'set' | 'detail' | 'categories'>('list');
  const [departmentId, setDepartmentId] = useState('');
  const [amount, setAmount] = useState('');
  const [overBudget, setOverBudget] = useState(false);
  const [adjusting, setAdjusting] = useState(false);
  const [adjustment, setAdjustment] = useState('');
  const [direction, setDirection] = useState<'INCREASE' | 'DECREASE'>('INCREASE');
  const [reason, setReason] = useState('');
  const [confirmAdjustment, setConfirmAdjustment] = useState(false);
  const [categories, setCategories] = useState<Category[] | null>(null);
  const [categoryName, setCategoryName] = useState('');
  const [categoryDescription, setCategoryDescription] = useState('');
  const [categoryLoading, setCategoryLoading] = useState(false);
  const [categoryWorking, setCategoryWorking] = useState(false);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const yearValid = /^\d{4}$/.test(year);
  const shown = !working && !loading && data?.fiscalYear === year ? data : null;
  const selectedBudget = shown?.rows.find((row) => row.departmentId === departmentId);
  const detailVisible = mode === 'detail' || (mode === 'set' && Boolean(selectedBudget));
  const reportUrl = `/admin/budget-reports?fiscalYear=${encodeURIComponent(year)}`;
  const departmentReportUrl = `${reportUrl}&departmentId=${encodeURIComponent(departmentId)}`;

  useEffect(() => {
    if (!/^\d{4}$/.test(year)) { setLoading(false); return; }
    let current = true;
    setLoading(true);
    const timer = setTimeout(() => {
      void api<ManagementData>('admin.budget.management', { fiscalYear: year })
        .then((next) => { if (current) setData(next); })
        .catch((caught: Error) => { if (current) setError(caught.message); })
        .finally(() => { if (current) setLoading(false); });
    }, data ? 300 : 0);
    return () => { current = false; clearTimeout(timer); };
  }, [year]);

  async function refreshBudgets() {
    setData(null);
    setLoading(true);
    try { setData(await api<ManagementData>('admin.budget.management', { fiscalYear: year })); }
    catch (caught) { setError((previous) => previous || (caught instanceof Error ? caught.message : 'Could not reload budgets.')); }
    finally { setLoading(false); }
  }

  async function changeBudget(action: string, payload: Record<string, unknown>, message: string, after?: () => void) {
    setWorking(true); setError(''); setSuccess('');
    try { await api(action, payload); after?.(); setSuccess(message); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Budget update failed.'); }
    finally { await refreshBudgets(); setWorking(false); }
  }

  async function createBudget() {
    if (!departmentId || selectedBudget || !yearValid) return;
    await changeBudget('admin.budget.save', { departmentId, fiscalYear: year, allocatedAmount: amount, allowOverBudget: overBudget }, 'Department budget saved.', () => { setMode('detail'); setAmount(''); });
  }

  async function applyAdjustment() {
    if (!selectedBudget) return;
    setConfirmAdjustment(false);
    await changeBudget('admin.budget.adjust', { budgetId: selectedBudget.budgetId, changeAmount: adjustment, direction, reason }, 'Budget adjustment saved with its audit history.', () => { setAdjusting(false); setAdjustment(''); setReason(''); });
  }

  async function openCategories() {
    setMode('categories');
    if (categories) return;
    setCategoryLoading(true);
    try { setCategories(await api<Category[]>('admin.category.list')); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not load categories.'); }
    finally { setCategoryLoading(false); }
  }

  async function saveCategory() {
    setCategoryWorking(true); setError(''); setSuccess('');
    try {
      await api('admin.category.save', { name: categoryName, description: categoryDescription, active: true });
      setCategoryName(''); setCategoryDescription(''); setSuccess('Expense category saved.');
      setCategories(null);
      try { setCategories(await api<Category[]>('admin.category.list')); }
      catch { setError('Category saved, but the list could not be refreshed. Reopen Expense Categories to try again.'); }
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not save category.'); }
    finally { setCategoryWorking(false); }
  }

  return <>
    <header className="page-header"><div><span className="eyebrow orange">ADMINISTRATION</span><h1>Budget Management</h1><p>Set and review department budgets by fiscal year.</p></div></header>
    <ErrorNotice message={error} /><SuccessNotice message={success} />
    <div className="budget-toolbar">
      <label className="field compact"><span>Fiscal Year</span><input list="budget-fiscal-years" value={year} inputMode="numeric" maxLength={4} disabled={working} onChange={(event) => { setYear(event.target.value); setData(null); setDepartmentId(''); setMode('list'); setConfirmAdjustment(false); setError(''); }} /></label>
      <datalist id="budget-fiscal-years">{Array.from({ length: 9 }, (_, index) => new Date().getFullYear() + 3 - index).map((option) => <option key={option} value={option} />)}</datalist>
      <button className="button primary" disabled={!yearValid || working} onClick={() => { setMode('set'); setDepartmentId(''); setAdjusting(false); setConfirmAdjustment(false); }}>Set Department Budget</button>
      <Link className="button secondary" to={reportUrl}>Expense Reports</Link>
      <Link className="button secondary" to={`${reportUrl}#transaction-history`}>Transaction History</Link>
    </div>
    {!yearValid && <p className="muted">Enter a four-digit fiscal year.</p>}
    <section className="table-panel"><header><h2>Department Budgets · FY {year}</h2></header>
      {loading || working ? <Spinner label="Loading current budgets" /> : shown ? <div className="table-wrap"><table><thead><tr><th>Department</th><th>Budget</th><th>Committed</th><th>Spent</th><th>Available</th><th>Utilization</th><th>Action</th></tr></thead><tbody>
        {shown.rows.length ? shown.rows.map((row) => <tr key={row.budgetId}><td>{row.departmentName}</td><td>{money(row.allocated)}</td><td>{money(row.committed)}</td><td>{money(row.actualSpent)}</td><td>{money(row.available)}</td><td>{(row.utilization * 100).toFixed(1)}%</td><td><button className="button secondary" onClick={() => { setDepartmentId(row.departmentId); setMode('detail'); setAdjusting(false); setConfirmAdjustment(false); }}>View</button></td></tr>) : <tr><td colSpan={7}>No department budgets are configured for FY {year}.</td></tr>}
      </tbody></table></div> : null}
    </section>
    {mode === 'set' && shown && <section className="form-card budget-panel"><h2>Set Department Budget</h2><p className="muted">Fiscal Year: {year}</p>
      <label className="field"><span>Department</span><select value={departmentId} disabled={working} onChange={(event) => setDepartmentId(event.target.value)}><option value="">Select department</option>{shown.departments.map((department) => <option key={department.DEPARTMENT_ID} value={department.DEPARTMENT_ID}>{department.DEPARTMENT_NAME}</option>)}</select></label>
      {!selectedBudget && <><div className="form-grid budget-fields"><label className="field"><span>Budget Amount (PHP)</span><input type="number" min="0.01" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} /></label><label className="field"><span>Allow Over Budget</span><select value={overBudget ? 'yes' : 'no'} onChange={(event) => setOverBudget(event.target.value === 'yes')}><option value="no">No</option><option value="yes">Yes</option></select></label></div><button className="button primary" disabled={!departmentId || !yearValid || Number(amount) <= 0 || working} onClick={() => void createBudget()}>Save Budget</button></>}
      {selectedBudget && <p className="muted">A budget already exists for this department and year. Use Adjust Budget below to change it without overwriting its history.</p>}
    </section>}
    {detailVisible && selectedBudget && <section className="form-card budget-panel"><h2>{selectedBudget.departmentName} · FY {year}</h2><p className="muted">Current / effective budget</p>
      <div className="metric-grid budget-detail-metrics"><Metric label="Allocated Budget" value={money(selectedBudget.allocated)} /><Metric label="Committed" value={money(selectedBudget.committed)} /><Metric label="Actual Spent" value={money(selectedBudget.actualSpent)} /><Metric label="Available" value={money(selectedBudget.available)} /><Metric label="Utilization" value={`${(selectedBudget.utilization * 100).toFixed(1)}%`} /></div>
      <div className="budget-detail-actions"><button className="button primary" disabled={working} onClick={() => setAdjusting((value) => !value)}>Adjust Budget</button><Link className="button secondary" to={departmentReportUrl}>Department Detail</Link><Link className="button secondary" to={`${departmentReportUrl}#transaction-history`}>Transaction History</Link></div>
      <label className="field budget-policy"><span>Allow Over Budget</span><select value={selectedBudget.allowOverBudget ? 'yes' : 'no'} disabled={working} onChange={(event) => void changeBudget('admin.budget.overBudget', { budgetId: selectedBudget.budgetId, allowOverBudget: event.target.value === 'yes' }, 'Over-budget policy updated.')}><option value="no">No</option><option value="yes">Yes</option></select></label>
      {adjusting && <div className="budget-adjustment"><h3>Adjust Budget</h3><p className="muted">Changes are recorded as an adjustment; prior allocations and transactions remain in the audit trail.</p><div className="form-grid"><label className="field"><span>Change</span><select value={direction} onChange={(event) => setDirection(event.target.value as 'INCREASE' | 'DECREASE')}><option value="INCREASE">Increase</option><option value="DECREASE">Decrease</option></select></label><label className="field"><span>Adjustment Amount (PHP)</span><input type="number" min="0.01" step="0.01" value={adjustment} onChange={(event) => setAdjustment(event.target.value)} /></label></div><label className="field"><span>Reason</span><input value={reason} onChange={(event) => setReason(event.target.value)} /></label><button className="button primary" disabled={!Number.isFinite(Number(adjustment)) || Number(adjustment) <= 0 || reason.trim().length < 3 || working} onClick={() => setConfirmAdjustment(true)}>Review Adjustment</button></div>}
    </section>}
    <div className="budget-categories-link"><button className="button secondary" onClick={() => void openCategories()}>Expense Categories</button></div>
    {mode === 'categories' && <section className="form-card budget-panel"><h2>Expense Categories</h2>{categoryLoading ? <Spinner label="Loading categories" /> : <><p className="muted">{categories?.length ? categories.map((category) => category.CATEGORY_NAME).join(' · ') : 'No categories configured.'}</p><div className="form-grid"><label className="field"><span>Name</span><input value={categoryName} onChange={(event) => setCategoryName(event.target.value)} /></label><label className="field"><span>Description</span><input value={categoryDescription} onChange={(event) => setCategoryDescription(event.target.value)} /></label></div><button className="button secondary" disabled={categoryName.trim().length < 2 || categoryWorking} onClick={() => void saveCategory()}>{categoryWorking ? 'Saving Category...' : 'Add Category'}</button></>}</section>}
    {confirmAdjustment && selectedBudget && <Dialog title="Confirm Budget Adjustment" onClose={() => setConfirmAdjustment(false)}><div className="dialog-body"><p>{selectedBudget.departmentName} · FY {year}</p><p>Current budget: {money(selectedBudget.allocated)}<br />{direction === 'INCREASE' ? 'Increase' : 'Decrease'}: {money(Number(adjustment))}<br />New effective budget: {money(selectedBudget.allocated + (direction === 'INCREASE' ? 1 : -1) * Number(adjustment))}</p><p>Reason: {reason.trim()}</p><div className="dialog-actions"><button className="button secondary" onClick={() => setConfirmAdjustment(false)}>Cancel</button><button className="button primary" onClick={() => void applyAdjustment()}>Confirm Adjustment</button></div></div></Dialog>}
  </>;
}

export function BudgetReportsPage() {
  const { hash } = useLocation();
  const [params] = useSearchParams(); const [filters, setFilters] = useState({ fiscalYear: params.get('fiscalYear') || String(new Date().getFullYear()), departmentId: params.get('departmentId') || '', categoryId: '', fromDate: '', toDate: '', status: '', financialStatus: '', query: '' }); const filtersRef = useRef(filters); filtersRef.current = filters; const [report, setReport] = useState<Report | null>(null); const [error, setError] = useState(''); const [loading, setLoading] = useState(true);
  const load = () => { setLoading(true); void api<Report>('admin.budget.report', filtersRef.current).then(setReport).catch((e: Error) => setError(e.message)).finally(() => setLoading(false)); };
  useEffect(() => { if (filters.fiscalYear && !/^\d{4}$/.test(filters.fiscalYear)) return; const timer = setTimeout(load, report ? 300 : 0); return () => clearTimeout(timer); }, [filters.fiscalYear]);
  useEffect(() => { if (report && hash === '#transaction-history') document.getElementById('transaction-history')?.scrollIntoView({ block: 'start' }); }, [report, hash]);
  const set = (key: keyof typeof filters, value: string) => setFilters((current) => ({ ...current, [key]: value }));
  function exportCsv() { if (!report) return; const filterText = `Department: ${report.departments.find((item) => item.DEPARTMENT_ID === filters.departmentId)?.DEPARTMENT_NAME || 'All'} | FY: ${filters.fiscalYear || 'All'} | Dates: ${filters.fromDate || 'Any'} to ${filters.toDate || 'Any'} | Category: ${report.categories.find((item) => item.CATEGORY_ID === filters.categoryId)?.CATEGORY_NAME || 'All'} | RFA: ${filters.status || 'All'} | Financial: ${filters.financialStatus || 'All'}`; const rows = [['Good Samaritan Colleges'], ['Electronic Request for Approval'], ['Department Expense Report'], [filterText], [`Generated: ${new Date().toLocaleString('en-PH')}`], [], ['RFA Number','RFA Date','Department','Category','Purpose / Description','Requested Amount','Approved Amount','Committed Amount','Actual Amount','RFA Status','Financial Status'], ...report.rows.map((row) => [row.rfaNumber,row.dateFiled,row.department,row.category,row.purpose,row.requestedAmount,row.approvedAmount,row.committedAmount,row.actualAmount,row.rfaStatus,row.financialStatus]), [], ['TOTALS','','','','',report.totals.requested,report.totals.approved,report.totals.committed,report.totals.actual,'','']]; const csv = rows.map((row) => row.map((value) => `"${String(value).replaceAll('"','""')}"`).join(',')).join('\n'); const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `erfa-department-expense-report-fy${filters.fiscalYear || 'all'}.csv`; anchor.click(); URL.revokeObjectURL(url); }
  return <><header className="page-header"><div><span className="eyebrow orange">ADMINISTRATION</span><h1>Department Expense Reports</h1><p>Financial RFAs, category activity, and immutable ledger history.</p></div></header><ErrorNotice message={error} /><section className="form-card report-filters"><label className="field"><span>Department</span><select value={filters.departmentId} onChange={(e) => set('departmentId', e.target.value)}><option value="">All departments</option>{report?.departments.map((item) => <option key={item.DEPARTMENT_ID} value={item.DEPARTMENT_ID}>{item.DEPARTMENT_NAME}</option>)}</select></label><label className="field"><span>Fiscal Year</span><input value={filters.fiscalYear} onChange={(e) => set('fiscalYear', e.target.value)} /></label><label className="field"><span>From date</span><input type="date" value={filters.fromDate} onChange={(e) => set('fromDate', e.target.value)} /></label><label className="field"><span>To date</span><input type="date" value={filters.toDate} onChange={(e) => set('toDate', e.target.value)} /></label><label className="field"><span>Expense category</span><select value={filters.categoryId} onChange={(e) => set('categoryId', e.target.value)}><option value="">All categories</option>{report?.categories.map((item) => <option key={item.CATEGORY_ID} value={item.CATEGORY_ID}>{item.CATEGORY_NAME}</option>)}</select></label><label className="field"><span>RFA status</span><select value={filters.status} onChange={(e) => set('status', e.target.value)}><option value="">All statuses</option>{['DRAFT','SUBMITTED','PENDING_RECOMMENDING_APPROVAL','PENDING_REVIEW','PENDING_AUTHORITY_APPROVAL','RETURNED','DISAPPROVED','APPROVED','IMPLEMENTATION','CLOSED','CANCELLED'].map((item) => <option key={item}>{item}</option>)}</select></label><label className="field"><span>Financial status</span><select value={filters.financialStatus} onChange={(e) => set('financialStatus', e.target.value)}><option value="">All financial states</option><option>UNCOMMITTED</option><option>COMMITTED</option><option>ACTUAL_RECORDED</option></select></label><label className="field"><span>Search RFA / purpose</span><input value={filters.query} onChange={(e) => set('query', e.target.value)} /></label><button className="button secondary" onClick={load}>Apply filters</button><button className="button primary" disabled={!report} onClick={exportCsv}>Export CSV</button></section>{loading && !report ? <Spinner label="Loading report" /> : <><section className="metric-grid"><Metric label="Total requested" value={money(report?.totals.requested || 0)} /><Metric label="Total approved" value={money(report?.totals.approved || 0)} /><Metric label="Total committed" value={money(report?.totals.committed || 0)} /><Metric label="Total actual spent" value={money(report?.totals.actual || 0)} /></section><section className="table-panel"><header><h2>Expense by category</h2><span className="muted">Select a category to drill into its RFAs.</span></header><div className="table-wrap"><table><thead><tr><th>Category</th><th>RFAs</th><th>Committed</th><th>Actual spent</th><th>Total activity</th></tr></thead><tbody>{report?.categorySummary.length ? report.categorySummary.map((row) => <tr key={row.categoryId} className="clickable-row" onClick={() => { set('categoryId', row.categoryId); setTimeout(load, 0); }}><td>{row.category}</td><td>{row.rfaCount}</td><td>{money(row.committed)}</td><td>{money(row.actual)}</td><td>{money(row.totalFinancialActivity)}</td></tr>) : <tr><td colSpan={5}>No category activity matches the current filters.</td></tr>}</tbody></table></div></section><section className="table-panel"><header><h2>Financial RFAs</h2></header><div className="table-wrap"><table><thead><tr><th>RFA</th><th>Department</th><th>Category</th><th>Requested</th><th>Approved</th><th>Committed</th><th>Actual</th><th>Financial</th><th>RFA Status</th></tr></thead><tbody>{report?.rows.length ? report.rows.map((row) => <tr key={row.rfaId}><td><Link to={`/rfa/${row.rfaId}`}>{row.rfaNumber}</Link><small>{row.purpose}</small></td><td>{row.department}</td><td>{row.category}</td><td>{money(row.requestedAmount)}</td><td>{money(row.approvedAmount)}</td><td>{money(row.committedAmount)}</td><td>{money(row.actualAmount)}</td><td>{row.financialStatus}</td><td>{row.rfaStatus}</td></tr>) : <tr><td colSpan={9}>No matching financial RFAs.</td></tr>}</tbody></table></div></section><section id="transaction-history" className="table-panel"><header><h2>Financial transaction history</h2><span className="muted">Append-only ledger entries</span></header><div className="table-wrap"><table><thead><tr><th>Date / time</th><th>Department</th><th>FY</th><th>Type</th><th>RFA</th><th>Category</th><th>Amount</th><th>Description / reference</th><th>Actor</th></tr></thead><tbody>{report?.transactions.length ? report.transactions.map((item) => <tr key={item.transactionId}><td>{item.timestamp}</td><td>{item.department}</td><td>{item.fiscalYear}</td><td>{item.type}</td><td>{item.rfaId ? <Link to={`/rfa/${item.rfaId}`}>{item.rfaNumber || item.rfaId}</Link> : '—'}</td><td>{item.category || '—'}</td><td>{money(item.amount)}</td><td>{item.description}{item.reference ? ` · ${item.reference}` : ''}</td><td>{item.actor}</td></tr>) : <tr><td colSpan={9}>No matching financial transactions.</td></tr>}</tbody></table></div></section></>}</>;
}
function Metric({ label, value }: { label: string; value: string }) { return <div className="metric-card"><span>{label}</span><b>{value}</b></div>; }
