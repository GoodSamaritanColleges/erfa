import { audit } from './audit';
import { archivePastSchoolYears, schoolYearLabel, visiblePastYears, currentSchoolYear } from './archive';
import { backupDatabase, manilaToday } from './backup';
import { toBoolean } from './core';
import { all, getSetting, nowIso, setSetting, settingBoolean } from './store';
import type { SheetRecord, UserRecord } from './types';

/**
 * Automatic maintenance, switched on once with installAutomaticMaintenance():
 *  - 1st of every month, 2 AM Manila: full backup of the database, kept forever.
 *  - 15th of the school-year start month (June 15), 3 AM: archive finished RFAs of past
 *    school years (backs up first). The trigger fires on the 15th of every month and only
 *    acts in the start month.
 * Admins are emailed after each run and alerted on failure.
 */
export const MAINTENANCE_HANDLERS = { backup: 'runMonthlyBackup', archive: 'runYearlyArchive', followups: 'runDailyFollowUps' } as const;
const SYSTEM_ACTOR = { FULL_NAME: 'eRFA automatic maintenance', EMAIL: '' };

function startMonth(): number {
  const month = Number(getSetting('SCHOOL_YEAR_START_MONTH') || 6);
  return month >= 1 && month <= 12 ? Math.floor(month) : 6;
}

export function emailAdmins(subject: string, body: string): void {
  try {
    if (!settingBoolean('EMAIL_ENABLED')) return;
    const recipients = all<UserRecord>('USERS').filter((u) => toBoolean(u.IS_ADMIN) && toBoolean(u.ACTIVE) && u.EMAIL).map((u) => String(u.EMAIL));
    if (recipients.length) MailApp.sendEmail({ to: [...new Set(recipients)].join(','), subject: `[eRFA] ${subject}`, body, name: 'eRFA' });
  } catch { /* an email problem must never undo a finished backup or archive */ }
}

export function runMonthlyBackupJob(): Record<string, unknown> {
  try {
    const copy = backupDatabase('Monthly');
    setSetting('LAST_BACKUP_AT', nowIso(), 'Last automatic backup (set by eRFA)');
    audit('BACKUP_CREATED', SYSTEM_ACTOR, '', '', '', copy.name, { fileId: copy.id });
    emailAdmins('Monthly backup saved', `The monthly eRFA database backup was saved.\n\nFile: ${copy.name}\n${copy.url ? `Open: ${copy.url}\n` : ''}\nBackups are kept forever in the "eRFA Backups" folder in Drive.\n\neRFA - automatic maintenance`);
    return { ok: true, ...copy };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    audit('BACKUP_FAILED', SYSTEM_ACTOR, '', '', '', message);
    emailAdmins('Monthly backup FAILED', `The monthly eRFA database backup could not be saved.\n\nReason: ${message}\n\nPlease make a manual copy of the database (File > Make a copy) and check Drive storage and the script owner's access.\n\neRFA - automatic maintenance`);
    return { ok: false, error: message };
  }
}

export function runYearlyArchiveJob(now = new Date()): Record<string, unknown> {
  const month = Number(manilaToday(now).slice(5, 7));
  if (month !== startMonth()) return { ok: true, skipped: true };
  try {
    const result = archivePastSchoolYears(SYSTEM_ACTOR);
    setSetting('LAST_ARCHIVE_AT', nowIso(), 'Last automatic yearly archive (set by eRFA)');
    emailAdmins('Yearly archive finished', `${String(result.message || 'The yearly archive finished.')}\n\nThe app shows the current school year and the previous ${visiblePastYears()}. Older years stay in their archive spreadsheets and the monthly backups in Drive.\n\neRFA - automatic maintenance`);
    return { ok: true, ...result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    audit('ARCHIVE_FAILED', SYSTEM_ACTOR, '', '', '', message);
    emailAdmins('Yearly archive FAILED', `The yearly eRFA archive did not run.\n\nReason: ${message}\n\nNothing was removed from the database. You can run archivePastSchoolYearsNow from the Apps Script editor once the cause is fixed.\n\neRFA - automatic maintenance`);
    return { ok: false, error: message };
  }
}

/** One-time setup from the Apps Script editor: (re)creates both schedules and makes a first backup. */
export function installAutomaticMaintenance(): Record<string, unknown> {
  const handlers = Object.values(MAINTENANCE_HANDLERS) as string[];
  ScriptApp.getProjectTriggers().filter((t) => handlers.includes(t.getHandlerFunction())).forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger(MAINTENANCE_HANDLERS.backup).timeBased().onMonthDay(1).atHour(2).inTimezone('Asia/Manila').create();
  ScriptApp.newTrigger(MAINTENANCE_HANDLERS.archive).timeBased().onMonthDay(15).atHour(3).inTimezone('Asia/Manila').create();
  ScriptApp.newTrigger(MAINTENANCE_HANDLERS.followups).timeBased().everyDays(1).atHour(7).inTimezone('Asia/Manila').create();
  setSetting('AUTO_MAINTENANCE', 'ON', 'ON after installAutomaticMaintenance: monthly backup on the 1st, yearly archive on the 15th of the school-year start month.');
  audit('AUTO_MAINTENANCE_INSTALLED', SYSTEM_ACTOR, '', '', '', 'Monthly backup and yearly archive scheduled.');
  const first = runMonthlyBackupJob();
  return { installed: true, firstBackup: first };
}

function nextDate(day: number, onlyMonth?: number, now = new Date()): string {
  const today = manilaToday(now);
  let [y, m] = today.split('-').map(Number);
  const d = Number(today.slice(8, 10));
  for (let i = 0; i < 25; i += 1) {
    if ((i > 0 || d < day) && (!onlyMonth || m === onlyMonth)) return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    m += 1; if (m > 12) { m = 1; y += 1; }
  }
  return '';
}

/**
 * Installs made before daily follow-ups existed get the daily schedule added automatically the
 * next time an administrator opens the maintenance panel (no second setup click needed).
 */
function ensureDailyFollowUps(): boolean {
  if (String(getSetting('AUTO_MAINTENANCE') || '').toUpperCase() !== 'ON') return false;
  try {
    if (ScriptApp.getProjectTriggers().some((t) => t.getHandlerFunction() === MAINTENANCE_HANDLERS.followups)) return true;
    ScriptApp.newTrigger(MAINTENANCE_HANDLERS.followups).timeBased().everyDays(1).atHour(7).inTimezone('Asia/Manila').create();
    return true;
  } catch { return false; }
}

/** For the Administration page: is it on, recent backups with links, and what runs next. */
export function maintenanceStatus(): Record<string, unknown> {
  const followUpsScheduled = ensureDailyFollowUps();
  let failedEmails = 0;
  try { failedEmails = all<SheetRecord>('NOTIFICATIONS').filter((row) => String(row.STATUS) === 'FAILED' && Number(row.RETRY_COUNT || 0) < 3).length; } catch { failedEmails = 0; }
  let backups: SheetRecord[] = [];
  try { backups = all<SheetRecord>('BACKUPS').sort((a, b) => String(b.BACKUP_DATE).localeCompare(String(a.BACKUP_DATE))).slice(0, 12); } catch { backups = []; }
  const lastBackupAt = String(getSetting('LAST_BACKUP_AT') || '');
  const overdue = !lastBackupAt || Date.now() - Date.parse(lastBackupAt) > 35 * 24 * 60 * 60 * 1000;
  const current = currentSchoolYear();
  return {
    enabled: String(getSetting('AUTO_MAINTENANCE') || '').toUpperCase() === 'ON',
    lastBackupAt,
    lastArchiveAt: String(getSetting('LAST_ARCHIVE_AT') || ''),
    backupOverdue: overdue,
    nextBackup: nextDate(1),
    nextArchive: nextDate(15, startMonth()),
    visibleFrom: schoolYearLabel(current - visiblePastYears()),
    visibleYears: visiblePastYears(),
    followUpsScheduled,
    lastFollowUpsAt: String(getSetting('LAST_FOLLOWUPS_AT') || ''),
    remindersEnabled: String(getSetting('REMINDERS_ENABLED') || 'TRUE').toUpperCase() !== 'FALSE',
    reminderDays: Number(getSetting('REMINDER_DAYS') || 3) || 3,
    failedEmails,
    backups: backups.map((row) => ({ date: String(row.BACKUP_DATE), name: String(row.FILE_NAME), url: String(row.URL || ''), reason: String(row.REASON || '') }))
  };
}
