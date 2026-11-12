import { dispatch, type ApiRequest } from './api';
import { bootstrapAdmin as bootstrap } from './auth';
import { cleanImportedData } from './admin';
import { all, setupSchema } from './store';
import { beginPerformance, performanceSnapshot, timed } from './performance';
import { previewRfaReset, resetRfas } from './resetRfas';
import { archivePastSchoolYears, previewArchive } from './archive';
import { backupDatabase } from './backup';
import { installAutomaticMaintenance as installMaintenance, runMonthlyBackupJob, runYearlyArchiveJob } from './maintenance';
import { runDailyFollowUpsJob } from './followups';
import { NEW_OWNER_EMAIL, transferOwnership } from './ownership';

function json(value: unknown): GoogleAppsScript.Content.TextOutput {
  const serialized = timed('serializationMs', () => JSON.stringify(value));
  const performance = performanceSnapshot();
  const output = timed('responsePreparationMs', () => ContentService.createTextOutput(performance
    ? JSON.stringify({ ...(value as Record<string, unknown>), performance }) : serialized).setMimeType(ContentService.MimeType.JSON));
  const final = performanceSnapshot();
  if (final) console.log('[eRFA PERF]', JSON.stringify(final));
  return output;
}

function doGet(event?: GoogleAppsScript.Events.DoGet): GoogleAppsScript.Content.TextOutput {
  beginPerformance(event?.parameter?.perf === '1');
  return json({ ok: true, data: dispatch({ action: 'health' }) });
}

function doPost(event: GoogleAppsScript.Events.DoPost): GoogleAppsScript.Content.TextOutput {
  const requestStarted = Date.now();
  beginPerformance(false);
  try {
    const request = JSON.parse(event?.postData?.contents || '{}') as ApiRequest;
    beginPerformance(request.performance === true, requestStarted);
    return json({ ok: true, data: dispatch(request) });
  } catch (error) {
    console.error(error instanceof Error ? error : String(error));
    const typed = error as Error & { code?: string };
    return json({ ok: false, error: { code: typed.code || 'SERVER_ERROR', message: typed.message || 'The request could not be completed.' } });
  }
}

function setupDatabase(): unknown {
  return setupSchema();
}

function bootstrapAdmin(email: string, fullName: string): unknown {
  setupSchema();
  return bootstrap(email, fullName);
}

// One-click clean for the Apps Script editor: keeps ALL admins, deletes
// every other user + all departments/heads. Run once, then import the new list.
function cleanAllNow(): unknown {
  setupSchema();
  const admins = (all('USERS') as Array<{ IS_ADMIN?: unknown; EMAIL?: string; FULL_NAME?: string; USER_ID?: string }>).filter((u) => String(u.IS_ADMIN).toUpperCase() === 'TRUE' || u.IS_ADMIN === true);
  const actor = (admins[0] || { USER_ID: 'admin', FULL_NAME: 'Admin', EMAIL: '', IS_ADMIN: true }) as never;
  return cleanImportedData(actor as never, { confirm: 'DELETE' });
}

// After the pilot: run previewRfaResetNow first to see what would be removed,
// then resetAllRfasKeepAccounts to clear every RFA. Accounts, departments, heads,
// approval matrix, settings and budgets are kept, and a backup copy is made first.
function previewRfaResetNow(): unknown {
  const counts = previewRfaReset();
  console.log('[eRFA] RFA reset preview (rows that would be removed):', JSON.stringify(counts));
  return counts;
}

function resetAllRfasKeepAccounts(): unknown {
  const admins = (all('USERS') as Array<{ IS_ADMIN?: unknown; EMAIL?: string; FULL_NAME?: string }>).filter((u) => String(u.IS_ADMIN).toUpperCase() === 'TRUE' || u.IS_ADMIN === true);
  const actor = { FULL_NAME: admins[0]?.FULL_NAME || 'Administrator', EMAIL: admins[0]?.EMAIL || Session.getEffectiveUser().getEmail() };
  const result = resetRfas(actor);
  console.log('[eRFA] RFA reset complete:', JSON.stringify(result));
  return result;
}

// End of each school year: run previewArchiveNow to see how many finished RFAs from past
// school years would move, then archivePastSchoolYearsNow. A backup is made first; archived
// RFAs stay viewable read-only under the School year picker. Safe to run again.
function previewArchiveNow(): unknown {
  setupSchema();
  const counts = previewArchive();
  console.log('[eRFA] Archive preview (finished RFAs per past school year):', JSON.stringify(counts));
  return counts;
}

function archivePastSchoolYearsNow(): unknown {
  setupSchema();
  const admins = (all('USERS') as Array<{ IS_ADMIN?: unknown; EMAIL?: string; FULL_NAME?: string }>).filter((u) => String(u.IS_ADMIN).toUpperCase() === 'TRUE' || u.IS_ADMIN === true);
  const actor = { FULL_NAME: admins[0]?.FULL_NAME || 'Administrator', EMAIL: admins[0]?.EMAIL || Session.getEffectiveUser().getEmail() };
  const result = archivePastSchoolYears(actor);
  console.log('[eRFA] Archive complete:', JSON.stringify(result));
  return result;
}

// Automatic maintenance. Run installAutomaticMaintenance ONCE from the editor (Google asks the
// owner to allow scheduled jobs). After that: a backup on the 1st of every month (kept forever)
// and the yearly archive on June 15, with admin emails. backupNow makes an extra copy any time.
function installAutomaticMaintenance(): unknown {
  setupSchema();
  const result = installMaintenance();
  console.log('[eRFA] Automatic maintenance installed:', JSON.stringify(result));
  return result;
}

function backupNow(): unknown {
  setupSchema();
  const copy = backupDatabase('manual');
  console.log('[eRFA] Backup saved:', JSON.stringify(copy));
  return copy;
}

// One-time hand-over of eRFA's Drive files to the school's eRFA account (see ownership.ts).
// Run previewOwnershipTransferNow first (changes nothing), then transferOwnershipNow as the
// current owner. Run transferOwnershipNow again if it says it stopped before the time limit.
function previewOwnershipTransferNow(): unknown {
  const result = transferOwnership(NEW_OWNER_EMAIL, { dryRun: true });
  console.log('[eRFA] Ownership preview:', result.message, JSON.stringify(result.failed));
  return result;
}

function transferOwnershipNow(): unknown {
  const result = transferOwnership(NEW_OWNER_EMAIL);
  console.log('[eRFA] Ownership transfer:', result.message, JSON.stringify(result.failed));
  return result;
}

function runMonthlyBackup(): unknown { return runMonthlyBackupJob(); }
function runYearlyArchive(): unknown { setupSchema(); return runYearlyArchiveJob(); }
function runDailyFollowUps(): unknown { return runDailyFollowUpsJob(); }

// The production bundle keeps implementation code inside an IIFE. Store only
// intended Apps Script entry points here; build.mjs emits top-level forwarding
// declarations so Apps Script can discover them in the editor and Web App.
Object.assign(globalThis, { __erfaEntrypoints: { doGet, doPost, setupDatabase, bootstrapAdmin, cleanAllNow, previewRfaResetNow, resetAllRfasKeepAccounts, previewArchiveNow, archivePastSchoolYearsNow, installAutomaticMaintenance, backupNow, runMonthlyBackup, runYearlyArchive, runDailyFollowUps, previewOwnershipTransferNow, transferOwnershipNow } });
