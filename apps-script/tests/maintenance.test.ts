import { beforeEach, describe, expect, it, vi } from 'vitest';

const settings = new Map<string, string>();
const rows: Record<string, Array<Record<string, unknown>>> = { BACKUPS: [], USERS: [] };
const sent: Array<{ to: string; subject: string }> = [];
const copies: Array<{ name: string; folder: string }> = [];
const createdFolders: string[] = [];
const triggers: Array<{ handler: string; day: number; hour: number }> = [];
const archiveCalls: string[] = [];

vi.mock('../src/store', () => ({
  all: (name: string) => (rows[name] ?? []).map((r) => ({ ...r })),
  getDatabase: () => ({ getId: () => 'db' }),
  getSetting: (k: string) => settings.get(k) ?? '',
  setSetting: (k: string, v: string) => { settings.set(k, v); },
  settingBoolean: (k: string) => (settings.get(k) ?? '').toUpperCase() === 'TRUE',
  insert: (name: string, record: Record<string, unknown>) => { (rows[name] ??= []).push(record); },
  nowIso: () => new Date().toISOString()
}));
vi.mock('../src/audit', () => ({ audit: vi.fn() }));
vi.mock('../src/archive', () => ({
  archivePastSchoolYears: (actor: { FULL_NAME: string }) => { archiveCalls.push(actor.FULL_NAME); return { message: 'Archived 3 RFAs: SY 2025–2026 (3).' }; },
  currentSchoolYear: () => 2026,
  schoolYearLabel: (y: number) => `SY ${y}–${y + 1}`,
  visiblePastYears: () => Number(settings.get('VISIBLE_PAST_SCHOOL_YEARS') || 2)
}));

function folder(name: string): Record<string, unknown> {
  const children = new Map<string, Record<string, unknown>>();
  return {
    name,
    getFoldersByName: (n: string) => { const f = children.get(n); return { hasNext: () => Boolean(f), next: () => f }; },
    createFolder: (n: string) => { createdFolders.push(`${name}/${n}`); const f = folder(`${name}/${n}`); children.set(n, f); return f; }
  };
}
const dbFolder = folder('Shared/eRFA');

beforeEach(() => {
  settings.clear(); rows.BACKUPS = []; rows.USERS = [{ EMAIL: 'admin@x.edu', IS_ADMIN: true, ACTIVE: true }, { EMAIL: 'staff@x.edu', IS_ADMIN: false, ACTIVE: true }];
  sent.length = 0; copies.length = 0; triggers.length = 0; archiveCalls.length = 0;
  settings.set('EMAIL_ENABLED', 'TRUE');
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-12-01T02:00:00+08:00'));
  vi.stubGlobal('DriveApp', {
    getFileById: () => ({
      getParents: () => ({ hasNext: () => true, next: () => dbFolder }),
      makeCopy: (name: string, target?: { name: string }) => { copies.push({ name, folder: target?.name ?? '(none)' }); return { getId: () => `copy${copies.length}`, getUrl: () => `https://drive/copy${copies.length}` }; }
    }),
    getRootFolder: () => folder('My Drive')
  });
  vi.stubGlobal('MailApp', { sendEmail: (m: { to: string; subject: string }) => { sent.push(m); } });
  const trigger = (handler: string) => {
    const t = { day: 0, hour: 0 };
    const builder = { timeBased: () => builder, onMonthDay: (d: number) => { t.day = d; return builder; }, everyDays: (n: number) => { t.day = -n; return builder; }, atHour: (h: number) => { t.hour = h; return builder; }, inTimezone: () => builder, create: () => { triggers.push({ handler, ...t }); return {}; } };
    return builder;
  };
  vi.stubGlobal('ScriptApp', { getProjectTriggers: () => [], deleteTrigger: vi.fn(), newTrigger: trigger });
});

describe('automatic maintenance', () => {
  it('saves the monthly backup in a per-year folder, never deletes, records it and emails admins only', async () => {
    const { runMonthlyBackupJob } = await import('../src/maintenance');
    const first = runMonthlyBackupJob();
    vi.setSystemTime(new Date('2027-01-01T02:00:00+08:00'));
    runMonthlyBackupJob();
    expect(first).toMatchObject({ ok: true, name: 'eRFA Database backup 2026-12-01' });
    expect(copies).toEqual([
      { name: 'eRFA Database backup 2026-12-01', folder: 'Shared/eRFA/eRFA Backups/2026' },
      { name: 'eRFA Database backup 2027-01-01', folder: 'Shared/eRFA/eRFA Backups/2027' }
    ]);
    expect(rows.BACKUPS).toHaveLength(2); // both kept and listed
    expect(sent.map((m) => m.to)).toEqual(['admin@x.edu', 'admin@x.edu']);
    expect(sent[0].subject).toBe('[eRFA] Monthly backup saved');
  });

  it('alerts admins when a backup fails', async () => {
    vi.stubGlobal('DriveApp', { getFileById: () => { throw new Error('Drive storage is full'); }, getRootFolder: () => folder('My Drive') });
    const { runMonthlyBackupJob } = await import('../src/maintenance');
    expect(runMonthlyBackupJob()).toMatchObject({ ok: false, error: 'Drive storage is full' });
    expect(sent[0].subject).toBe('[eRFA] Monthly backup FAILED');
  });

  it('runs the yearly archive only in the school-year start month (June)', async () => {
    const { runYearlyArchiveJob } = await import('../src/maintenance');
    expect(runYearlyArchiveJob(new Date('2026-11-15T03:00:00+08:00'))).toMatchObject({ skipped: true });
    expect(archiveCalls).toHaveLength(0);
    expect(runYearlyArchiveJob(new Date('2027-06-15T03:00:00+08:00'))).toMatchObject({ ok: true });
    expect(archiveCalls).toEqual(['eRFA automatic maintenance']);
    expect(sent[0].subject).toBe('[eRFA] Yearly archive finished');
  });

  it('installs both schedules once and makes a first backup', async () => {
    const { installAutomaticMaintenance, maintenanceStatus } = await import('../src/maintenance');
    installAutomaticMaintenance();
    expect(triggers).toEqual([{ handler: 'runMonthlyBackup', day: 1, hour: 2 }, { handler: 'runYearlyArchive', day: 15, hour: 3 }, { handler: 'runDailyFollowUps', day: -1, hour: 7 }]);
    expect(copies).toHaveLength(1);
    const status = maintenanceStatus();
    expect(status).toMatchObject({ enabled: true, backupOverdue: false, nextBackup: '2027-01-01', nextArchive: '2027-06-15', visibleFrom: 'SY 2024–2025' });
    expect((status.backups as unknown[]).length).toBe(1);
  });
});
