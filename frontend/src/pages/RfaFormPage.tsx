import { ArrowLeft, FileText, Paperclip, Save, Send, X } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, fileToBase64 } from '../api';
import { useAuth } from '../auth';
import { ErrorNotice, Spinner } from '../components';
import { dateInputValue, displayName, fiscalYearPattern, isFiscalYear, money } from '../format';
import type { ApprovalAssignments, ApprovalSection, Department, EligibleApprover, EmployeeDirectory, Rfa, RfaDetail } from '../types';

interface FormState {
  requestTitle: string;
  purpose: string;
  budgetAllocation: string;
  targetDate: string;
  justification: string;
  fiscalYear: string;
  requestedAmount: string;
  expenseClassification: string;
  purchaseRequest: boolean;
  involvedDepartmentIds: string[];
  recommendingAlternateUserId: string;
  includePrincipal: boolean;
  includeProcurement: boolean;
}
const blank: FormState = {
  requestTitle: '', purpose: '', budgetAllocation: '', targetDate: '', justification: '',
  fiscalYear: String(new Date().getFullYear()), requestedAmount: '', expenseClassification: '',
  purchaseRequest: false, involvedDepartmentIds: [], recommendingAlternateUserId: '',
  includePrincipal: false, includeProcurement: false
};
const legacySections: Array<{ key: ApprovalSection; label: string }> = [
  { key: 'RECOMMENDING_APPROVAL', label: 'Recommending Approval' },
  { key: 'REVIEWED_BY', label: 'Reviewed By' },
  { key: 'NOTED_BY', label: 'Noted By' },
  { key: 'APPROVED_BY', label: 'Approved By' }
];
const emptyLegacyAssignments = (): ApprovalAssignments => ({ RECOMMENDING_APPROVAL: [], REVIEWED_AND_NOTED: [], REVIEWED_BY: [], NOTED_BY: [], INVOLVED_DEPARTMENT_HEAD: [], APPROVED_BY: [] } as unknown as ApprovalAssignments);
const assignmentWorkflowMarker = 'RFA_ASSIGNMENTS_V1';
const fixedV2Marker = 'RFA_FIXED_V2';

type FixedRoutePreview = {
  assignments?: Record<string, EligibleApprover[]>;
  heads?: Array<{ departmentId: string; departmentName: string; headName: string; headCount?: number; heads?: Array<{ userId: string; fullName: string }> }>;
  departments?: Department[];
  requestingHeadCount?: number;
  isAcademic?: boolean;
  isJhsOrShs?: boolean;
  presidentThresholdPhp?: number;
  alternateCandidates?: EligibleApprover[];
};

export function RfaFormPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [form, setForm] = useState<FormState>(blank);
  const [existing, setExisting] = useState<Rfa | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [employees, setEmployees] = useState<EmployeeDirectory>([]);
  const [assignments, setAssignments] = useState<ApprovalAssignments>(emptyLegacyAssignments);
  const [notedByNa, setNotedByNa] = useState(false);
  const [usesLegacyWorkflow, setUsesLegacyWorkflow] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(Boolean(id));
  const [departments, setDepartments] = useState<Department[]>([]);
  const [deptSearch, setDeptSearch] = useState('');
  const [fixedRoute, setFixedRoute] = useState<FixedRoutePreview | null>(null);

  useEffect(() => {
    if (!id) return;
    void api<RfaDetail>('rfa.detail', { rfaId: id }).then(({ rfa, permissions, approvals, notedByNotApplicable, financial }) => {
      if (!permissions.canEdit) throw new Error('This RFA is not editable.');
      setExisting(rfa);
      const requested = rfa.REQUESTED_AMOUNT ? String(rfa.REQUESTED_AMOUNT / 100) : (rfa.BUDGET_ALLOCATION ? String(rfa.BUDGET_ALLOCATION) : '');
      const involvedIds = (rfa.INVOLVED_DEPARTMENT_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (!involvedIds.length && rfa.INVOLVED_DEPARTMENT_ID) involvedIds.push(rfa.INVOLVED_DEPARTMENT_ID);
      setForm({
        requestTitle: rfa.REQUEST_TITLE, purpose: rfa.PURPOSE, budgetAllocation: String(rfa.BUDGET_ALLOCATION || ''),
        targetDate: dateInputValue(rfa.TARGET_DATE), justification: rfa.JUSTIFICATION,
        fiscalYear: rfa.FISCAL_YEAR || String(new Date().getFullYear()), requestedAmount: requested,
        expenseClassification: rfa.EXPENSE_CLASSIFICATION || '',
        purchaseRequest: Boolean(rfa.PURCHASE_REQUEST ?? financial?.purchaseRequest),
        involvedDepartmentIds: involvedIds,
        recommendingAlternateUserId: rfa.RECOMMENDING_ALTERNATE_USER_ID || '',
        includePrincipal: Boolean(rfa.INCLUDE_PRINCIPAL ?? financial?.includePrincipal),
        includeProcurement: Boolean(rfa.INCLUDE_PROCUREMENT ?? financial?.includeProcurement)
      });
      const usesLegacy = rfa.CURRENT_MATRIX_ID === assignmentWorkflowMarker;
      setUsesLegacyWorkflow(usesLegacy);
      setAssignments(usesLegacy
        ? legacySections.reduce((current, section) => ({ ...current, [section.key]: approvals.filter((row) => row.STEP === section.key && !row.ACTION).map((row) => row.APPROVER_USER_ID) }), emptyLegacyAssignments())
        : emptyLegacyAssignments());
      setNotedByNa(Boolean(notedByNotApplicable));
    }).catch((e: Error) => setError(e.message)).finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    if (usesLegacyWorkflow) {
      let cancelled = false;
      void api<{ employees: EmployeeDirectory }>('rfa.eligibleApprovers').then(({ employees: available }) => {
        if (!cancelled) setEmployees(available ?? []);
      }).catch((e: Error) => { if (!cancelled) setError(e.message); });
      return () => { cancelled = true; };
    }
    let cancelled = false;
    void api<Department[]>('rfa.departments').then((available) => { if (!cancelled) setDepartments(Array.isArray(available) ? available : []); }).catch(() => { if (!cancelled) setDepartments([]); });
    void api<FixedRoutePreview>('rfa.fixedRoute').then((preview) => { if (!cancelled) setFixedRoute(preview); }).catch(() => { if (!cancelled) setFixedRoute(null); });
    return () => { cancelled = true; };
  }, [usesLegacyWorkflow]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((current) => ({ ...current, [key]: value }));

  async function persist(submit: boolean) {
    setSaving(true);
    setError('');
    try {
      const isV2Edit = existing?.CURRENT_MATRIX_ID === fixedV2Marker;
      if (!usesLegacyWorkflow && !isV2Edit) {
        if (!form.expenseClassification) throw new Error('Expense Classification is required: select OPEX or CAPEX.');
        if (!['OPEX', 'CAPEX'].includes(form.expenseClassification)) throw new Error('Expense Classification must be OPEX or CAPEX.');
        if (!isFiscalYear(form.fiscalYear)) throw new Error('Fiscal Year must be a four-digit year.');
        if (!form.requestedAmount || Number(form.requestedAmount) <= 0) throw new Error('Requested Amount is required.');
        if (form.includePrincipal && fixedRoute && !fixedRoute.isJhsOrShs) throw new Error('The JHS/SHS Principal is only available for Junior High School or Senior High School departments.');
      }
      if (isV2Edit && !form.expenseClassification) {
        // V2 already has classification; keep it
      }
      const requestedNumber = Number(form.requestedAmount || 0);
      const payload = usesLegacyWorkflow
        ? { ...form, budgetAllocation: Number(form.budgetAllocation || 0), approvalAssignments: assignments, notedByNotApplicable: notedByNa, involvedDepartmentIds: form.involvedDepartmentIds, involvedDepartmentId: form.involvedDepartmentIds[0] || '', hasInvolvedDepartment: form.involvedDepartmentIds.length > 0 }
        : {
            requestTitle: form.requestTitle, purpose: form.purpose, budgetAllocation: requestedNumber,
            targetDate: form.targetDate, justification: form.justification,
            fiscalYear: form.fiscalYear, requestedAmount: form.requestedAmount,
            expenseClassification: form.expenseClassification || existing?.EXPENSE_CLASSIFICATION || 'OPEX',
            purchaseRequest: form.purchaseRequest,
            involvedDepartmentIds: form.involvedDepartmentIds,
            involvedDepartmentId: form.involvedDepartmentIds[0] || '',
            hasInvolvedDepartment: form.involvedDepartmentIds.length > 0,
            recommendingAlternateUserId: form.recommendingAlternateUserId,
            includePrincipal: form.includePrincipal,
            includeProcurement: form.includeProcurement,
            notedByNotApplicable: notedByNa
          };
      const rfa = existing ? await api<Rfa>('rfa.update', { rfaId: existing.RFA_ID, ...payload }) : await api<Rfa>('rfa.create', payload);
      for (const file of files) await api('attachment.upload', { rfaId: rfa.RFA_ID, fileName: file.name, mimeType: file.type, base64: await fileToBase64(file) });
      if (submit) await api(existing?.STATUS === 'RETURNED' ? 'rfa.resubmit' : 'rfa.submit', { rfaId: rfa.RFA_ID });
      navigate(`/rfa/${rfa.RFA_ID}`, { replace: true });
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'The RFA could not be saved.'); }
    finally { setSaving(false); }
  }

  const onSubmit = (event: FormEvent) => { event.preventDefault(); void persist(true); };

  if (loading) return <Spinner label="Loading RFA" />;

  const requestingDeptId = (user as unknown as { DEPARTMENT_ID?: string } | undefined)?.DEPARTMENT_ID;
  const dedupedDepartments = (() => {
    const seen = new Map<string, Department>();
    for (const d of departments) {
      const key = d.DEPARTMENT_NAME.trim().toLowerCase();
      if (!seen.has(key)) seen.set(key, d);
    }
    return Array.from(seen.values()).sort((a, b) => a.DEPARTMENT_NAME.localeCompare(b.DEPARTMENT_NAME));
  })();
  const involvedChoices = dedupedDepartments.filter((d) => d.DEPARTMENT_ID !== requestingDeptId);
  const filteredInvolved = deptSearch
    ? involvedChoices.filter((d) => d.DEPARTMENT_NAME.toLowerCase().includes(deptSearch.toLowerCase()))
    : involvedChoices;
  const headForDept = (deptId: string) => (fixedRoute?.heads ?? []).find((h) => h.departmentId === deptId)?.headName || '';
  const amount = Number(form.requestedAmount || 0);
  const threshold = fixedRoute?.presidentThresholdPhp ?? 50000;
  const needsPresident = amount >= threshold && amount > 0;
  const isAcademic = Boolean(fixedRoute?.isAcademic);
  const isJhsOrShs = Boolean(fixedRoute?.isJhsOrShs);
  const headCount = fixedRoute?.requestingHeadCount ?? 0;

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
          <ReadOnly label="Requesting Department" value={user?.DEPARTMENT_NAME ?? ''} />
          <ReadOnly label="Requested By" value={user?.FULL_NAME ?? ''} />
          <ReadOnly label="Position" value={user?.POSITION ?? 'Not configured'} />
        </div>
        <label className="field full">
          <span>Project / Activity / Request Title <b>*</b></span>
          <input required minLength={3} maxLength={200} value={form.requestTitle} onChange={(e) => set('requestTitle', e.target.value)} placeholder="Enter a concise, recognizable title" />
        </label>
      </section>

      <section className="form-card">
        <div className="section-title"><span>02</span><div><h2>Expense information</h2><p>Classify the requested expense. No department budget balance is required to submit.</p></div></div>
        <div className="form-grid">
          <label className="field"><span>Fiscal Year <b>*</b></span><input required inputMode="numeric" maxLength={4} pattern={fiscalYearPattern} title="Enter a four-digit fiscal year, for example 2026." value={form.fiscalYear} onChange={(e) => set('fiscalYear', e.target.value)} /></label>
          <label className="field"><span>Requested Amount (PHP) <b>*</b></span><input required min="0.01" step="0.01" type="number" value={form.requestedAmount} onChange={(e) => set('requestedAmount', e.target.value)} placeholder="0.00" /></label>
          <label className="field"><span>Expense Classification <b>*</b></span>
            <select required value={form.expenseClassification} onChange={(e) => set('expenseClassification', e.target.value)}>
              <option value="">Select classification</option>
              <option value="OPEX">OPEX — Operating Expenditure</option>
              <option value="CAPEX">CAPEX — Capital Expenditure</option>
            </select>
          </label>
        </div>
        <p className="muted">Amounts are monitored by department as Total OPEX + Total CAPEX. Presidential approval is {needsPresident ? 'required' : 'not required'} at {money(threshold)} threshold (amount: {money(amount || 0)}).</p>
        {isAcademic && <p className="muted">Academic department: VP for Academic Affairs is automatically included in Approved By.</p>}
      </section>

      <section className="form-card">
        <div className="section-title">
          <span>03</span>
          <div><h2>Purpose and justification</h2><p>Explain what is requested, why it is needed, and when it is targeted.</p></div>
        </div>
        <label className="field full">
          <span>Purpose <b>*</b></span>
          <textarea required minLength={10} rows={5} value={form.purpose} onChange={(e) => set('purpose', e.target.value)} placeholder="Describe the intended purpose and expected outcome" />
        </label>
        <div className="form-grid">
          {usesLegacyWorkflow && <label className="field">
            <span>Budget Allocation (PHP) <b>*</b></span>
            <input required min="0" step="0.01" type="number" value={form.budgetAllocation} onChange={(e) => set('budgetAllocation', e.target.value)} placeholder="0.00" />
          </label>}
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
          <div><h2>Approval options</h2><p>Select applicable optional approvers and involved departments. Mandatory approvers cannot be removed.</p></div>
        </div>
        {!usesLegacyWorkflow ? <>
          <p className="muted">Your department head{headCount >= 2 ? `s (${headCount})` : ''} will be your Recommending Approver{headCount === 0 ? ' — pending configuration' : ''}.</p>
          {isJhsOrShs && <label className="toggle-field"><input type="checkbox" checked={form.includePrincipal} onChange={(e) => set('includePrincipal', e.target.checked)} /> Include JHS/SHS Principal (Noliver Garcia) in Reviewed and Noted By</label>}
          <div className="involved-picker">
            <div className="involved-header">
              <b>Involved Department(s)</b>
              <span>{form.involvedDepartmentIds.length} selected — their heads join Reviewed and Noted By</span>
            </div>
            <input className="dept-search" placeholder="Search departments…" value={deptSearch} onChange={(e) => setDeptSearch(e.target.value)} />
            <div className="dept-grid">
              {filteredInvolved.map((d) => {
                const checked = form.involvedDepartmentIds.includes(d.DEPARTMENT_ID);
                const head = headForDept(d.DEPARTMENT_ID);
                return <label key={d.DEPARTMENT_ID} className={checked ? 'dept-option selected' : 'dept-option'}>
                  <input type="checkbox" checked={checked} onChange={(e) => { set('involvedDepartmentIds', e.target.checked ? [...form.involvedDepartmentIds, d.DEPARTMENT_ID] : form.involvedDepartmentIds.filter((x) => x !== d.DEPARTMENT_ID)); }} />
                  <span className="dept-text"><b>{displayName(d.DEPARTMENT_NAME)}</b>{head ? <small>{displayName(head)}</small> : null}</span>
                </label>;
              })}
              {filteredInvolved.length === 0 && <p className="muted">No departments match your search.</p>}
            </div>
          </div>
        </> : <p className="muted">This historical RFA does not use optional approver selections.</p>}
      </section>

      <section className="form-card">
        <div className="section-title">
          <span>05</span>
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

      {!usesLegacyWorkflow && <section className="form-card approval-assignment-card">
        <div className="section-title">
          <span>06</span>
          <div><h2>Approval route — official matrix</h2><p>Assigned automatically. Mandatory approvers cannot be removed.</p></div>
        </div>
        <div className="route-names">
          <RouteStage title="Prepared By" names={[existing?.REQUESTED_BY || user?.FULL_NAME || 'Requester']} note={existing?.POSITION || user?.POSITION || ''} />
          <RouteStage title="Recommending Approval" names={(fixedRoute?.assignments?.RECOMMENDING_APPROVAL ?? []).map((p) => p.FULL_NAME)} />
          <RouteStage title="Reviewed and Noted By" names={(fixedRoute?.assignments?.REVIEWED_AND_NOTED ?? []).map((p) => p.FULL_NAME)} />
          <RouteStage title="Approved By" names={(fixedRoute?.assignments?.APPROVED_BY ?? []).map((p) => p.FULL_NAME)} />
        </div>
        <p className="muted">{isAcademic ? 'Academic: VP Academic required. ' : ''}{needsPresident ? `President required (≥ ${money(threshold)}). ` : 'President not required below threshold. '}{fixedRoute ? '' : 'Loading route…'}</p>
      </section>}

      {usesLegacyWorkflow && <section className="form-card approval-assignment-card">
        <div className="section-title">
          <span>06</span>
          <div><h2>Approval route</h2><p>Prepared By is automatic. Select active approvers for each remaining signature stage; empty stages are skipped automatically.</p></div>
        </div>
        <div className="approval-assignment-grid">
          {legacySections.map((section) => <div key={section.key}>
            {section.key === 'NOTED_BY' && <label className="toggle-field"><input type="checkbox" checked={notedByNa} onChange={(event) => { setNotedByNa(event.target.checked); if (event.target.checked) setAssignments((current) => ({ ...current, NOTED_BY: [] })); }} /> Not Applicable (N/A) — skip Noted By</label>}
            {section.key === 'NOTED_BY' && notedByNa ? <p className="muted">Noted By: N/A. No approver or email will be assigned for this stage.</p> : <ApproverSelector section={section} employees={employees} selectedIds={assignments[section.key] ?? []} onChange={(ids) => setAssignments((current) => ({ ...current, [section.key]: ids }))} />}
          </div>)}
        </div>
      </section>}

      {usesLegacyWorkflow && <section className="approval-preview">
        <span className="eyebrow">APPROVAL SIGNATURES</span>
        <div className="route-names">
          <div className="route-stage"><b>Prepared By</b><small>{existing?.REQUESTED_BY || user?.FULL_NAME || 'Requester'}</small></div>
          <div className="route-stage"><b>Recommending Approval</b><small>Legacy</small></div>
          <div className="route-stage"><b>Reviewed and Noted By</b><small>Legacy</small></div>
          <div className="route-stage"><b>Approved By</b><small>Legacy</small></div>
        </div>
        <p>This historical RFA preserves its original approval route.</p>
      </section>}

      <div className="form-actions">
        <button className="button secondary" type="button" disabled={saving} onClick={() => void persist(false)}><Save size={16} /> Save Draft</button>
        <button className="button primary" type="submit" disabled={saving}><Send size={16} /> {existing?.STATUS === 'RETURNED' ? 'Resubmit RFA' : 'Submit for Approval'}</button>
      </div>
    </form>
  </>;
}

function RouteStage({ title, names, note }: { title: string; names: string[]; note?: string }) {
  return <div className="route-stage">
    <b>{title}</b>
    {names.length ? <ul>{names.map((name, i) => <li key={`${name}-${i}`}>{displayName(name)}</li>)}</ul> : <small>Pending configuration</small>}
    {note ? <span>{note}</span> : null}
  </div>;
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
