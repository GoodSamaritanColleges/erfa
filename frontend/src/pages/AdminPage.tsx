import { Building2, GitBranch, Pencil, Plus, Users } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { Dialog, ErrorNotice, Spinner, SuccessNotice } from '../components';
import { dateTime, money, stepLabel } from '../format';
import type { AdminData, Department, Matrix, User } from '../types';

type Tab = 'users'|'departments'|'matrix'|'logs';

type AuditRow = {
  logId: string; rfaId: string; rfaNumber: string; actorName: string; actorEmail: string; action: string;
  previousStatus: string; newStatus: string; remarks: string; timestamp: string; requester: string;
  requestingDepartment: string; requestingDepartmentId: string; involvedDepartment: string; involvedDepartmentId: string;
  approverName: string; stage: string; rfaStatus: string; expenseClassification: string; amount: number; fiscalYear: string;
};

const emptyAuditFilters = { fromDate: '', toDate: '', rfaNumber: '', requester: '', requestingDepartmentId: '', involvedDepartmentId: '', approver: '', stage: '', status: '', expenseClassification: '', minAmount: '', maxAmount: '', action: '' };

export function AdminPage() {
  const [data, setData] = useState<AdminData | null>(null);
  const [tab, setTab] = useState<Tab>('users');
  const [editing, setEditing] = useState<User|Department|Matrix|'new'|null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    void api<AdminData>('admin.data').then(setData).catch((e: Error) => setError(e.message)).finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  if (loading && !data) return <Spinner label="Loading administration" />;
  if (!data) return <ErrorNotice message={error} />;

  return <>
    <header className="page-header">
      <div>
        <span className="eyebrow orange">SYSTEM CONFIGURATION</span>
        <h1>Administration</h1>
        <p>Manage organizational data without changing application code. Historical records are preserved through soft deactivation.</p>
      </div>
    </header>
    <ErrorNotice message={error} />
    <SuccessNotice message={success} />

    <nav className="tabs">
      <button className={tab === 'users' ? 'active' : ''} onClick={() => setTab('users')}><Users /> Users</button>
      <button className={tab === 'departments' ? 'active' : ''} onClick={() => setTab('departments')}><Building2 /> Departments</button>
      <button className={tab === 'matrix' ? 'active' : ''} onClick={() => setTab('matrix')}><GitBranch /> Approval Matrix</button>
      <button className={tab === 'logs' ? 'active' : ''} onClick={() => setTab('logs')}>System Logs</button>
    </nav>

    <section className="panel flush admin-panel">
      {tab !== 'logs' && <header className="panel-header">
        <div>
          <h2>{tab === 'users' ? 'Registered users' : tab === 'departments' ? 'Departments & heads' : 'Official approval matrix'}</h2>
          <p>{tab === 'matrix' ? 'Recommending, Reviewed and Noted, and Approved By from this matrix per department. Mandatory officials: Ofelia (Reviewed and Noted), Ana and Raquel (Approved). Conditionals and threshold are set below.' : tab === 'departments' ? 'Set department heads (multiple per department allowed) and academic classification.' : 'No public registration or destructive deletion.'}</p>
        </div>
        <button className="button primary" onClick={() => setEditing('new')}><Plus size={16}/> Add {tab === 'users' ? 'User' : tab === 'departments' ? 'Department' : 'Route'}</button>
      </header>}
      {tab === 'users' && <>
        <UsersImportPanel onSaved={() => { setSuccess('Import saved.'); load(); }} onError={setError} />
        <UsersTable users={data.users} departments={data.departments} edit={setEditing} />
      </>}
      {tab === 'departments' && <>
        <DepartmentsTable departments={data.departments} users={data.users} heads={data.heads} edit={setEditing} onSaved={load} onError={setError} />
        <ApprovalSettingsPanel data={data} onSaved={() => { setSuccess('Approval settings saved.'); load(); }} onError={setError} />
      </>}
      {tab === 'matrix' && <>
        <MatrixTable matrix={data.matrix} users={data.users} departments={data.departments} edit={setEditing} />
        <ApprovalSettingsPanel data={data} onSaved={() => { setSuccess('Approval settings saved.'); load(); }} onError={setError} />
      </>}
      {tab === 'logs' && <Logs data={data} />}
    </section>

    {editing && <Dialog
      title={`${editing === 'new' ? 'Add' : 'Edit'} ${tab === 'users' ? 'user' : tab === 'departments' ? 'department' : 'approval route'}`}
      onClose={() => setEditing(null)}>
      <AdminForm tab={tab} editing={editing} data={data} onSaved={() => { setEditing(null); setSuccess('Configuration saved.'); load(); }} onError={setError} />
    </Dialog>}
  </>;
}

function UsersImportPanel({ onSaved, onError }: { onSaved: () => void; onError: (e: string) => void }) {
  const [open, setOpen] = useState(false);
  const [jsonText, setJsonText] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');
  async function runImport() {
    setBusy(true); onError(''); setResult('');
    try {
      const payload = JSON.parse(jsonText) as Record<string, unknown>;
      const res = await api<{ summary: string }>('admin.users.import', payload);
      setResult(res.summary); onSaved();
    } catch (e) { onError(e instanceof Error ? e.message : 'Import failed.'); }
    finally { setBusy(false); }
  }
  async function loadFile(file: File | undefined) {
    if (!file) return;
    const reader = new FileReader();
    reader.onerror = () => onError('Could not read the file.');
    reader.onload = () => {
      const text = String(reader.result ?? '');
      // Strip BOM that Excel/VS Code sometimes adds
      setJsonText(text.replace(/^\uFEFF/, ''));
    };
    reader.readAsText(file);
  }
  const [cleanConfirm, setCleanConfirm] = useState('');
  async function runClean() {
    setBusy(true); onError(''); setResult('');
    try {
      const res = await api<{ message: string }>('admin.data.clean', { confirm: cleanConfirm });
      setResult(res.message); onSaved(); setCleanConfirm('');
    } catch (e) { onError(e instanceof Error ? e.message : 'Clean failed.'); }
    finally { setBusy(false); }
  }
  if (!open) return <div className="form-card" style={{ marginBottom: '1rem' }}>
    <button className="button secondary" onClick={() => setOpen(true)}>Import departments / users / heads from JSON</button>{' '}
    <button className="button secondary" onClick={() => { setOpen(true); }}>Clean wrong import (keep rules)</button>
    <p className="muted">Import overwrites department + designation (Position) for existing emails. Clean keeps Admins + Approval Matrix + Settings + RFAs/audit, deletes other Users/Departments/Heads.</p>
  </div>;
  return <section className="form-card" style={{ marginBottom: '1rem' }}>
    <h3>Import from Excel payload (JSON)</h3>
    <p className="muted">Pick the file <code>erfa-import-payload.json</code> — no copy-paste needed. Entries with missing emails are skipped. Department + designation (Position) overwrite on re-import.</p>
    <label className="field"><span>Choose payload file</span><input type="file" accept=".json,application/json" onChange={(e) => void loadFile(e.target.files?.[0])} /></label>
    <label className="field"><span>Payload JSON</span><textarea rows={8} value={jsonText} onChange={(e) => setJsonText(e.target.value)} placeholder='{"departments":[],"users":[],"heads":[]}' /></label>
    <hr style={{ margin: '1rem 0' }} />
    <h3>Clean wrong import (keep rules)</h3>
    <p className="muted">Deletes all non-admin Users, all Departments and Heads. Keeps **Admins, Approval Matrix, Settings, RFAs and audit**. Type <b>DELETE</b> to confirm.</p>
    <label className="field"><span>Type DELETE to confirm</span><input value={cleanConfirm} onChange={(e) => setCleanConfirm(e.target.value)} placeholder="DELETE" /></label>
    {result && <p>{result}</p>}
    <div className="dialog-actions"><button className="button secondary" onClick={() => setOpen(false)}>Cancel</button><button className="button secondary" disabled={busy || cleanConfirm !== 'DELETE'} onClick={() => void runClean()}>Clean wrong import</button><button className="button primary" disabled={busy || !jsonText} onClick={() => void runImport()}>Run import</button></div>
  </section>;
}

function UsersTable({ users, departments, edit }: { users: User[]; departments: Department[]; edit: (item: User) => void }) {
  return <div className="table-wrap"><table>
    <thead><tr><th>Name</th><th>Department / Position</th><th>Capabilities</th><th>Status</th><th /></tr></thead>
    <tbody>{users.map((user) => <tr key={user.USER_ID}>
      <td data-label="Name"><b>{user.FULL_NAME}</b><small>{user.EMAIL}</small></td>
      <td data-label="Department">{departments.find((d) => d.DEPARTMENT_ID === user.DEPARTMENT_ID)?.DEPARTMENT_NAME || 'Not assigned'}<small>{user.POSITION}</small></td>
      <td data-label="Capabilities"><div className="chips">{user.CAN_CREATE_RFA && <span>Create</span>}{user.CAN_APPROVE_RFA && <span>Approve</span>}{user.CAN_IMPLEMENT_RFA && <span>Implement</span>}{user.IS_ADMIN && <span>Admin</span>}</div></td>
      <td data-label="Status">{user.ACTIVE ? 'Active' : 'Inactive'}</td>
      <td><button className="icon-button" onClick={() => edit(user)} aria-label={`Edit ${user.FULL_NAME}`}><Pencil/></button></td>
    </tr>)}</tbody>
  </table></div>;
}

function DepartmentsTable({ departments, users, heads, edit, onSaved, onError }: { departments: Department[]; users: User[]; heads?: { HEAD_ID: string; DEPARTMENT_ID: string; USER_ID: string; ACTIVE: boolean }[]; edit: (item: Department) => void; onSaved: () => void; onError: (e: string) => void }) {
  const [headDept, setHeadDept] = useState('');
  const [headUser, setHeadUser] = useState('');
  const headName = (id?: string) => users.find((u) => u.USER_ID === id)?.FULL_NAME || '—';
  async function addHead() {
    if (!headDept || !headUser) return;
    try { await api('admin.departmentHead.save', { departmentId: headDept, userId: headUser }); setHeadDept(''); setHeadUser(''); onSaved(); }
    catch (e) { onError(e instanceof Error ? e.message : 'Could not add head.'); }
  }
  async function removeHead(headId: string) {
    try { await api('admin.departmentHead.remove', { headId }); onSaved(); }
    catch (e) { onError(e instanceof Error ? e.message : 'Could not remove head.'); }
  }
  const headsFor = (deptId: string) => (heads || []).filter((h) => h.DEPARTMENT_ID === deptId && h.ACTIVE);
  return <>
    <div className="table-wrap"><table>
      <thead><tr><th>Code</th><th>Department</th><th>Primary Head</th><th>Heads (multi)</th><th>Academic</th><th>Status</th><th /></tr></thead>
      <tbody>{departments.map((dep) => {
        const extra = headsFor(dep.DEPARTMENT_ID).map((h) => headName(h.USER_ID));
        const allHeads = extra.length ? extra : [headName(dep.DEPARTMENT_HEAD_USER_ID)];
        return <tr key={dep.DEPARTMENT_ID}>
          <td data-label="Code"><b>{dep.DEPARTMENT_CODE}</b></td>
          <td data-label="Department">{dep.DEPARTMENT_NAME}</td>
          <td data-label="Primary Head">{headName(dep.DEPARTMENT_HEAD_USER_ID)}</td>
          <td data-label="Heads">{allHeads.join(', ')}<small onClick={() => setHeadDept(dep.DEPARTMENT_ID)} style={{ display: 'block', cursor: 'pointer' }}>Manage heads</small></td>
          <td data-label="Academic">{dep.IS_ACADEMIC ? 'Yes' : 'No'}</td>
          <td data-label="Status">{dep.ACTIVE ? 'Active' : 'Inactive'}</td>
          <td><button className="icon-button" onClick={() => edit(dep)} aria-label={`Edit ${dep.DEPARTMENT_NAME}`}><Pencil/></button></td>
        </tr>;
      })}</tbody>
    </table></div>
    {headDept && <section className="form-card" style={{ marginTop: '1rem' }}>
      <h3>Department Heads — {departments.find((d) => d.DEPARTMENT_ID === headDept)?.DEPARTMENT_NAME}</h3>
      <ul>{headsFor(headDept).map((h) => <li key={h.HEAD_ID}>{headName(h.USER_ID)} <button className="button secondary" onClick={() => void removeHead(h.HEAD_ID)}>Deactivate</button></li>)}</ul>
      <div className="form-grid">
        <label className="field"><span>Add head</span><select value={headUser} onChange={(e) => setHeadUser(e.target.value)}><option value="">Select user</option>{users.filter((u) => u.ACTIVE && u.CAN_APPROVE_RFA).map((u) => <option key={u.USER_ID} value={u.USER_ID}>{u.FULL_NAME} - {u.EMAIL}</option>)}</select></label>
        <button className="button primary" disabled={!headUser} onClick={() => void addHead()}>Add head</button>
        <button className="button secondary" onClick={() => setHeadDept('')}>Close</button>
      </div>
      <p className="muted">Departments with two heads: either head may approve Recommending Approval. Departments with one head require selecting an alternate head on the RFA.</p>
    </section>}
  </>;
}

function ApprovalSettingsPanel({ data, onSaved, onError }: { data: AdminData; onSaved: () => void; onError: (e: string) => void }) {
  const settings = data.settings ?? { presidentThresholdPhp: '50000', reviewedMandatoryUserId: '', approvedMandatoryUserIds: '', vpAcademicUserId: '', presidentUserId: '', principalUserId: '', procurementUserId: '', vpAdminFinanceEmail: 'vp.finance@example.edu', presidentEmail: 'president@example.edu' };
  const [form, setForm] = useState(settings);
  const [saving, setSaving] = useState(false);
  useEffect(() => { setForm(settings); }, [JSON.stringify(settings)]);
  const set = (key: keyof typeof form, value: string) => setForm((cur) => ({ ...cur, [key]: value }));
  async function save() {
    setSaving(true);
    try { await api('admin.settings.save', { ...form }); onSaved(); }
    catch (e) { onError(e instanceof Error ? e.message : 'Could not save settings.'); }
    finally { setSaving(false); }
  }
  const approverOptions = data.users.filter((u) => u.ACTIVE && u.CAN_APPROVE_RFA);
  const userSelect = (key: keyof typeof form, label: string) => (
    <label className="field"><span>{label}</span>
      <select value={String(form[key] ?? '')} onChange={(e) => set(key, e.target.value)}>
        <option value="">Not configured (name lookup)</option>
        {approverOptions.map((u) => <option key={u.USER_ID} value={u.USER_ID}>{u.FULL_NAME} - {u.EMAIL}</option>)}
      </select>
    </label>
  );
  const approvedIds = String(form.approvedMandatoryUserIds ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const setApprovedId = (slot: number, userId: string) => {
    const next = [...approvedIds];
    if (userId) next[slot] = userId; else next.splice(slot, 1);
    set('approvedMandatoryUserIds', next.filter(Boolean).join(','));
  };
  return <section className="form-card" style={{ marginTop: '1rem' }}>
    <h3>Official Approval Settings</h3>
    <p className="muted">Mandatory approvers remain fixed unless explicitly reconfigured here or in the Approval Matrix: Ofelia Hocson (Reviewed and Noted), Ana Liza Tago and Raquel Baquiran (Approved). Threshold is inclusive.</p>
    <div className="form-grid">
      <label className="field"><span>Presidential threshold (PHP)</span><input inputMode="decimal" value={form.presidentThresholdPhp} onChange={(e) => set('presidentThresholdPhp', e.target.value)} /></label>
      {userSelect('reviewedMandatoryUserId', 'Reviewed and Noted mandatory (Ofelia Hocson)')}
      <label className="field"><span>Approved mandatory — Ma'am Tago (Ana Liza Tago)</span><select value={approvedIds[0] ?? ''} onChange={(e) => setApprovedId(0, e.target.value)}><option value="">Not configured (name lookup)</option>{approverOptions.map((u) => <option key={u.USER_ID} value={u.USER_ID}>{u.FULL_NAME} - {u.EMAIL}</option>)}</select><small>Always together with VP Raquel below.</small></label>
      <label className="field"><span>Approved mandatory — VP Raquel (Raquel Baquiran)</span><select value={approvedIds[1] ?? ''} onChange={(e) => setApprovedId(1, e.target.value)}><option value="">Not configured (name lookup)</option>{approverOptions.map((u) => <option key={u.USER_ID} value={u.USER_ID}>{u.FULL_NAME} - {u.EMAIL}</option>)}</select><small>Always together with Ma'am Tago.</small></label>
      {userSelect('vpAcademicUserId', 'VP Academic (Jennelyn De Guzman)')}
      {userSelect('presidentUserId', 'President (Alessandra De Guzman-Valino)')}
      {userSelect('principalUserId', 'JHS/SHS Principal (Noliver Garcia)')}
      {userSelect('procurementUserId', 'Procurement Clerk (Marjorie Valdez)')}
      <label className="field"><span>Raquel Baquiran email — VP Admin and Finance (separate account)</span><input type="email" value={form.vpAdminFinanceEmail ?? 'vp.finance@example.edu'} onChange={(e) => set('vpAdminFinanceEmail', e.target.value)} /></label>
      <label className="field"><span>President email — Alessandra De Guzman-Valino (separate account)</span><input type="email" value={form.presidentEmail ?? 'president@example.edu'} onChange={(e) => set('presidentEmail', e.target.value)} /></label>
      <p className="muted">Confirmed emails are preconfigured. Do not interchange them. Other approver emails will be supplied later and remain unconfigured until set here or via Users. Procurement shows “Not configured” until Marjorie Valdez has <b>Can Approve RFA</b> enabled in Users.</p>
    </div>
    <button className="button primary" disabled={saving} onClick={() => void save()}>Save approval settings</button>
  </section>;
}

function MatrixTable({ matrix, users, departments, edit }: { matrix: Matrix[]; users: User[]; departments: Department[]; edit: (item: Matrix) => void }) {
  const rows = [...matrix].sort((a,b) => a.DEPARTMENT_ID.localeCompare(b.DEPARTMENT_ID) || a.APPROVAL_STEP.localeCompare(b.APPROVAL_STEP) || Number(a.SEQUENCE)-Number(b.SEQUENCE));
  return <div className="table-wrap"><table>
    <thead><tr><th>Department</th><th>Approval Step</th><th>Sequence</th><th>Approver</th><th>Status</th><th /></tr></thead>
    <tbody>{rows.map((row) => <tr key={row.MATRIX_ID}>
      <td data-label="Department">{departments.find((d) => d.DEPARTMENT_ID === row.DEPARTMENT_ID)?.DEPARTMENT_NAME || 'Unknown'}</td>
      <td data-label="Approval Step"><b>{stepLabel(row.APPROVAL_STEP)}</b></td>
      <td data-label="Sequence">{row.SEQUENCE}</td>
      <td data-label="Approver">{users.find((u) => u.USER_ID === row.APPROVER_USER_ID)?.FULL_NAME || 'Unknown user'}</td>
      <td data-label="Status">{row.ACTIVE ? 'Active' : 'Inactive'}</td>
      <td><button className="icon-button" onClick={() => edit(row)} aria-label="Edit route"><Pencil/></button></td>
    </tr>)}</tbody>
  </table></div>;
}

function Logs({ data }: { data: AdminData }) {
  const [auditRows, setAuditRows] = useState<AuditRow[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState('');
  const [filters, setFilters] = useState(emptyAuditFilters);
  const set = (key: keyof typeof emptyAuditFilters, value: string) => setFilters((cur) => ({ ...cur, [key]: value }));

  useEffect(() => {
    setAuditLoading(true);
    setAuditError('');
    const timer = setTimeout(() => {
      void api<{ rows: AuditRow[] }>('admin.audit', { ...filters })
        .then((result) => setAuditRows(Array.isArray(result.rows) ? result.rows : []))
        .catch((e: Error) => setAuditError(e.message))
        .finally(() => setAuditLoading(false));
    }, 300);
    return () => clearTimeout(timer);
  }, [filters]);

  const departments = data.departments;
  return <div className="logs-grid">
    <section>
      <h2>Recent Audit</h2>
      <p className="muted">Who performed an action, what happened, when it happened, and which RFA was affected.</p>
      <section className="form-card report-filters" style={{ marginBottom: '1rem' }}>
        <label className="field"><span>From date</span><input type="date" value={filters.fromDate} onChange={(e) => set('fromDate', e.target.value)} /></label>
        <label className="field"><span>To date</span><input type="date" value={filters.toDate} onChange={(e) => set('toDate', e.target.value)} /></label>
        <label className="field"><span>RFA number</span><input value={filters.rfaNumber} onChange={(e) => set('rfaNumber', e.target.value)} placeholder="RFA-2026-…" /></label>
        <label className="field"><span>Requester</span><input value={filters.requester} onChange={(e) => set('requester', e.target.value)} /></label>
        <label className="field"><span>Requesting department</span><select value={filters.requestingDepartmentId} onChange={(e) => set('requestingDepartmentId', e.target.value)}><option value="">All</option>{departments.map((d) => <option key={d.DEPARTMENT_ID} value={d.DEPARTMENT_ID}>{d.DEPARTMENT_NAME}</option>)}</select></label>
        <label className="field"><span>Involved department</span><select value={filters.involvedDepartmentId} onChange={(e) => set('involvedDepartmentId', e.target.value)}><option value="">All</option>{departments.map((d) => <option key={d.DEPARTMENT_ID} value={d.DEPARTMENT_ID}>{d.DEPARTMENT_NAME}</option>)}</select></label>
        <label className="field"><span>Approver</span><input value={filters.approver} onChange={(e) => set('approver', e.target.value)} /></label>
        <label className="field"><span>Approval stage</span><select value={filters.stage} onChange={(e) => set('stage', e.target.value)}><option value="">All stages</option>{['PREPARED_BY','RECOMMENDING_APPROVAL','REVIEWED_AND_NOTED','REVIEWED_BY','NOTED_BY','INVOLVED_DEPARTMENT_HEAD','APPROVED_BY'].map((s) => <option key={s} value={s}>{stepLabel(s)}</option>)}</select></label>
        <label className="field"><span>RFA status</span><select value={filters.status} onChange={(e) => set('status', e.target.value)}><option value="">All statuses</option>{['DRAFT','SUBMITTED','PENDING_REVIEW','PENDING_AUTHORITY_APPROVAL','PENDING_RECOMMENDING_APPROVAL','RETURNED','DISAPPROVED','APPROVED','IMPLEMENTATION','CLOSED','CANCELLED'].map((s) => <option key={s} value={s}>{s.replaceAll('_',' ')}</option>)}</select></label>
        <label className="field"><span>Expense classification</span><select value={filters.expenseClassification} onChange={(e) => set('expenseClassification', e.target.value)}><option value="">All</option><option value="OPEX">OPEX</option><option value="CAPEX">CAPEX</option></select></label>
        <label className="field"><span>Min amount</span><input inputMode="decimal" value={filters.minAmount} onChange={(e) => set('minAmount', e.target.value)} /></label>
        <label className="field"><span>Max amount</span><input inputMode="decimal" value={filters.maxAmount} onChange={(e) => set('maxAmount', e.target.value)} /></label>
        <label className="field"><span>Action</span><input value={filters.action} onChange={(e) => set('action', e.target.value)} placeholder="e.g. APPROVED" /></label>
        <button className="button secondary" type="button" onClick={() => setFilters(emptyAuditFilters)}>Clear filters</button>
      </section>
      <ErrorNotice message={auditError} />
      {auditLoading ? <Spinner label="Loading audit" /> : <div className="table-wrap"><table>
        <thead><tr><th>Timestamp</th><th>Actor</th><th>Action</th><th>RFA</th><th>Stage / Status</th><th>Details</th></tr></thead>
        <tbody>{auditRows.length ? auditRows.map((row) => <tr key={row.logId}>
          <td data-label="Timestamp">{dateTime(row.timestamp)}</td>
          <td data-label="Actor"><b>{row.actorName}</b><small>{row.actorEmail}</small></td>
          <td data-label="Action"><b>{row.action.replaceAll('_',' ')}</b><small>{row.rfaStatus || row.newStatus}</small></td>
          <td data-label="RFA"><b>{row.rfaNumber || '—'}</b><small>{row.expenseClassification ? `${row.expenseClassification} · ${money(row.amount)}` : ''}</small></td>
          <td data-label="Stage">{row.stage ? stepLabel(row.stage) : '—'}<small>{row.requestingDepartment} → {row.involvedDepartment || '—'}</small></td>
          <td data-label="Details">{row.remarks || `Requester: ${row.requester || '—'}`}</td>
        </tr>) : <tr><td colSpan={6}>No audit records match these filters.</td></tr>}
        </tbody>
      </table></div>}
      <h3 style={{ marginTop: '1.5rem' }}>Notification Delivery</h3>
      <div className="log-list">{data.notifications.slice(0,50).map((row) => <div key={row.NOTIFICATION_ID}>
        <b>{row.NOTIFICATION_TYPE} - {row.STATUS}</b>
        <span>{row.RECIPIENT_EMAIL} - {row.SENT_AT || 'Not sent'}</span>
        <p>{row.ERROR_MESSAGE}</p>
      </div>)}</div>
    </section>
  </div>;
}

function AdminForm({ tab, editing, data, onSaved, onError }: { tab: Tab; editing: User|Department|Matrix|'new'; data: AdminData; onSaved: () => void; onError: (error: string) => void }) {
  const initial = editing === 'new' ? {} : editing as unknown as Record<string, unknown>;
  const [form, setForm] = useState<Record<string, unknown>>(initial);
  const [saving, setSaving] = useState(false);
  const set = (key: string, value: unknown) => setForm((current) => ({ ...current, [key]: value }));

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    onError('');
    try {
      if (tab === 'users') await api('admin.user.save', { userId: form.USER_ID, fullName: form.FULL_NAME, email: form.EMAIL, departmentId: form.DEPARTMENT_ID, position: form.POSITION, canCreateRfa: form.CAN_CREATE_RFA ?? true, canApproveRfa: form.CAN_APPROVE_RFA ?? false, canImplementRfa: form.CAN_IMPLEMENT_RFA ?? false, isAdmin: form.IS_ADMIN ?? false, active: form.ACTIVE ?? true });
      else if (tab === 'departments') await api('admin.department.save', { departmentId: form.DEPARTMENT_ID, departmentName: form.DEPARTMENT_NAME, departmentCode: form.DEPARTMENT_CODE, departmentHeadUserId: form.DEPARTMENT_HEAD_USER_ID || '', isAcademic: form.IS_ACADEMIC ?? false, active: form.ACTIVE ?? true });
      else await api('admin.matrix.save', { matrixId: form.MATRIX_ID, departmentId: form.DEPARTMENT_ID, approvalStep: form.APPROVAL_STEP ?? 'REVIEWED_AND_NOTED', approverUserId: form.APPROVER_USER_ID, sequence: form.SEQUENCE ?? 1, required: true, active: form.ACTIVE ?? true });
      onSaved();
    } catch (caught) { onError(caught instanceof Error ? caught.message : 'Configuration could not be saved.'); }
    finally { setSaving(false); }
  }

  return <form className="dialog-body admin-form" onSubmit={(e) => void save(e)}>
    {tab === 'users' && <>
      <label className="field"><span>Full Name</span><input required value={String(form.FULL_NAME ?? '')} onChange={(e) => set('FULL_NAME',e.target.value)}/></label>
      <label className="field"><span>Email</span><input required type="email" value={String(form.EMAIL ?? '')} onChange={(e) => set('EMAIL',e.target.value)}/></label>
      <label className="field"><span>Department</span><select value={String(form.DEPARTMENT_ID ?? '')} onChange={(e) => set('DEPARTMENT_ID',e.target.value)}><option value="">Not assigned</option>{data.departments.filter((d) => d.ACTIVE).map((d) => <option key={d.DEPARTMENT_ID} value={d.DEPARTMENT_ID}>{d.DEPARTMENT_NAME}</option>)}</select></label>
      <label className="field"><span>Position</span><input value={String(form.POSITION ?? '')} onChange={(e) => set('POSITION',e.target.value)}/></label>
      <Checkbox label="Can Create RFA" checked={Boolean(form.CAN_CREATE_RFA ?? true)} set={(v) => set('CAN_CREATE_RFA',v)}/>
      <Checkbox label="Can Approve RFA" checked={Boolean(form.CAN_APPROVE_RFA)} set={(v) => set('CAN_APPROVE_RFA',v)}/>
      <Checkbox label="Can Implement RFA" checked={Boolean(form.CAN_IMPLEMENT_RFA)} set={(v) => set('CAN_IMPLEMENT_RFA',v)}/>
      <Checkbox label="Administrator" checked={Boolean(form.IS_ADMIN)} set={(v) => set('IS_ADMIN',v)}/>
      <Checkbox label="Active" checked={Boolean(form.ACTIVE ?? true)} set={(v) => set('ACTIVE',v)}/>
    </>}
    {tab === 'departments' && <>
      <label className="field"><span>Department Name</span><input required value={String(form.DEPARTMENT_NAME ?? '')} onChange={(e) => set('DEPARTMENT_NAME',e.target.value)}/></label>
      <label className="field"><span>Department Code</span><input required maxLength={20} value={String(form.DEPARTMENT_CODE ?? '')} onChange={(e) => set('DEPARTMENT_CODE',e.target.value)}/></label>
      <label className="field"><span>Primary Department Head</span><select value={String(form.DEPARTMENT_HEAD_USER_ID ?? '')} onChange={(e) => set('DEPARTMENT_HEAD_USER_ID',e.target.value)}><option value="">Not configured</option>{data.users.filter((u) => u.ACTIVE).map((u) => <option key={u.USER_ID} value={u.USER_ID}>{u.FULL_NAME} - {u.EMAIL}</option>)}</select></label>
      <Checkbox label="Academic department (VP Academic Affairs required)" checked={Boolean(form.IS_ACADEMIC ?? false)} set={(v) => set('IS_ACADEMIC',v)}/>
      <Checkbox label="Active" checked={Boolean(form.ACTIVE ?? true)} set={(v) => set('ACTIVE',v)}/>
    </>}
    {tab === 'matrix' && <>
      <label className="field"><span>Department</span><select required value={String(form.DEPARTMENT_ID ?? '')} onChange={(e) => set('DEPARTMENT_ID',e.target.value)}><option value="">Select department</option>{data.departments.filter((d) => d.ACTIVE).map((d) => <option key={d.DEPARTMENT_ID} value={d.DEPARTMENT_ID}>{d.DEPARTMENT_NAME}</option>)}</select></label>
      <label className="field"><span>Approval Step</span><select value={String(form.APPROVAL_STEP ?? 'REVIEWED_AND_NOTED')} onChange={(e) => set('APPROVAL_STEP',e.target.value)}><option value="REVIEWED_AND_NOTED">Reviewed and Noted By (mandatory Ofelia)</option><option value="APPROVED_BY">Approved By</option><option value="RECOMMENDING_APPROVAL">Recommending Approval</option><option value="REVIEWED_BY">Reviewed By (legacy V2)</option><option value="NOTED_BY">Noted By (legacy V2)</option><option value="INVOLVED_DEPARTMENT_HEAD">Involved Department Head (legacy V2)</option></select></label>
      <label className="field"><span>Sequence</span><input required min="1" type="number" value={Number(form.SEQUENCE ?? 1)} onChange={(e) => set('SEQUENCE',Number(e.target.value))}/></label>
      <label className="field"><span>Approver</span><select required value={String(form.APPROVER_USER_ID ?? '')} onChange={(e) => set('APPROVER_USER_ID',e.target.value)}><option value="">Select approver</option>{data.users.filter((u) => u.ACTIVE && u.CAN_APPROVE_RFA).map((u) => <option key={u.USER_ID} value={u.USER_ID}>{u.FULL_NAME} - {u.EMAIL}</option>)}</select></label>
      <Checkbox label="Active" checked={Boolean(form.ACTIVE ?? true)} set={(v) => set('ACTIVE',v)}/>
    </>}
    <div className="dialog-actions"><button className="button primary" disabled={saving} type="submit">Save Configuration</button></div>
  </form>;
}

function Checkbox({ label, checked, set }: { label: string; checked: boolean; set: (value: boolean) => void }) {
  return <label className="checkbox"><input type="checkbox" checked={checked} onChange={(e) => set(e.target.checked)}/><span>{label}</span></label>;
}
