import { getDatabase, insert, nowIso } from './store';

/**
 * Backups are full copies of the database spreadsheet, kept forever in
 * "eRFA Backups/<year>" next to the database in Drive. Nothing here ever deletes a backup.
 */
const BACKUP_FOLDER = 'eRFA Backups';
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;

export function manilaToday(now = new Date()): string {
  return new Date(now.getTime() + MANILA_OFFSET_MS).toISOString().slice(0, 10);
}

function backupFolder(year: string): GoogleAppsScript.Drive.Folder {
  const parents = DriveApp.getFileById(getDatabase().getId()).getParents();
  const base = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
  const roots = base.getFoldersByName(BACKUP_FOLDER);
  const root = roots.hasNext() ? roots.next() : base.createFolder(BACKUP_FOLDER);
  const years = root.getFoldersByName(year);
  return years.hasNext() ? years.next() : root.createFolder(year);
}

/** Copy the whole database. `reason` is e.g. "Monthly", "before archive", "before reset". */
export function backupDatabase(reason: string): { id: string; name: string; url: string } {
  const today = manilaToday();
  const name = `eRFA Database backup ${today}${reason === 'Monthly' ? '' : ` (${reason})`}`;
  const source = DriveApp.getFileById(getDatabase().getId());
  let copy: GoogleAppsScript.Drive.File;
  try { copy = source.makeCopy(name, backupFolder(today.slice(0, 4))); }
  catch { copy = source.makeCopy(name); } // folder unavailable: still never skip the backup itself
  let url = '';
  try { url = copy.getUrl(); } catch { url = ''; }
  try { insert('BACKUPS', { BACKUP_DATE: nowIso(), FILE_NAME: name, FILE_ID: copy.getId(), URL: url, REASON: reason }); }
  catch { /* the copy exists even if the list could not be updated */ }
  return { id: copy.getId(), name, url };
}
