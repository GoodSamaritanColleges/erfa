import { ArrowLeft, FileText, Paperclip, Save, Send } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, fileToBase64 } from '../api';
import { useAuth } from '../auth';
import { ErrorNotice, Spinner } from '../components';
import type { Rfa, RfaDetail } from '../types';

interface FormState { requestTitle: string; purpose: string; budgetAllocation: string; targetDate: string; justification: string }
const blank: FormState = { requestTitle: '', purpose: '', budgetAllocation: '', targetDate: '', justification: '' };

export function RfaFormPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [form, setForm] = useState<FormState>(blank);
  const [existing, setExisting] = useState<Rfa | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(Boolean(id));

  useEffect(() => {
    if (!id) return;
    void api<RfaDetail>('rfa.detail', { rfaId: id }).then(({ rfa, permissions }) => {
      if (!permissions.canEdit) throw new Error('This RFA is not editable.');
      setExisting(rfa);
      setForm({ requestTitle: rfa.REQUEST_TITLE, purpose: rfa.PURPOSE, budgetAllocation: String(rfa.BUDGET_ALLOCATION), targetDate: rfa.TARGET_DATE, justification: rfa.JUSTIFICATION });
    }).catch((e: Error) => setError(e.message)).finally(() => setLoading(false));
  }, [id]);

  const set = (key: keyof FormState, value: string) => setForm((current) => ({ ...current, [key]: value }));

  async function persist(submit: boolean) {
    setSaving(true);
    setError('');
    try {
      const payload = { ...form, budgetAllocation: Number(form.budgetAllocation || 0) };
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
          <span>03</span>
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

      <section className="approval-preview">
        <span className="eyebrow">APPROVAL SIGNATURES</span>
        <div>
          <b>Prepared By</b>
          <b>Recommending Approval</b>
          <b>Reviewed and Noted By</b>
          <b>Approved By</b>
        </div>
        <p>Approvers are assigned from the active department approval matrix. You cannot approve your own request.</p>
      </section>

      <div className="form-actions">
        <button className="button secondary" type="button" disabled={saving} onClick={() => void persist(false)}><Save size={16} /> Save Draft</button>
        <button className="button primary" type="submit" disabled={saving}><Send size={16} /> {existing?.STATUS === 'RETURNED' ? 'Resubmit RFA' : 'Submit for Approval'}</button>
      </div>
    </form>
  </>;
}

function ReadOnly({ label, value }: { label: string; value: string }) {
  return <div className="readonly"><span>{label}</span><b>{value || '---'}</b></div>;
}
