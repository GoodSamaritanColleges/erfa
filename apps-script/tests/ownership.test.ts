import { beforeEach, describe, expect, it, vi } from 'vitest';

const settings = new Map<string, string>();
const rows: Record<string, Array<Record<string, unknown>>> = { ARCHIVES: [] };
vi.mock('../src/store', () => ({
  all: (name: string) => rows[name] ?? [],
  getDatabase: () => ({ getId: () => 'db' }),
  getSetting: (k: string) => settings.get(k) ?? ''
}));

interface Node { id: string; name: string; owner: string; files: Node[]; folders: Node[]; parent?: Node; failSet?: boolean }
const byId = new Map<string, Node>();
const setCalls: string[] = [];
function node(id: string, name: string, owner = 'previous.owner@goodsam.edu.ph', extra: Partial<Node> = {}): Node {
  const n: Node = { id, name, owner, files: [], folders: [], ...extra };
  byId.set(id, n);
  return n;
}
const iter = <T>(items: T[]) => { let i = 0; return { hasNext: () => i < items.length, next: () => items[i++] }; };
function wrap(n: Node): Record<string, unknown> {
  return {
    getId: () => n.id, getName: () => n.name,
    getOwner: () => ({ getEmail: () => n.owner }),
    setOwner: (email: string) => { if (n.failSet) throw new Error('not allowed'); setCalls.push(n.id); n.owner = email; },
    getFiles: () => iter(n.files.map(wrap)), getFolders: () => iter(n.folders.map(wrap)),
    getParents: () => iter(n.parent ? [wrap(n.parent)] : []),
    getFoldersByName: (name: string) => iter(n.folders.filter((f) => f.name === name).map(wrap))
  };
}

beforeEach(() => {
  settings.clear(); byId.clear(); setCalls.length = 0; rows.ARCHIVES = [];
  const myDrive = node('root', 'My Drive');
  const backups = node('bk', 'eRFA Backups');
  const bk2026 = node('bk26', '2026');
  bk2026.files.push(node('bkfile', 'backup copy'));
  backups.folders.push(bk2026);
  myDrive.folders.push(backups, node('other', 'Unrelated folder'));
  node('db', 'eRFA Database', 'previous.owner@goodsam.edu.ph', { parent: myDrive });
  const attachments = node('att', 'eRFA');
  const year = node('y26', '2026');
  const rfa = node('rfa1', 'RFA-2026-0001');
  rfa.files.push(node('pdf1', 'quote.pdf'), node('pdf2', 'already.pdf', 'erfa@goodsam.edu.ph'));
  year.folders.push(rfa);
  attachments.folders.push(year);
  settings.set('ATTACHMENT_ROOT_FOLDER_ID', 'att');
  node('arch', 'eRFA Archive SY 2024–2025');
  rows.ARCHIVES = [{ SPREADSHEET_ID: 'arch' }, { SPREADSHEET_ID: '' }];
  node('script', 'eRFA backend');
  vi.stubGlobal('DriveApp', {
    getFileById: (id: string) => { const n = byId.get(id); if (!n) throw new Error('missing'); return wrap(n); },
    getFolderById: (id: string) => wrap(byId.get(id)!)
  });
  vi.stubGlobal('ScriptApp', { getScriptId: () => 'script' });
});

describe('ownership hand-over', () => {
  it('hands over only eRFA files, script last, skipping ones already owned', async () => {
    const { transferOwnership } = await import('../src/ownership');
    const result = transferOwnership('ERFA@goodsam.edu.ph');
    expect(result.finished).toBe(true);
    expect(result.failed).toEqual([]);
    expect(result.alreadyOwned).toBe(1);
    expect(new Set(setCalls)).toEqual(new Set(['db', 'bk', 'bk26', 'bkfile', 'att', 'y26', 'rfa1', 'pdf1', 'arch', 'script']));
    expect(setCalls[setCalls.length - 1]).toBe('script');
    expect(setCalls).not.toContain('root');
    expect(setCalls).not.toContain('other');
    expect(byId.get('db')!.owner).toBe('erfa@goodsam.edu.ph');
  });

  it('a preview changes nothing; a second run finds everything already handed over', async () => {
    const { transferOwnership } = await import('../src/ownership');
    const preview = transferOwnership('erfa@goodsam.edu.ph', { dryRun: true });
    expect(setCalls).toEqual([]);
    expect(preview.transferred).toBe(10);
    transferOwnership('erfa@goodsam.edu.ph');
    const again = transferOwnership('erfa@goodsam.edu.ph');
    expect(again.transferred).toBe(0);
    expect(again.alreadyOwned).toBe(11);
  });

  it('keeps going past a file that cannot be handed over, and stops cleanly near the time limit', async () => {
    const { transferOwnership } = await import('../src/ownership');
    byId.get('pdf1')!.failSet = true;
    const result = transferOwnership('erfa@goodsam.edu.ph');
    expect(result.failed.map((f) => f.id)).toEqual(['pdf1']);
    expect(setCalls).toContain('script');

    let t = 0;
    const slow = transferOwnership('someone@goodsam.edu.ph', { now: () => (t += 60_000) });
    expect(slow.finished).toBe(false);
    expect(slow.message).toMatch(/run it again/);
    expect(byId.get('script')!.owner).not.toBe('someone@goodsam.edu.ph');
  });
});
