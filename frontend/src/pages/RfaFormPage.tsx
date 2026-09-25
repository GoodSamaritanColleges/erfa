import { ArrowLeft, FileText, Paperclip, Save, Send, X } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, fileToBase64 } from '../api';
import { useAuth } from '../auth';
import { ErrorNotice, Spinner } from '../components';
import { dateInputValue, money } from '../format';
import type { ApprovalAssignments, ApprovalSection, EligibleApprover, EmployeeDirectory, Rfa, RfaDetail } from '../types';

interface FormState { requestTitle: string; purpose: string; budgetAllocation: string; targetDate: string; justification: string; isBudgetRequest: boolean; fiscalYear: string; expenseCategoryId: string; requestedAmount: string }
type BudgetContext = { fiscalYear: string; budget: { allocated: number; committed: number; actualSpent: number; available: number } | null; categories: Array<{ id: string; name: string }> };
const blank: FormState = { requestTitle: '', purpose: '', budgetAllocation: '', targetDate: '', justification: '', isBudgetRequest: false, fiscalYear: String(new Date().getFullYear()), expenseCategoryId: '', requestedAmount: '' };
const sections: Array<{ key: ApprovalSection; label: string }> = [
  { key: 'RECOMMENDING_APPROVAL', label: 'Recommending Approval' },
  { key: 'REVIEWED_BY', label: 'Reviewed By' },
  { key: 'NOTED_BY', label: 'Noted By' },
  { key: 'APPROVED_BY', label: 'Approved By' }
];
const emptyAssignments = (): ApprovalAssignments => ({ RECOMMENDING_APPROVAL: [], REVIEWED_BY: [], NOTED_BY: [], APPROVED_BY: [] });
const assignmentWorkflowMarker = 'RFA_ASSIGNMENTS_V1';

export function RfaFormPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [form, setForm] = useState<FormState>(blank);
  const [existing, setExisting] = useState<Rfa | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [employees, setEmployees] = useState<EmployeeDirectory>([]);
  const [assignments, setAssignments] = useState<ApprovalAssignments>(emptyAssignments);
  const [usesAssignmentWorkflow, setUsesAssignmentWorkflow] = useState(!id);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(Boolean(id));
  const [budgetContext, setBudgetContext] = useState<BudgetContext | null>(null);

  useEffect(() => {
    if (!id) return;
    void api<RfaDetail>('rfa.detail', { rfaId: id }).then(({ rfa, permissions, approvals }) => {
      if (!permissions.canEdit) throw new Error('This RFA is not editable.');
      setExisting(rfa);
      setForm({ requestTitle: rfa.REQUEST_TITLE, purpose: rfa.PURPOSE, budgetAllocation: String(rfa.BUDGET_ALLOCATION), targetDate: dateInputValue(rfa.TARGET_DATE), justification: rfa.JUSTIFICATION, isBudgetRequest: rfa.IS_BUDGET_REQUEST, fiscalYear: rfa.FISCAL_YEAR || String(new Date().getFullYear()), expenseCategoryId: rfa.EXPENSE_CATEGORY_ID || '', requestedAmount: rfa.REQUESTED_AMOUNT ? String(rfa.REQUESTED_AMOUNT / 100) : '' });
      const usesAssignments = rfa.CURRENT_MATRIX_ID === assignmentWorkflowMarker;
      setUsesAssignmentWorkflow(usesAssignments);
      setAssignments(usesAssignments
        ? sections.reduce((current, section) => ({ ...current, [section.key]: approvals.filter((row) => row.STEP === section.key && !row.ACTION).map((row) => row.APPROVER_USER_ID) }), emptyAssignments())
        : emptyAssignments());
    }).catch((e: Error) => setError(e.message)).finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    if (!usesAssignmentWorkflow) return;
    void api<{ employees: EmployeeDirectory }>('rfa.eligibleApprovers').then(({ employees: available }) => {
      if (!cancelled) setEmployees(available ?? []);
    }).catch((e: Error) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [usesAssignmentWorkflow]);

  useEffect(() => {
    if (!form.isBudgetRequest) { setBudgetContext(null); return; }
    if (!/^\d{4}$/.test(form.fiscalYear)) return;
    let current = true;
    const timer = setTimeout(() => {
      void api<BudgetContext>('budget.context', { fiscalYear: form.fiscalYear })
        .then((context) => { if (current) setBudgetContext(context); })
        .catch((e: Error) => { if (current) setError(e.message); });
    }, budgetContext ? 300 : 0);
    return () => { current = false; clearTimeout(timer); };
  }, [form.isBudgetRequest, form.fiscalYear]);

  const set = (key: keyof FormState, value: string) => setForm((current) => ({ ...current, [key]: value }));

  async function persist(submit: boolean) {
    setSaving(true);
    setError('');
    try {
      const payload = { ...form, budgetAllocation: Number(form.budgetAllocation || 0), ...(usesAssignmentWorkflow ? { approvalAssignments: assignments } : {}) };
      const rfa = existing ? await api<Rfa>('rfa.update', { rfaId: existing.RFA_ID, ...payload }) : await api<Rfa>('rfa.create', payload);
      for (const file of files) await api('attachment.upload', { rfaId: rfa.RFA_ID, fileName: file.name, mimeType: file.type, base64: await fileToBase64(file) });
      if (submit) await api(existing?.STATUS === 'RETURNED' ? 'rfa.resubmit' : 'rfa.submit', { rfaId: rfa.RFA_ID });
      navigate(`/rfa/${rfa.RFA_ID}`, { replace: true });
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'The RFA could not be saved.'); }
    finally { setSaving(false); }
  }

  const onSubmit = (event: FormEvent) => { event.preventDefault(); void persist(true); };

  if (loading) return <Spinner label="Loading RFA" />;

  return <>
    <Link className="back-link" to={existing ? `/rfa/${existing.RFA_ID}` : '/rfas'}><ArrowLeft size={16} /> Back</Link>
    <header className="page-header">
      <div>
        <span className="eyebrow orange">{existing ? existing.RFA_NUMBER : 'NEW REQUEST'}</span>
        <h1>{existing?.STATUS === 'RETURNED' ? 'Revise and resubmit RFA' : existing ? 'Edit RFA draft' : 'Request for Approval'}</h1>
        <p>This digital form preserves the fields and approval terminology of the institutional RFA.</p>
      </div>
    </header>
    <ErrorNotice message={error} />
    <form className="rfa-form" onSubmit={onSubmit}>
      <section className="form-card">
        <div className="section-title">
          <span>01</span>
          <div><h2>Request information</h2><p>Requester information is taken from your registered Google account.</p></div>
        </div>
        <div className="form-grid identity">
          <ReadOnly label="Date Filed" value={existing?.DATE_FILED ?? new Date().toISOString().slice(0,10)} />
          <ReadOnly label="Department" value={user?.DEPARTMENT_NAME ?? ''} />
          <ReadOnly label="Requested By" value={user?.FULL_NAME ?? ''} />
          <ReadOnly label="Position" value={user?.POSITION ?? 'Not configured'} />
        </div>
        <label className="field full">
          <span>Project / Activity / Request Title <b>*</b></span>
          <input required minLength={3} maxLength={200} value={form.requestTitle} onChange={(e) => set('requestTitle', e.target.value)} placeholder="Enter a concise, recognizable title" />
        </label>
      </section>

      <section className="form-card financial-card">
        <div className="section-title"><span>03</span><div><h2>Budget / Financial Information</h2><p>Use this only when the RFA will reserve department funds after final approval.</p></div></div>
        <label className="toggle-field"><input type="checkbox" checked={form.isBudgetRequest} onChange={(e) => setForm((current) => ({ ...current, isBudgetRequest: e.target.checked }))} /> Financial request</label>
        {form.isBudgetRequest && <>
          <div className="form-grid">
            <label className="field"><span>Fiscal Year <b>*</b></span><input required pattern="\\d{4}" value={form.fiscalYear} onChange={(e) => set('fiscalYear', e.target.value)} /></label>
            <label className="field"><span>Expense Category <b>*</b></span><select required value={form.expenseCategoryId} onChange={(e) => set('expenseCategoryId', e.target.value)}><option value="">Select category</option>{budgetContext?.categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
            <label className="field"><span>Requested Amount (PHP) <b>*</b></span><input required min="0.01" step="0.01" type="number" value={form.requestedAmount} onChange={(e) => set('requestedAmount', e.target.value)} placeholder="0.00" /></label>
          </div>
          {budgetContext?.budget ? <div className="budget-context"><span>Allocated <b>{money(budgetContext.budget.allocated)}</b></span><span>Committed <b>{money(budgetContext.budget.committed)}</b></span><span>Actual Spent <b>{money(budgetContext.budget.actualSpent)}</b></span><span>Available <b>{money(budgetContext.budget.available)}</b></span><span>Projected <b>{money(budgetContext.budget.available - Number(form.requestedAmount || 0))}</b></span></div> : <p className="muted">No FY {form.fiscalYear} budget has been configured for your department. A financial RFA cannot be submitted until an administrator configures it.</p>}
        </>}
      </section>

      <section className="form-card">
        <div className="section-title">
          <span>02</span>
          <div><h2>Purpose and allocation</h2><p>Explain what is requested, why it is needed, and when it is targeted.</p></div>
        </div>
        <label className="field full">
          <span>Purpose <b>*</b></span>
          <textarea required minLength={10} rows={5} value={form.purpose} onChange={(e) => set('purpose', e.target.value)} placeholder="Describe the intended purpose and expected outcome" />
        </label>
        <div className="form-grid">
          <label className="field">
            <span>Budget Allocation (PHP) <b>*</b></span>
            <input required min="0" step="0.01" type="number" value={form.budgetAllocation} onChange={(e) => set('budgetAllocation', e.target.value)} placeholder="0.00" />
          </label>
          <label className="field">
            <span>Target Date <b>*</b></span>
            <input required type="date" value={form.targetDate} onChange={(e) => set('targetDate', e.target.value)} />
          </label>
        </div>
        <label className="field full">
          <span>Justification <b>*</b></span>
          <textarea required minLength={10} rows={7} value={form.justification} onChange={(e) => set('justification', e.target.value)} placeholder="Provide the business or institutional justification" />
        </label>
      </section>

      <section className="form-card">
        <div className="section-title">
          <span>04</span>
          <div><h2>Picture / Letter Attachment</h2><p>Files are stored privately in the configured Google Drive folder.</p></div>
        </div>
        <label className="upload-zone">
          <Paperclip />
          <b>Choose supporting files</b>
          <span>PDF, JPG, PNG, DOC, or DOCX - up to 10 MB each</span>
          <input type="file" multiple accept=".pdf,.jpg,.jpeg,.png,.doc,.docx" onChange={(e) => setFiles(Array.from(e.target.files ?? []))} />
        </label>
        {files.length > 0 && <ul className="file-list">{files.map((file) => <li key={`${file.name}-${file.size}`}>
          <FileText size={16} />
          <span>{file.name}<small>{(file.size / 1024 / 1024).toFixed(2)} MB</small></span>
        </li>)}</ul>}
      </section>

      {usesAssignmentWorkflow && <section className="form-card approval-assignment-card">
        <div className="section-title">
          <span>05</span>
          <div><h2>Approval route</h2><p>Prepared By is automatic. Select active approvers for each remaining signature stage; empty stages are skipped automatically.</p></div>
        </div>
        <div className="approval-assignment-grid">
          {sections.map((section) => <ApproverSelector key={section.key} section={section} employees={employees} selectedIds={assignments[section.key]} onChange={(ids) => setAssignments((current) => ({ ...current, [section.key]: ids }))} />)}
        </div>
      </section>}

      {!usesAssignmentWorkflow && existing && <section className="form-card approval-assignment-card legacy-route-notice">
        <div className="section-title"><span>05</span><div><h2>Legacy approval route</h2><p>This historical RFA keeps its original Approval Matrix route. Its routing configuration cannot be changed here.</p></div></div>
      </section>}

      <section className="approval-preview">
        <span className="eyebrow">APPROVAL SIGNATURES</span>
        <div>
          <b>Prepared By</b>
          <b>Recommending Approval</b>
          <b>Reviewed By</b>
          <b>Noted By</b>
          <b>Approved By</b>
        </div>
        <p>{usesAssignmentWorkflow ? 'Selected active employees are stored with this RFA. You cannot approve your own request.' : 'This historical RFA preserves its original approval route.'}</p>
      </section>

      <div className="form-actions">
        <button className="button secondary" type="button" disabled={saving} onClick={() => void persist(false)}><Save size={16} /> Save Draft</button>
        <button className="button primary" type="submit" disabled={saving}><Send size={16} /> {existing?.STATUS === 'RETURNED' ? 'Resubmit RFA' : 'Submit for Approval'}</button>
      </div>
    </form>
  </>;
}

function ApproverSelector({ section, employees, selectedIds, onChange }: { section: { key: ApprovalSection; label: string }; employees: EmployeeDirectory; selectedIds: string[]; onChange: (ids: string[]) => void }) {
  const selected = selectedIds.map((id) => employees.find((candidate) => candidate.USER_ID === id)).filter((candidate): candidate is EligibleApprover => Boolean(candidate));
  const available = employees.filter((candidate) => !selectedIds.includes(candidate.USER_ID));
  return <div className="approver-selector">
    <h3>{section.label}</h3>
    <p>{employees.length ? 'Choose zero or more active approvers. Each selection is added immediately.' : 'No active approvers are currently available.'}</p>
    <div className="approver-add">
      <select value="" onChange={(event) => { const id = event.target.value; if (id && !selectedIds.includes(id)) onChange([...selectedIds, id]); }} aria-label={`Add approver for ${section.label}`}>
        <option value="">Select person</option>
        {available.map((candidate) => <option key={candidate.USER_ID} value={candidate.USER_ID}>{candidate.FULL_NAME} — {candidate.POSITION || 'No position'} · {candidate.DEPARTMENT}</option>)}
      </select>
    </div>
    {selected.length > 0 && <ul className="selected-approvers">
      {selected.map((candidate) => <li key={candidate.USER_ID}><span><b>{candidate.FULL_NAME}</b><small>{candidate.POSITION || 'No position'} · {candidate.DEPARTMENT}</small></span><button type="button" className="icon-button" onClick={() => onChange(selectedIds.filter((id) => id !== candidate.USER_ID))} aria-label={`Remove ${candidate.FULL_NAME} from ${section.label}`}><X size={16} /></button></li>)}
    </ul>}
  </div>;
}

function ReadOnly({ label, value }: { label: string; value: string }) {
  return <div className="readonly"><span>{label}</span><b>{value || '---'}</b></div>;
}
