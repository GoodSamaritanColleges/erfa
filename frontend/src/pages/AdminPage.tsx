import { Building2, GitBranch, Pencil, Plus, Users } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { Dialog, ErrorNotice, Spinner, SuccessNotice } from '../components';
import { date, dateTime, money, stepLabel } from '../format';
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
  const [params] = useSearchParams();
  const [tab, setTab] = useState<Tab>((params.get('tab') as Tab) || 'users');
  const handOverFrom = params.get('handover') || '';
  const handOverRfa = params.get('rfa') || '';
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
      <button className={tab === 'matrix' ? 'Optional: extra approvers for one specific department. Most schools need none here: department heads (Departments tab) and Approval Roles (below) already cover every RFA.' : ''} onClick={() => setTab('matrix')}><GitBranch /> Approval Matrix</button>
      <button className={tab === 'logs' ? 'active' : ''} onClick={() => setTab('logs')}>System Logs</button>
    </nav>

    <section className="panel flush admin-panel">
      {tab !== 'logs' && <header className="panel-header">
        <div>
          <h2>{tab === 'users' ? 'Registered users' : tab === 'departments' ? 'Departments & heads' : 'Official approval matrix'}</h2>
          <p>{tab === 'matrix' ? 'Department-specific approvers. The official roles (Reviewed and Noted By, Approved By, VPs, President, Principal) are assigned once in Official Approval Roles below and apply to every department.' : tab === 'departments' ? 'Set department heads (multiple per department allowed) and academic classification.' : 'No public registration or destructive deletion.'}</p>
        </div>
        <button className="button primary" onClick={() => setEditing('new')}><Plus size={16}/> Add {tab === 'users' ? 'User' : tab === 'departments' ? 'Department' : 'Route'}</button>
      </header>}
      {tab === 'users' && <>
        <UsersImportPanel onSaved={() => { setSuccess('Import saved.'); load(); }} onError={setError} />
        <HandOverPanel key={`${handOverFrom}-${handOverRfa}`} users={data.users} initialFrom={handOverFrom} initialRfaId={handOverRfa} onDone={(message) => { setSuccess(message); load(); }} onError={setError} />
        <UsersTable users={data.users} departments={data.departments} edit={setEditing} />
      </>}
      {tab === 'departments' && <>
        <DepartmentsTable departments={data.departments} users={data.users} heads={data.heads} edit={setEditing} onSaved={load} onError={setError} />
        <ApprovalSettingsPanel data={data} onSaved={() => { setSuccess('Approval settings saved.'); load(); }} onError={setError} />
      </>}
      {tab === 'matrix' && <>
        <MatrixTable matrix={data.matrix} users={data.users} departments={data.departments} edit={setEditing} onChanged={(message) => { setSuccess(message); load(); }} onError={setError} />
        <ApprovalSettingsPanel data={data} onSaved={() => { setSuccess('Approval settings saved.'); load(); }} onError={setError} />
      </>}
      {tab === 'logs' && <><MaintenancePanel /><Logs data={data} /></>}
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


type HandOverResult = { preview: boolean; count: number; moved: Array<{ rfaId: string; rfaNumber: string; title: string; steps: string[] }>; skipped: Array<{ rfaNumber: string; reason: string }> };

/** Hand pending approvals from someone who is away or has left to another approver. */
function HandOverPanel({ users, initialFrom, initialRfaId, onDone, onError }: { users: User[]; initialFrom: string; initialRfaId: string; onDone: (message: string) => void; onError: (e: string) => void }) {
  const [fromUserId, setFrom] = useState(initialFrom);
  const [toUserId, setTo] = useState('');
  const [reason, setReason] = useState('');
  const [rfaId, setRfaId] = useState(initialRfaId);
  const [preview, setPreview] = useState<HandOverResult | null>(null);
  const [working, setWorking] = useState(false);
  useEffect(() => { setPreview(null); }, [fromUserId, rfaId]);
  const everyone = users.map((u) => ({ value: u.USER_ID, label: `${u.FULL_NAME} - ${u.EMAIL}${u.ACTIVE ? '' : ' (inactive)'}` }));
  const approvers = users.filter((u) => u.ACTIVE && u.CAN_APPROVE_RFA && u.USER_ID !== fromUserId).map((u) => ({ value: u.USER_ID, label: `${u.FULL_NAME} - ${u.EMAIL}` }));
  async function run(previewOnly: boolean) {
    setWorking(true);
    try {
      const result = await api<HandOverResult>('admin.approvals.reassign', { fromUserId, toUserId, reason, rfaId, preview: previewOnly });
      if (previewOnly) setPreview(result);
      else { setPreview(null); setReason(''); onDone(`Handed over ${result.count} RFA${result.count === 1 ? '' : 's'}${result.skipped.length ? `; ${result.skipped.length} skipped` : ''}. The new approver was emailed where it is their turn.`); }
    } catch (e) { onError(e instanceof Error ? e.message : 'Could not hand over approvals.'); }
    finally { setWorking(false); }
  }
  return <section className="form-card handover-panel">
    <h3>Hand over pending approvals</h3>
    <p className="muted">When an approver is on leave or has left, move the RFAs waiting on them to someone else. Approvals already given are never changed, and every hand-over is recorded in the audit log.</p>
    <div className="form-grid">
      <label className="field"><span>From (away or left)</span><SearchableSelect value={fromUserId} options={everyone} placeholder="Search name or email…" onChange={setFrom} /></label>
      <label className="field"><span>To (takes over)</span><SearchableSelect value={toUserId} options={approvers} placeholder="Search name or email…" onChange={setTo} /></label>
      <label className="field full"><span>Reason</span><input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. On leave until June 30" /></label>
    </div>
    {rfaId && <p className="muted">Only for one RFA (opened from its page). <button type="button" className="link-button" onClick={() => setRfaId('')}>Hand over all of this person's waiting RFAs instead</button></p>}
    {preview && <div className="handover-preview">
      <b>{preview.count ? `${preview.count} waiting RFA${preview.count === 1 ? '' : 's'} will move:` : 'This person has no waiting RFAs to hand over.'}</b>
      {preview.moved.length > 0 && <ul>{preview.moved.map((item) => <li key={item.rfaId}>{item.rfaNumber || 'Draft'} · {item.title || 'Untitled'} <small>({item.steps.map(stepLabel).join(', ')})</small></li>)}</ul>}
      {preview.skipped.length > 0 && <p className="muted">{preview.skipped.length} will be skipped: {preview.skipped.map((s) => `${s.rfaNumber} (${s.reason})`).join('; ')}</p>}
    </div>}
    <div className="form-actions">
      <button type="button" className="button secondary" disabled={!fromUserId || working} onClick={() => void run(true)}>Show waiting RFAs</button>
      <button type="button" className="button primary" disabled={!fromUserId || !toUserId || reason.trim().length < 3 || working || (preview !== null && preview.count === 0)} onClick={() => void run(false)}>{working ? 'Working…' : 'Hand over'}</button>
    </div>
  </section>;
}

type MaintenanceStatus = {
  enabled: boolean; lastBackupAt: string; lastArchiveAt: string; backupOverdue: boolean;
  nextBackup: string; nextArchive: string; visibleFrom: string; visibleYears: number;
  backups: Array<{ date: string; name: string; url: string; reason: string }>;
  followUpsScheduled?: boolean; lastFollowUpsAt?: string; remindersEnabled?: boolean; reminderDays?: number; failedEmails?: number;
};

/** Automatic backups and yearly archive: whether they are on, recent backups, and what runs next. */
function MaintenancePanel() {
  const [status, setStatus] = useState<MaintenanceStatus | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    api<MaintenanceStatus>('admin.maintenance.status').then((next) => { if (alive) setStatus(next); }).catch((e: Error) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, []);
  if (error) return <ErrorNotice message={error} />;
  if (!status) return <Spinner label="Loading maintenance status" />;
  const day = (value: string) => (value ? date(value) : '—');
  return <section className="form-card maintenance-panel">
    <div className="maintenance-head">
      <div><h3>Automatic maintenance</h3><p className="muted">Monthly backups are kept forever in Drive (eRFA Backups, one folder per year). Each June the finished RFAs of the year that ended are archived. The app shows {status.visibleFrom} onward; older years stay safe in their archives and backups.</p></div>
      <span className={`maintenance-state ${status.enabled ? 'on' : 'off'}`}>{status.enabled ? 'On' : 'Off'}</span>
    </div>
    {!status.enabled && <div className="notice error" role="alert">Automatic maintenance is not switched on yet. The script owner runs <b>installAutomaticMaintenance</b> once in the Apps Script editor.</div>}
    {status.enabled && status.backupOverdue && <div className="notice error" role="alert">No backup in the last 35 days. Check the Apps Script owner's access and Drive storage, or run <b>backupNow</b> in the editor.</div>}
    <div className="maintenance-facts">
      <div><span>Last backup</span><b>{day(status.lastBackupAt)}</b></div>
      <div><span>Next backup</span><b>{day(status.nextBackup)}</b></div>
      <div><span>Next yearly archive</span><b>{day(status.nextArchive)}</b></div>
      <div><span>Last archive</span><b>{day(status.lastArchiveAt)}</b></div>
    </div>
    <div className="maintenance-facts">
      <div><span>Daily follow-ups (7 AM)</span><b>{status.followUpsScheduled ? 'On' : 'Off'}</b></div>
      <div><span>Approver reminders</span><b>{status.remindersEnabled === false ? 'Off' : `After ${status.reminderDays ?? 3} days`}</b></div>
      <div><span>Last follow-up run</span><b>{day(status.lastFollowUpsAt ?? '')}</b></div>
      <div><span>Failed emails to retry</span><b>{status.failedEmails ?? 0}</b></div>
    </div>
    {status.backups.length > 0 && <div className="table-wrap"><table>
      <thead><tr><th>Backup</th><th>Saved</th><th>Type</th><th aria-label="Open" /></tr></thead>
      <tbody>{status.backups.map((backup) => <tr key={backup.date + backup.name}>
        <td data-label="Backup">{backup.name}</td>
        <td data-label="Saved">{dateTime(backup.date)}</td>
        <td data-label="Type">{backup.reason === 'Monthly' ? 'Monthly' : `Extra (${backup.reason})`}</td>
        <td>{backup.url ? <a className="row-link" href={backup.url} target="_blank" rel="noreferrer">Open in Drive</a> : '—'}</td>
      </tr>)}</tbody>
    </table></div>}
  </section>;
}

type RoleRow = { ROLE_ID: string; TITLE: string; STAGE: 'REVIEWED_AND_NOTED' | 'APPROVED_BY'; CONDITION: 'ALWAYS' | 'ACADEMIC' | 'AT_OR_ABOVE_THRESHOLD' | 'JHS_SHS_OPTIONAL'; EMAIL_ORDER: number; ALL_RFAS_ACCESS: boolean; USER_ID: string; ACTIVE: boolean };
const STAGE_LABELS: Record<RoleRow['STAGE'], string> = { REVIEWED_AND_NOTED: 'Reviewed and Noted By', APPROVED_BY: 'Approved By' };
const CONDITION_LABELS: Record<RoleRow['CONDITION'], string> = { ALWAYS: 'Every RFA', ACADEMIC: 'Academic departments only', AT_OR_ABOVE_THRESHOLD: 'Amount ≥ threshold', JHS_SHS_OPTIONAL: 'JHS/SHS, when requested' };
const ORDER_LABELS = ['Emailed first', 'Emailed in the middle', 'Emailed last'];

/**
 * Approval roles: each row is a role with its title, the person who holds it, its stage, when it
 * applies, its Approved By email order and whether it opens All RFAs. Add, rename or switch off roles here.
 */
function ApprovalSettingsPanel({ data, onSaved, onError }: { data: AdminData; onSaved: () => void; onError: (e: string) => void }) {
  const initialRoles = (data.roles ?? []) as RoleRow[];
  const [roles, setRoles] = useState<RoleRow[]>(initialRoles);
  const [threshold, setThreshold] = useState(data.settings?.presidentThresholdPhp ?? '50000');
  const [saving, setSaving] = useState(false);
  useEffect(() => { setRoles((data.roles ?? []) as RoleRow[]); setThreshold(data.settings?.presidentThresholdPhp ?? '50000'); }, [JSON.stringify(data.roles), data.settings?.presidentThresholdPhp]);
  const options = data.users.filter((u) => u.ACTIVE && u.CAN_APPROVE_RFA).map((u) => ({ value: u.USER_ID, label: `${u.FULL_NAME} - ${u.EMAIL}` }));
  const update = (index: number, patch: Partial<RoleRow>) => setRoles((cur) => cur.map((role, i) => (i === index ? { ...role, ...patch } : role)));
  const move = (index: number, delta: number) => setRoles((cur) => {
    const next = [...cur]; const target = index + delta;
    if (target < 0 || target >= next.length) return cur;
    [next[index], next[target]] = [next[target], next[index]];
    return next;
  });
  const addRole = () => setRoles((cur) => [...cur, { ROLE_ID: '', TITLE: '', STAGE: 'APPROVED_BY', CONDITION: 'ALWAYS', EMAIL_ORDER: 1, ALL_RFAS_ACCESS: true, USER_ID: '', ACTIVE: true }]);
  async function save() {
    setSaving(true);
    try {
      await api('admin.settings.save', { presidentThresholdPhp: threshold });
      await api('admin.roles.save', { roles });
      onSaved();
    } catch (e) { onError(e instanceof Error ? e.message : 'Could not save approval roles.'); }
    finally { setSaving(false); }
  }
  return <section className="form-card" style={{ marginTop: '1rem' }}>
    <h3>Approval Roles</h3>
    <p className="muted">Each role keeps its job; change the person, rename it, or add and switch off roles. Routing, the Approved By email order and All RFAs access follow these rows. A department's own matrix entries for Reviewed and Noted By take precedence over the "Every RFA" Reviewed roles.</p>
    <label className="field role-field" style={{ maxWidth: 320 }}><span>Presidential threshold (PHP)</span><input inputMode="decimal" value={threshold} onChange={(e) => setThreshold(e.target.value)} /><small>Roles set to "Amount ≥ threshold" apply from this amount.</small></label>
    <div className="roles-list">
      {roles.map((role, index) => <div key={role.ROLE_ID || `new-${index}`} className={`role-card${role.ACTIVE ? '' : ' inactive'}`}>
        <div className="role-card-head">
          <input className="role-title" aria-label="Role title" placeholder="Role title, e.g. Finance Director" value={role.TITLE} onChange={(e) => update(index, { TITLE: e.target.value })} />
          <div className="role-card-tools">
            <button type="button" className="icon-button" aria-label="Move up" disabled={index === 0} onClick={() => move(index, -1)}>↑</button>
            <button type="button" className="icon-button" aria-label="Move down" disabled={index === roles.length - 1} onClick={() => move(index, 1)}>↓</button>
            <label className="checkbox"><input type="checkbox" checked={role.ACTIVE} onChange={(e) => update(index, { ACTIVE: e.target.checked })} /> Active</label>
          </div>
        </div>
        <div className="role-card-grid">
          <label className="field"><span>Person</span><SearchableSelect value={role.USER_ID} options={options} placeholder="Search name or email…" onChange={(v) => update(index, { USER_ID: v })} /></label>
          <label className="field"><span>Stage</span><select value={role.STAGE} onChange={(e) => update(index, { STAGE: e.target.value as RoleRow['STAGE'], ...(e.target.value === 'APPROVED_BY' && role.CONDITION === 'JHS_SHS_OPTIONAL' ? { CONDITION: 'ALWAYS' as const } : {}) })}>{(Object.keys(STAGE_LABELS) as RoleRow['STAGE'][]).map((stage) => <option key={stage} value={stage}>{STAGE_LABELS[stage]}</option>)}</select></label>
          <label className="field"><span>Applies to</span><select value={role.CONDITION} onChange={(e) => update(index, { CONDITION: e.target.value as RoleRow['CONDITION'] })}>{(Object.keys(CONDITION_LABELS) as RoleRow['CONDITION'][]).filter((c) => c !== 'JHS_SHS_OPTIONAL' || role.STAGE === 'REVIEWED_AND_NOTED').map((c) => <option key={c} value={c}>{CONDITION_LABELS[c]}</option>)}</select></label>
          {role.STAGE === 'APPROVED_BY' && <label className="field"><span>Email order</span><select value={role.EMAIL_ORDER} onChange={(e) => update(index, { EMAIL_ORDER: Number(e.target.value) })}>{ORDER_LABELS.map((label, order) => <option key={order} value={order}>{label}</option>)}</select></label>}
          <label className="checkbox role-access"><input type="checkbox" checked={role.ALL_RFAS_ACCESS} onChange={(e) => update(index, { ALL_RFAS_ACCESS: e.target.checked })} /> Can see All RFAs</label>
        </div>
      </div>)}
    </div>
    <div className="roles-actions">
      <button type="button" className="button secondary" onClick={addRole}><Plus size={16} /> Add role</button>
      <button type="button" className="button primary" disabled={saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save approval roles'}</button>
    </div>
    <p className="muted">One person cannot hold two Approved By roles. Switching a role off keeps its history. Procurement is view-only by department (PPU).</p>
  </section>;
}

/**
 * Department-specific extra approvers. Leftover rows (department or person deleted) and switched-off
 * rows never route anything, so they are hidden behind a toggle and can be switched off in one click.
 */
function MatrixTable({ matrix, users, departments, edit, onChanged, onError }: { matrix: Matrix[]; users: User[]; departments: Department[]; edit: (item: Matrix) => void; onChanged: (message: string) => void; onError: (e: string) => void }) {
  const [showAll, setShowAll] = useState(false);
  const [working, setWorking] = useState(false);
  const departmentName = (id: string) => departments.find((d) => d.DEPARTMENT_ID === id)?.DEPARTMENT_NAME;
  const userName = (id: string) => users.find((u) => u.USER_ID === id)?.FULL_NAME;
  const isLeftover = (row: Matrix) => !departmentName(row.DEPARTMENT_ID) || !userName(row.APPROVER_USER_ID);
  const sorted = [...matrix].sort((a, b) => (departmentName(a.DEPARTMENT_ID) || '~').localeCompare(departmentName(b.DEPARTMENT_ID) || '~') || a.APPROVAL_STEP.localeCompare(b.APPROVAL_STEP) || Number(a.SEQUENCE) - Number(b.SEQUENCE));
  const workingRows = sorted.filter((row) => row.ACTIVE && !isLeftover(row));
  const activeLeftovers = sorted.filter((row) => row.ACTIVE && isLeftover(row));
  const rows = showAll ? sorted : workingRows;
  async function turnOffLeftovers() {
    setWorking(true);
    try {
      const result = await api<{ turnedOff: number }>('admin.matrix.cleanup');
      onChanged(`Turned off ${result.turnedOff} leftover row${result.turnedOff === 1 ? '' : 's'}. They are kept for history.`);
    } catch (e) { onError(e instanceof Error ? e.message : 'Could not turn off leftover rows.'); }
    finally { setWorking(false); }
  }
  return <>
    {activeLeftovers.length > 0 && <div className="notice matrix-leftovers" role="status">
      <span>{activeLeftovers.length} leftover row{activeLeftovers.length === 1 ? '' : 's'} point to a deleted department or person and never route anything.</span>
      <button type="button" className="button secondary" disabled={working} onClick={() => void turnOffLeftovers()}>{working ? 'Turning off…' : 'Turn off leftovers'}</button>
    </div>}
    {rows.length === 0
      ? <div className="empty"><h3>No department-specific approvers</h3><p>That is normal. Department heads (Departments tab) and Approval Roles (below) cover every RFA. Add a route only when one department needs an extra approver.</p></div>
      : <div className="table-wrap"><table>
        <thead><tr><th>Department</th><th>Approval Step</th><th>Sequence</th><th>Approver</th><th>Status</th><th /></tr></thead>
        <tbody>{rows.map((row) => <tr key={row.MATRIX_ID} className={isLeftover(row) || !row.ACTIVE ? 'matrix-off' : ''}>
          <td data-label="Department">{departmentName(row.DEPARTMENT_ID) || <span className="history-muted">Department deleted</span>}</td>
          <td data-label="Approval Step"><b>{stepLabel(row.APPROVAL_STEP)}</b></td>
          <td data-label="Sequence">{row.SEQUENCE}</td>
          <td data-label="Approver">{userName(row.APPROVER_USER_ID) || <span className="history-muted">Person deleted</span>}</td>
          <td data-label="Status">{isLeftover(row) ? 'Leftover' : row.ACTIVE ? 'Active' : 'Off'}</td>
          <td><button className="icon-button" onClick={() => edit(row)} aria-label="Edit route"><Pencil/></button></td>
        </tr>)}</tbody>
      </table></div>}
    {sorted.length > workingRows.length && <p className="muted matrix-toggle"><button type="button" className="link-button" onClick={() => setShowAll((v) => !v)}>{showAll ? 'Show only working rows' : `Show ${sorted.length - workingRows.length} switched-off or leftover row${sorted.length - workingRows.length === 1 ? '' : 's'}`}</button></p>}
  </>;
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
      <label className="field"><span>Approval Step</span><select value={String(form.APPROVAL_STEP ?? 'REVIEWED_AND_NOTED')} onChange={(e) => set('APPROVAL_STEP',e.target.value)}><option value="REVIEWED_AND_NOTED">Reviewed and Noted By</option><option value="APPROVED_BY">Approved By</option><option value="RECOMMENDING_APPROVAL">Recommending Approval</option><option value="REVIEWED_BY">Reviewed By (legacy V2)</option><option value="NOTED_BY">Noted By (legacy V2)</option><option value="INVOLVED_DEPARTMENT_HEAD">Involved Department Head (legacy V2)</option></select></label>
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

function SearchableSelect({ value, options, placeholder, onChange }: { value: string; options: Array<{ value: string; label: string }>; placeholder: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const selectedLabel = options.find((o) => o.value === value)?.label || '';
  const filtered = query.trim() === ''
    ? options
    : options.filter((o) => o.label.toLowerCase().includes(query.trim().toLowerCase()));
  const shown = filtered.slice(0, 80);
  return <div className="searchable">
    <input
      className="searchable-input"
      placeholder={selectedLabel || placeholder}
      value={open ? query : selectedLabel}
      onFocus={() => { setOpen(true); setQuery(''); setHighlight(0); }}
      onChange={(e) => { setQuery(e.target.value); setOpen(true); setHighlight(0); }}
      onBlur={() => { setTimeout(() => setOpen(false), 120); }}
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight((h) => Math.min(h + 1, shown.length - 1)); }
        if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight((h) => Math.max(h - 1, 0)); }
        if (e.key === 'Enter' && shown[highlight]) { e.preventDefault(); onChange(shown[highlight].value); setOpen(false); setQuery(''); }
      }}
    />
    {open && <ul className="searchable-list">
      <li className={value === '' ? 'active' : ''} onMouseDown={(e) => { e.preventDefault(); onChange(''); setOpen(false); setQuery(''); }}>Not configured (name lookup)</li>
      {shown.map((o, i) => <li key={o.value} className={o.value === value || i === highlight ? 'active' : ''} onMouseDown={(e) => { e.preventDefault(); onChange(o.value); setOpen(false); setQuery(''); }}>{o.label}</li>)}
      {shown.length === 0 && <li style={{ color: 'var(--muted)' }}>No matches</li>}
    </ul>}
  </div>;
}
