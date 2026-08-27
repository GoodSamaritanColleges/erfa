import { Building2, GitBranch, Pencil, Plus, Users } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { Dialog, ErrorNotice, Spinner, SuccessNotice } from '../components';
import { stepLabel } from '../format';
import type { AdminData, Department, Matrix, User } from '../types';

type Tab = 'users'|'departments'|'matrix'|'logs';

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
          <h2>{tab === 'users' ? 'Registered users' : tab === 'departments' ? 'Departments' : 'Approval routing'}</h2>
          <p>{tab === 'matrix' ? 'Routes run by institutional step and sequence. Self-approval conflicts are skipped automatically.' : 'No public registration or destructive deletion.'}</p>
        </div>
        <button className="button primary" onClick={() => setEditing('new')}><Plus size={16}/> Add {tab === 'users' ? 'User' : tab === 'departments' ? 'Department' : 'Route'}</button>
      </header>}
      {tab === 'users' && <UsersTable users={data.users} departments={data.departments} edit={setEditing} />}
      {tab === 'departments' && <DepartmentsTable departments={data.departments} edit={setEditing} />}
      {tab === 'matrix' && <MatrixTable matrix={data.matrix} users={data.users} departments={data.departments} edit={setEditing} />}
      {tab === 'logs' && <Logs data={data} />}
    </section>

    {editing && <Dialog
      title={`${editing === 'new' ? 'Add' : 'Edit'} ${tab === 'users' ? 'user' : tab === 'departments' ? 'department' : 'approval route'}`}
      onClose={() => setEditing(null)}>
      <AdminForm tab={tab} editing={editing} data={data} onSaved={() => { setEditing(null); setSuccess('Configuration saved.'); load(); }} onError={setError} />
    </Dialog>}
  </>;
}

function UsersTable({ users, departments, edit }: { users: User[]; departments: Department[]; edit: (item: User) => void }) {
  return <div className="table-wrap"><table>
    <thead><tr><th>Name</th><th>Department / Position</th><th>Capabilities</th><th>Status</th><th /></tr></thead>
    <tbody>{users.map((user) => <tr key={user.USER_ID}>
      <td data-label="Name"><b>{user.FULL_NAME}</b><small>{user.EMAIL}</small></td>
      <td data-label="Department">{departments.find((d) => d.DEPARTMENT_ID === user.DEPARTMENT_ID)?.DEPARTMENT_NAME || 'Not assigned'}<small>{user.POSITION}</small></td>
      <td data-label="Capabilities"><div className="chips">{user.CAN_CREATE_RFA && <span>Create</span>}{user.CAN_APPROVE_RFA && <span>Approve</span>}{user.IS_ADMIN && <span>Admin</span>}</div></td>
      <td data-label="Status">{user.ACTIVE ? 'Active' : 'Inactive'}</td>
      <td><button className="icon-button" onClick={() => edit(user)} aria-label={`Edit ${user.FULL_NAME}`}><Pencil/></button></td>
    </tr>)}</tbody>
  </table></div>;
}

function DepartmentsTable({ departments, edit }: { departments: Department[]; edit: (item: Department) => void }) {
  return <div className="table-wrap"><table>
    <thead><tr><th>Code</th><th>Department</th><th>Status</th><th /></tr></thead>
    <tbody>{departments.map((dep) => <tr key={dep.DEPARTMENT_ID}>
      <td data-label="Code"><b>{dep.DEPARTMENT_CODE}</b></td>
      <td data-label="Department">{dep.DEPARTMENT_NAME}</td>
      <td data-label="Status">{dep.ACTIVE ? 'Active' : 'Inactive'}</td>
      <td><button className="icon-button" onClick={() => edit(dep)} aria-label={`Edit ${dep.DEPARTMENT_NAME}`}><Pencil/></button></td>
    </tr>)}</tbody>
  </table></div>;
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
  return <div className="logs-grid">
    <div>
      <h2>Recent Audit</h2>
      <div className="log-list">{data.audit.slice(0,100).map((row) => <div key={row.LOG_ID}>
        <b>{String(row.ACTION).replaceAll('_',' ')}</b>
        <span>{row.ACTOR_NAME} - {row.TIMESTAMP}</span>
        <p>{row.REMARKS}</p>
      </div>)}</div>
    </div>
    <div>
      <h2>Notification Delivery</h2>
      <div className="log-list">{data.notifications.slice(0,100).map((row) => <div key={row.NOTIFICATION_ID}>
        <b>{row.NOTIFICATION_TYPE} - {row.STATUS}</b>
        <span>{row.RECIPIENT_EMAIL} - {row.SENT_AT || 'Not sent'}</span>
        <p>{row.ERROR_MESSAGE}</p>
      </div>)}</div>
    </div>
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
      if (tab === 'users') await api('admin.user.save', { userId: form.USER_ID, fullName: form.FULL_NAME, email: form.EMAIL, departmentId: form.DEPARTMENT_ID, position: form.POSITION, canCreateRfa: form.CAN_CREATE_RFA ?? true, canApproveRfa: form.CAN_APPROVE_RFA ?? false, isAdmin: form.IS_ADMIN ?? false, active: form.ACTIVE ?? true });
      else if (tab === 'departments') await api('admin.department.save', { departmentId: form.DEPARTMENT_ID, departmentName: form.DEPARTMENT_NAME, departmentCode: form.DEPARTMENT_CODE, active: form.ACTIVE ?? true });
      else await api('admin.matrix.save', { matrixId: form.MATRIX_ID, departmentId: form.DEPARTMENT_ID, approvalStep: form.APPROVAL_STEP ?? 'RECOMMENDING_APPROVAL', approverUserId: form.APPROVER_USER_ID, sequence: form.SEQUENCE ?? 1, required: true, active: form.ACTIVE ?? true });
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
      <Checkbox label="Administrator" checked={Boolean(form.IS_ADMIN)} set={(v) => set('IS_ADMIN',v)}/>
      <Checkbox label="Active" checked={Boolean(form.ACTIVE ?? true)} set={(v) => set('ACTIVE',v)}/>
    </>}
    {tab === 'departments' && <>
      <label className="field"><span>Department Name</span><input required value={String(form.DEPARTMENT_NAME ?? '')} onChange={(e) => set('DEPARTMENT_NAME',e.target.value)}/></label>
      <label className="field"><span>Department Code</span><input required maxLength={20} value={String(form.DEPARTMENT_CODE ?? '')} onChange={(e) => set('DEPARTMENT_CODE',e.target.value)}/></label>
      <Checkbox label="Active" checked={Boolean(form.ACTIVE ?? true)} set={(v) => set('ACTIVE',v)}/>
    </>}
    {tab === 'matrix' && <>
      <label className="field"><span>Department</span><select required value={String(form.DEPARTMENT_ID ?? '')} onChange={(e) => set('DEPARTMENT_ID',e.target.value)}><option value="">Select department</option>{data.departments.filter((d) => d.ACTIVE).map((d) => <option key={d.DEPARTMENT_ID} value={d.DEPARTMENT_ID}>{d.DEPARTMENT_NAME}</option>)}</select></label>
      <label className="field"><span>Approval Step</span><select value={String(form.APPROVAL_STEP ?? 'RECOMMENDING_APPROVAL')} onChange={(e) => set('APPROVAL_STEP',e.target.value)}><option value="RECOMMENDING_APPROVAL">Recommending Approval</option><option value="REVIEWED_AND_NOTED">Reviewed and Noted By</option><option value="APPROVED_BY">Approved By</option></select></label>
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
