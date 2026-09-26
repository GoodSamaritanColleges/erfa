import { SHEETS } from './constants';
import { timed } from './performance';
import type { SheetRecord } from './types';

const ttl = { SETTINGS: 300, USERS: 60, DEPARTMENTS: 300 } as const;
type MasterSheet = keyof typeof ttl;
const schemaVersion = 'v1';

function isMaster(name: keyof typeof SHEETS): name is MasterSheet {
  return Object.prototype.hasOwnProperty.call(ttl, name);
}

function versionKey(name: MasterSheet): string { return `ERFA_MASTER_${schemaVersion}_${name}`; }

/** Cache is optional. Durable generation checks prevent an old reader from
 * repopulating the current cache after an administrator has changed a record.
 * Out-of-band Sheet edits are visible after TTL; application writes invalidate immediately.
 */
export function readMasterData<T extends SheetRecord>(name: keyof typeof SHEETS, source: () => T[]): T[] {
  if (!isMaster(name)) return source();
  let properties!: GoogleAppsScript.Properties.Properties;
  let cache!: GoogleAppsScript.Cache.Cache;
  let generation = '';
  let key = '';
  try {
    properties = PropertiesService.getScriptProperties();
    const databaseId = properties.getProperty('ERFA_SPREADSHEET_ID');
    generation = properties.getProperty(versionKey(name)) || 'initial';
    if (databaseId && !generation.startsWith('writing:')) {
      key = `master:${schemaVersion}:${databaseId}:${name}:${generation}`;
      cache = CacheService.getScriptCache();
      const stored = timed(`master.${name}.cacheGetMs`, () => cache.get(key));
      if (stored) {
        const rows: unknown = JSON.parse(stored);
        if (Array.isArray(rows) && rows.every((row) => row !== null && typeof row === 'object' &&
          SHEETS[name].every((field) => Object.prototype.hasOwnProperty.call(row, field) &&
            ['string', 'number', 'boolean'].includes(typeof row[field]))) &&
          (properties.getProperty(versionKey(name)) || 'initial') === generation) return rows as T[];
      }
    }
  } catch {
    // A failed/malformed cache must never become an authentication failure or source of truth.
    return source();
  }
  if (!key) return source();
  const rows = source();
  try {
    // Never publish data under a generation which changed while Sheets was being read.
    if ((properties.getProperty(versionKey(name)) || 'initial') === generation) {
      const serialized = JSON.stringify(rows);
      // Stay safely below CacheService's per-item byte limit, including non-ASCII text.
      if (serialized.length * 3 < 95000) cache.put(key, serialized, ttl[name]);
    }
  } catch { /* Cache write failures are harmless: Sheets already supplied the answer. */ }
  return rows;
}

/** All master writes pass through this helper. Publish a non-cacheable dirty
 * generation BEFORE writing. If the write/flush/final invalidation fails, it
 * remains dirty, so subsequent requests read Sheets rather than stale permissions.
 */
export function mutateMasterData(name: keyof typeof SHEETS, write: () => void): void {
  if (!isMaster(name)) { write(); return; }
  const properties = PropertiesService.getScriptProperties();
  const generation = Utilities.getUuid();
  properties.setProperty(versionKey(name), `writing:${generation}`);
  write();
  SpreadsheetApp.flush();
  properties.setProperty(versionKey(name), generation);
}
