import { all, getDatabase, getSetting } from './store';

/**
 * One-time hand-over of every eRFA file in Drive to the school's eRFA account, so eRFA no
 * longer belongs to the person who set it up. Run from the Apps Script editor by the current
 * owner. Only files and folders eRFA uses are touched:
 *  - the database spreadsheet, the "eRFA Backups" folder next to it (everything inside),
 *  - the attachments folder (ATTACHMENT_ROOT_FOLDER_ID, everything inside),
 *  - the archive spreadsheets, and lastly this Apps Script project.
 * File IDs do not change, so no eRFA setting needs updating. The previous owner stays an editor.
 * Safe to run again: items already owned by the new owner are skipped, and a run that nears the
 * Apps Script time limit stops cleanly and says to run it again.
 */
export const NEW_OWNER_EMAIL = 'erfa@goodsam.edu.ph';
const BACKUP_FOLDER = 'eRFA Backups';
const TIME_BUDGET_MS = 5 * 60 * 1000;

type Item = GoogleAppsScript.Drive.File | GoogleAppsScript.Drive.Folder;
export interface OwnershipResult {
  newOwner: string; dryRun: boolean; finished: boolean;
  transferred: number; alreadyOwned: number; failed: Array<{ name: string; id: string; error: string }>;
  message: string;
}

export function transferOwnership(newOwner: string, options: { dryRun?: boolean; now?: () => number } = {}): OwnershipResult {
  const target = newOwner.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(target)) throw new Error(`Not an email address: ${newOwner}`);
  const now = options.now ?? (() => Date.now());
  const started = now();
  const dryRun = Boolean(options.dryRun);
  const seen = new Set<string>();
  const result: OwnershipResult = { newOwner: target, dryRun, finished: false, transferred: 0, alreadyOwned: 0, failed: [], message: '' };

  const hand = (item: Item): void => {
    const id = item.getId();
    if (seen.has(id)) return;
    seen.add(id);
    let owner = '';
    try { owner = String(item.getOwner()?.getEmail() || '').toLowerCase(); } catch { owner = ''; }
    if (owner === target) { result.alreadyOwned++; return; }
    if (dryRun) { result.transferred++; return; }
    try { item.setOwner(target); result.transferred++; }
    catch (error) { result.failed.push({ name: item.getName(), id, error: error instanceof Error ? error.message : String(error) }); }
  };
  const outOfTime = (): boolean => now() - started > TIME_BUDGET_MS;
  const handTree = (folder: GoogleAppsScript.Drive.Folder): boolean => {
    hand(folder);
    const files = folder.getFiles();
    while (files.hasNext()) { if (outOfTime()) return false; hand(files.next()); }
    const folders = folder.getFolders();
    while (folders.hasNext()) { if (outOfTime() || !handTree(folders.next())) return false; }
    return true;
  };

  const run = (): boolean => {
    const dbFile = DriveApp.getFileById(getDatabase().getId());
    hand(dbFile);
    const parents = dbFile.getParents();
    if (parents.hasNext()) {
      const backups = parents.next().getFoldersByName(BACKUP_FOLDER);
      while (backups.hasNext()) if (!handTree(backups.next())) return false;
    }
    const attachmentsId = getSetting('ATTACHMENT_ROOT_FOLDER_ID');
    if (attachmentsId && !handTree(DriveApp.getFolderById(attachmentsId))) return false;
    for (const archive of all('ARCHIVES')) {
      const id = String(archive.SPREADSHEET_ID || '');
      if (!id) continue;
      if (outOfTime()) return false;
      try { hand(DriveApp.getFileById(id)); }
      catch (error) { result.failed.push({ name: 'archive spreadsheet', id, error: error instanceof Error ? error.message : String(error) }); }
    }
    // The project itself goes last, so an interrupted run leaves it with the person running it.
    hand(DriveApp.getFileById(ScriptApp.getScriptId()));
    return true;
  };

  result.finished = run();
  const verb = dryRun ? 'would be handed over' : 'handed over';
  result.message = `${result.transferred} item(s) ${verb} to ${target}; ${result.alreadyOwned} already theirs; ${result.failed.length} failed.`
    + (result.finished ? '' : ' Stopped before the time limit: run it again to continue.');
  return result;
}
