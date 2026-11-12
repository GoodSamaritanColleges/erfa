/**
 * Local demo server: runs the real eRFA backend (src/api.ts) with an in-memory database and
 * sample school data, so the website can be clicked through without Google.
 *
 *   node dev/build-demo.mjs && node dev/demo-server.cjs      (http://localhost:8787)
 *
 * Sign in by putting a token from /dev-token?email=<user email> into sessionStorage
 * "erfa_google_id_token" (the demo website does this from its login hint).
 * Never deploy this: it trusts any token.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { dispatch } from '../src/api';
import { createRfa, decideRfa, submitRfa } from '../src/workflow';
import { all, insert, outbox, setSetting, setupSchema } from './memoryStore';
import type { SessionUser, UserRecord } from '../src/types';

// --- Google services the backend touches, stubbed for local use ---
const cache = new Map<string, string>();
const props = new Map<string, string>();
const b64url = (data: string | Buffer) => Buffer.from(data).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
Object.assign(globalThis, {
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => undefined }) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: (k: string) => props.get(k) ?? null, setProperty: (k: string, v: string) => { props.set(k, v); } }) },
  CacheService: { getScriptCache: () => ({ get: (k: string) => cache.get(k) ?? null, put: (k: string, v: string) => { cache.set(k, v); } }) },
  Utilities: {
    DigestAlgorithm: { SHA_256: 'sha256' },
    computeDigest: (_alg: string, text: string) => [...createHash('sha256').update(text).digest()],
    base64EncodeWebSafe: (bytes: number[]) => Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
    base64Encode: (bytes: number[]) => Buffer.from(bytes).toString('base64'),
    getUuid: () => randomUUID(),
    formatDate: (date: Date, _tz: string, fmt: string) => { const d = new Date(date.getTime() + 8 * 3600000).toISOString(); return fmt === 'yyyy-MM-dd' ? d.slice(0, 10) : `${d.slice(0, 10)} ${d.slice(11, 13)}${d.slice(14, 16)}`; }
  },
  UrlFetchApp: {
    fetch: (url: string) => {
      const token = decodeURIComponent(url.split('id_token=')[1] || '');
      const payload = JSON.parse(Buffer.from((token.split('.')[1] || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8') || '{}');
      return { getResponseCode: () => (payload.email ? 200 : 400), getContentText: () => JSON.stringify({ aud: 'local-demo-client', iss: 'accounts.google.com', email_verified: 'true', email: payload.email, exp: String(payload.exp), name: payload.name || payload.email }) };
    }
  },
  MailApp: { sendEmail: (message: { to: string; subject: string }) => { outbox.push({ to: message.to, subject: message.subject }); console.log(`[email] to ${message.to}: ${message.subject}`); } },
  DriveApp: { getFileById: () => { throw new Error('Attachments are not available in the local demo.'); }, getFolderById: () => { throw new Error('Attachments are not available in the local demo.'); } },
  Session: { getEffectiveUser: () => ({ getEmail: () => 'owner@demo.edu' }) },
  ScriptApp: { getProjectTriggers: () => [], deleteTrigger: () => undefined, newTrigger: () => { const b = { timeBased: () => b, onMonthDay: () => b, everyDays: () => b, atHour: () => b, inTimezone: () => b, create: () => ({}) }; return b; } },
  SpreadsheetApp: { flush: () => undefined }
});

// --- Sample school ---
setupSchema();
const stamp = new Date().toISOString();
const dept = (id: string, name: string, code: string, academic = false) => insert('DEPARTMENTS', { DEPARTMENT_ID: id, DEPARTMENT_NAME: name, DEPARTMENT_CODE: code, ACTIVE: true, CREATED_AT: stamp, UPDATED_AT: stamp, DEPARTMENT_HEAD_USER_ID: '', IS_ACADEMIC: academic });
dept('d_it', 'Information Technology Office', 'ITO');
dept('d_coe', 'College of Education', 'COE', true);
dept('d_shs', 'SHS', 'SHS', true);
dept('d_ppu', 'Procurement Unit', 'PPU');
dept('d_fin', 'Finance Office', 'FIN');
const person = (id: string, name: string, email: string, department: string, position: string, flags: Partial<UserRecord> = {}) => insert('USERS', { USER_ID: id, FULL_NAME: name, EMAIL: email, DEPARTMENT_ID: department, POSITION: position, CAN_CREATE_RFA: true, CAN_APPROVE_RFA: true, IS_ADMIN: false, ACTIVE: true, CREATED_AT: stamp, UPDATED_AT: stamp, CAN_IMPLEMENT_RFA: false, ...flags });
person('admin', 'Piolo L. Bernardino', 'admin@demo.edu', 'd_it', 'Learning Management System Admin', { IS_ADMIN: true });
person('kristine', 'Ramos, Kristine D.', 'kristine@demo.edu', 'd_it', 'IT Staff', { CAN_APPROVE_RFA: false });
person('maria', 'Santos, Maria L.', 'maria@demo.edu', 'd_coe', 'Faculty', { CAN_APPROVE_RFA: false });
person('juan', 'Dela Cruz, Juan P.', 'juan@demo.edu', 'd_shs', 'SHS Teacher', { CAN_APPROVE_RFA: false });
person('alona', 'Aquino, Alona T.', 'alona@demo.edu', 'd_it', 'IT Office Head');
person('coehead', 'Reyes, Carmela B.', 'carmela@demo.edu', 'd_coe', 'Dean, College of Education');
person('shshead', 'Lim, Roberto C.', 'roberto@demo.edu', 'd_shs', 'SHS Coordinator');
person('ofelia', 'Hocson, Ofelia E.', 'ofelia@demo.edu', 'd_fin', 'Internal Auditor');
person('ana', 'Tago, Ana Liza V.', 'ana@demo.edu', 'd_fin', 'AVP for Finance');
person('raquel', 'Baquiran, Raquel Lim', 'raquel@demo.edu', 'd_fin', 'VP for Admin and Finance');
person('jennelyn', 'De Guzman, Jennelyn', 'jennelyn@demo.edu', 'd_coe', 'VP for Academic Affairs');
person('president', 'De Guzman-Valino, Alessandra', 'president@demo.edu', 'd_fin', 'President');
person('noliver', 'Garcia, Noliver M.', 'noliver@demo.edu', 'd_shs', 'JHS/SHS Principal');
person('marjorie', 'Valdez, Marjorie', 'marjorie@demo.edu', 'd_ppu', 'Procurement Clerk', { CAN_APPROVE_RFA: false });
const head = (department: string, user: string) => insert('DEPARTMENT_HEADS', { HEAD_ID: `h_${department}_${user}`, DEPARTMENT_ID: department, USER_ID: user, ACTIVE: true, CREATED_AT: stamp, UPDATED_AT: stamp });
head('d_it', 'alona'); head('d_coe', 'coehead'); head('d_shs', 'shshead'); head('d_fin', 'raquel');
setSetting('GOOGLE_CLIENT_ID', 'local-demo-client');
setSetting('EMAIL_ENABLED', 'TRUE');
setSetting('FRONTEND_URL', 'http://localhost:5174/erfa/');
setSetting('REVIEWED_MANDATORY_USER_ID', 'ofelia');
setSetting('APPROVED_MANDATORY_USER_IDS', 'ana,raquel');
setSetting('VP_ACADEMIC_USER_ID', 'jennelyn');
setSetting('PRESIDENT_USER_ID', 'president');
setSetting('PRINCIPAL_USER_ID', 'noliver');
setSetting('PRESIDENT_THRESHOLD_PHP', '50000');
setSetting('AUTO_MAINTENANCE', 'ON');
setSetting('LAST_BACKUP_AT', stamp);
insert('BACKUPS', { BACKUP_DATE: stamp, FILE_NAME: `eRFA Database backup ${stamp.slice(0, 10)}`, FILE_ID: 'demo', URL: 'https://drive.google.com/', REASON: 'Monthly' });
// A leftover matrix row like the one left by the real data clean-up.
insert('APPROVAL_MATRIX', { MATRIX_ID: 'm_leftover', DEPARTMENT_ID: 'deleted_department', APPROVAL_STEP: 'RECOMMENDING_APPROVAL', APPROVER_USER_ID: 'deleted_user', SEQUENCE: 1, REQUIRED: true, ACTIVE: true, CREATED_AT: stamp, UPDATED_AT: stamp });

const user = (id: string) => all<UserRecord>('USERS').find((u) => u.USER_ID === id) as unknown as SessionUser;
const withDept = (id: string) => ({ ...user(id), DEPARTMENT_NAME: all<{ DEPARTMENT_ID: string; DEPARTMENT_NAME: string }>('DEPARTMENTS').find((d) => d.DEPARTMENT_ID === user(id).DEPARTMENT_ID)?.DEPARTMENT_NAME || '' }) as SessionUser;
const form = (title: string, amount: number, over: Record<string, unknown> = {}) => ({ requestTitle: title, purpose: `Purpose of ${title.toLowerCase()} for the school.`, budgetAllocation: amount, targetDate: '2027-01-15', justification: 'Needed to support classes and operations this school year.', requestedAmount: String(amount), expenseClassification: 'OPEX', purchaseRequest: false, involvedDepartmentIds: [], recommendingAlternateUserId: '', includePrincipal: false, includeProcurement: false, ...over });
const approve = (rfaId: string, ids: string[]) => ids.forEach((id) => decideRfa(withDept(id), rfaId, 'APPROVED', ''));

createRfa(withDept('kristine'), form('Printer toner for the IT Office', 4500));                       // draft
const a = createRfa(withDept('kristine'), form('Network switch replacement', 18000, { expenseClassification: 'CAPEX' }));
submitRfa(withDept('kristine'), a.RFA_ID);                                                               // waiting on department head
const b = createRfa(withDept('kristine'), form('Annual antivirus licenses', 32000));
submitRfa(withDept('kristine'), b.RFA_ID); approve(b.RFA_ID, ['alona']);                                 // Reviewed and Noted
const c = createRfa(withDept('kristine'), form('Computer laboratory upgrade', 95000, { expenseClassification: 'CAPEX' }));
submitRfa(withDept('kristine'), c.RFA_ID); approve(c.RFA_ID, ['alona', 'ofelia']);                       // Approved By (with President)
const d = createRfa(withDept('maria'), form('Teaching demonstration materials', 12000));
submitRfa(withDept('maria'), d.RFA_ID); approve(d.RFA_ID, ['coehead', 'ofelia', 'ana', 'raquel', 'jennelyn']); // fully approved (academic)
const e = createRfa(withDept('juan'), form('SHS science fair supplies', 8000, { includePrincipal: true }));
submitRfa(withDept('juan'), e.RFA_ID); approve(e.RFA_ID, ['shshead']);                                   // Reviewed incl. Principal
const f = createRfa(withDept('kristine'), form('Office chairs', 15000));
submitRfa(withDept('kristine'), f.RFA_ID); decideRfa(withDept('alona'), f.RFA_ID, 'RETURNED', 'Please attach two quotations.');
console.log(`Seeded ${all('RFA').length} RFAs, ${all('USERS').length} users.`);

// --- HTTP ---
const PORT = 8787;
createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  if (req.method === 'GET' && url.pathname === '/dev-token') {
    const email = url.searchParams.get('email') || 'admin@demo.edu';
    const token = `${b64url('{"alg":"none"}')}.${b64url(JSON.stringify({ email, exp: Math.floor(Date.now() / 1000) + 8 * 3600 }))}.demo`;
    res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(token); return;
  }
  if (req.method === 'GET' && url.pathname === '/outbox') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(outbox)); return; }
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    let payload: unknown;
    try { payload = { ok: true, data: dispatch(JSON.parse(body || '{}')) }; }
    catch (error) { const typed = error as Error & { code?: string }; payload = { ok: false, error: { code: typed.code || 'SERVER_ERROR', message: typed.message || 'Request failed.' } }; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
}).listen(PORT, () => console.log(`eRFA local demo API on http://localhost:${PORT}`));
