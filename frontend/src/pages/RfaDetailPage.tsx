import { ArrowLeft, Check, Download, Edit3, FileText, Printer, RotateCcw, Send, XCircle } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { Dialog, ErrorNotice, Spinner, StatusBadge, SuccessNotice } from '../components';
import { date, dateTime, money, stepLabel } from '../format';
import type { Approval, ApprovalStep, Attachment, RfaDetail } from '../types';

const steps: ApprovalStep[] = ['PREPARED_BY', 'RECOMMENDING_APPROVAL', 'REVIEWED_AND_NOTED', 'APPROVED_BY'];

export function RfaDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<RfaDetail | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(true);
  const [dialog, setDialog] = useState<'approve'|'return'|'disapprove'|null>(null);
  const [remarks, setRemarks] = useState('');
  const [working, setWorking] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    void api<RfaDetail>('rfa.detail', { rfaId: id })
      .then(setDetail)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(load, [load]);

  async function decide() {
    if (!dialog) return;
    setWorking(true);
    setError('');
    try {
      await api(`rfa.${dialog}`, { rfaId: id, remarks });
      setDialog(null);
      setRemarks('');
      setSuccess(dialog === 'approve' ? 'Approval recorded and the workflow advanced.' : `RFA ${dialog === 'return' ? 'returned for revision' : 'disapproved'}.`);
      load();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'The action failed.'); }
    finally { setWorking(false); }
  }

  async function transition(action: 'implementation'|'close') {
    setWorking(true);
    try { await api(`rfa.${action}`, { rfaId: id }); setSuccess(action === 'close' ? 'RFA closed.' : 'RFA moved to implementation.'); load(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'The action failed.'); }
    finally { setWorking(false); }
  }

  async function download(attachment: Attachment) {
    try {
      const file = await api<{ fileName: string; mimeType: string; base64: string }>('attachment.download', { attachmentId: attachment.ATTACHMENT_ID });
      const bytes = Uint8Array.from(atob(file.base64), (char) => char.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: file.mimeType }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = file.fileName;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Attachment download failed.'); }
  }

  if (loading && !detail) return <Spinner label="Loading RFA" />;
  if (!detail) return <><ErrorNotice message={error || 'RFA was not found.'} /><button className="button secondary" onClick={() => navigate('/rfas')}>Back to My RFAs</button></>;

  const { rfa, approvals, attachments, audit, permissions } = detail;

  return <>
    <div className="screen-only">
      <Link className="back-link" to="/rfas"><ArrowLeft size={16} /> Back to RFAs</Link>
      <header className="detail-header">
        <div>
          <span className="eyebrow orange">{rfa.RFA_NUMBER}</span>
          <h1>{rfa.REQUEST_TITLE || 'Untitled draft'}</h1>
          <div className="detail-meta">
            <StatusBadge status={rfa.STATUS} />
            <span>Filed {date(rfa.DATE_FILED)}</span>
            <span>Updated {dateTime(rfa.UPDATED_AT)}</span>
          </div>
        </div>
        <div className="header-actions">
          <button className="button secondary" onClick={() => window.print()}><Printer size={16} /> Print / PDF</button>
          {permissions.canEdit && <Link className="button secondary" to={`/rfa/${rfa.RFA_ID}/edit`}><Edit3 size={16} /> Edit</Link>}
        </div>
      </header>
      <ErrorNotice message={error} />
      <SuccessNotice message={success} />
    </div>

    <article className="rfa-document">
      <header className="print-brand">
        <img src={`${import.meta.env.BASE_URL}gsc-logo.png`} alt="Good Samaritan Colleges" />
        <div>
          <b>REQUEST FOR APPROVAL (RFA) FORM</b>
          <span>{rfa.RFA_NUMBER}</span>
        </div>
      </header>

      <section className="request-grid">
        <Fact label="Date Filed" value={date(rfa.DATE_FILED)} />
        <Fact label="Department" value={rfa.DEPARTMENT_NAME} />
        <Fact label="Requested By" value={rfa.REQUESTED_BY} />
        <Fact label="Position" value={rfa.POSITION} />
        <Fact label="Project / Activity / Request Title" value={rfa.REQUEST_TITLE} wide />
      </section>

      <DocumentSection title="Purpose"><p>{rfa.PURPOSE || '---'}</p></DocumentSection>

      <section className="request-grid two">
        <Fact label="Budget Allocation" value={money(rfa.BUDGET_ALLOCATION)} />
        <Fact label="Target Date" value={date(rfa.TARGET_DATE)} />
      </section>

      <DocumentSection title="Justification"><p>{rfa.JUSTIFICATION || '---'}</p></DocumentSection>

      <DocumentSection title="Picture / Letter Attachment">
        <div className="attachments">
          {attachments.length ? attachments.map((attachment) => <button key={attachment.ATTACHMENT_ID} onClick={() => void download(attachment)}>
            <FileText />
            <span>
              <b>{attachment.FILE_NAME}</b>
              <small>{(Number(attachment.SIZE_BYTES) / 1024 / 1024).toFixed(2)} MB - uploaded {dateTime(attachment.UPLOADED_AT)}</small>
            </span>
            <Download />
          </button>) : <p>No attachment submitted.</p>}
        </div>
      </DocumentSection>

      <section className="workflow-section">
        <header>
          <span className="eyebrow">APPROVAL WORKFLOW</span>
          <StatusBadge status={rfa.STATUS} />
        </header>
        <div className="workflow-steps">
          {steps.map((step) => <WorkflowStep key={step} step={step} approvals={approvals} current={rfa.CURRENT_STEP === step} />)}
        </div>
      </section>

      <section className="approval-signatures">
        <h2>Approval Signatures</h2>
        <div>
          {steps.map((step) => {
            const approval = [...approvals].reverse().find((item) => item.STEP === step && item.ACTION === 'APPROVED');
            return <div key={step}>
              <b>{stepLabel(step).toUpperCase()}</b>
              {approval
                ? <><strong>Approved electronically by<br />{approval.APPROVER_NAME}</strong><span>{dateTime(approval.TIMESTAMP)}</span></>
                : <strong>Pending electronic approval</strong>}
            </div>;
          })}
        </div>
      </section>

      <DocumentSection title="Approval History">
        <HistoryTable approvals={approvals} />
      </DocumentSection>

      <section className="audit-section screen-only">
        <h2>Audit History</h2>
        {audit.length ? <ol>{[...audit].reverse().map((entry) => <li key={entry.LOG_ID}>
          <span>{dateTime(entry.TIMESTAMP)}</span>
          <div>
            <b>{entry.ACTION.replaceAll('_',' ')}</b>
            <p>{entry.ACTOR_NAME}{entry.REMARKS ? ` - ${entry.REMARKS}` : ''}</p>
          </div>
        </li>)}</ol> : <p>No audit entries.</p>}
      </section>

      <footer className="print-footer">
        <span>Effectivity 070626</span>
        <span>Generated electronically from eRFA - {new Date().toLocaleString('en-PH')}</span>
      </footer>
    </article>

    <section className="decision-bar screen-only">
      {permissions.canDecide && <>
        <div>
          <span className="eyebrow orange">DECISION REQUIRED</span>
          <b>Review the complete RFA and attachments before acting.</b>
        </div>
        <div>
          <button className="button danger-outline" onClick={() => setDialog('disapprove')}><XCircle size={16}/> Disapprove</button>
          <button className="button secondary" onClick={() => setDialog('return')}><RotateCcw size={16}/> Return</button>
          <button className="button primary" onClick={() => setDialog('approve')}><Check size={16}/> Approve</button>
        </div>
      </>}
      {!permissions.canDecide && permissions.canImplement && <>
        <div>
          <span className="eyebrow orange">BUDGET ALLOCATION CONFIRMED</span>
          <b>Final approval is complete. Begin implementation when ready.</b>
        </div>
        <button className="button primary" disabled={working} onClick={() => void transition('implementation')}><Send size={16}/> Start Implementation</button>
      </>}
      {!permissions.canDecide && permissions.canClose && rfa.STATUS === 'IMPLEMENTATION' && <>
        <div>
          <span className="eyebrow orange">IMPLEMENTATION</span>
          <b>File the completed RFA for audit when implementation is finished.</b>
        </div>
        <button className="button primary" disabled={working} onClick={() => void transition('close')}><Check size={16}/> Close RFA</button>
      </>}
    </section>

    {dialog && <Dialog
      title={dialog === 'approve' ? 'Confirm electronic approval' : dialog === 'return' ? 'Return RFA for revision' : 'Disapprove RFA'}
      onClose={() => setDialog(null)}>
      <div className="dialog-body">
        <p>{dialog === 'approve'
          ? 'Your identity, approval step, timestamp, and remarks will be recorded permanently.'
          : 'Provide a clear reason so the requester understands what is required.'}</p>
        <label className="field">
          <span>Remarks {dialog !== 'approve' && <b>*</b>}</span>
          <textarea rows={4} value={remarks} onChange={(e) => setRemarks(e.target.value)} autoFocus />
        </label>
        <div className="dialog-actions">
          <button className="button ghost" onClick={() => setDialog(null)}>Cancel</button>
          <button className={`button ${dialog === 'disapprove' ? 'danger' : 'primary'}`}
            disabled={working || (dialog !== 'approve' && remarks.trim().length < 3)}
            onClick={() => void decide()}>
            {dialog === 'approve' ? 'Confirm Approval' : dialog === 'return' ? 'Return to Requester' : 'Confirm Disapproval'}
          </button>
        </div>
      </div>
    </Dialog>}
  </>;
}

function Fact({ label, value, wide = false }: { label: string; value: string; wide?: boolean }) {
  return <div className={wide ? 'wide' : ''}><span>{label}</span><b>{value || '---'}</b></div>;
}

function DocumentSection({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="document-section"><h2>{title}</h2>{children}</section>;
}

function WorkflowStep({ step, approvals, current }: { step: ApprovalStep; approvals: Approval[]; current: boolean }) {
  const completed = approvals.some((item) => item.STEP === step && item.ACTION === 'APPROVED');
  const exception = approvals.some((item) => item.STEP === step && ['RETURNED','DISAPPROVED','EXCEPTION'].includes(item.ACTION));
  return <div className={`${completed ? 'completed' : ''} ${current ? 'current' : ''} ${exception ? 'exception' : ''}`}>
    <span>{completed ? <Check size={16}/> : steps.indexOf(step) + 1}</span>
    <b>{stepLabel(step)}</b>
    <small>{completed ? 'Complete' : current ? 'Awaiting action' : exception ? 'Action recorded' : 'Pending'}</small>
  </div>;
}

function HistoryTable({ approvals }: { approvals: Approval[] }) {
  return approvals.length ? <div className="table-wrap">
    <table>
      <thead><tr><th>Step</th><th>Approver</th><th>Action</th><th>Remarks</th><th>Timestamp</th></tr></thead>
      <tbody>{approvals.map((approval) => <tr key={approval.APPROVAL_ID}>
        <td data-label="Step">{stepLabel(approval.STEP)}</td>
        <td data-label="Approver">{approval.APPROVER_NAME || 'System'}</td>
        <td data-label="Action"><b>{approval.ACTION}</b></td>
        <td data-label="Remarks">{approval.REMARKS || '---'}</td>
        <td data-label="Timestamp">{dateTime(approval.TIMESTAMP)}</td>
      </tr>)}</tbody>
    </table>
  </div> : <p>No approval actions recorded.</p>;
}
