/**
 * 服务器存盘：读写、删除、坏文件留底、不碰无关文件。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRoomStore } from '../../server/storage.js';

const dirs = [];
function tempDir() {
  const d = mkdtempSync(join(tmpdir(), 'rich-rooms-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('房间存盘', () => {
  it('写入后能读回；连续写只留最新一份；删除后读不到', async () => {
    const dir = tempDir();
    const store = createRoomStore(dir);
    for (let i = 0; i < 20; i++) store.save('ABCD', { v: 1, n: i });
    store.save('WXYZ', { v: 1, n: 'w' });
    await store.flush();
    const loaded = createRoomStore(dir).loadAll();
    expect(loaded.map((x) => [x.name, x.snapshot.n]).sort()).toEqual([['ABCD.json', 19], ['WXYZ.json', 'w']]);
    // 没有残留的临时文件
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    store.save('ABCD', null);
    await store.flush();
    expect(createRoomStore(dir).loadAll().map((x) => x.name)).toEqual(['WXYZ.json']);
  });

  it('只认房间码命名的文件；房间码不合法时不写', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'notes.txt'), 'hi');
    writeFileSync(join(dir, 'abcd.json'), '{}');
    const store = createRoomStore(dir);
    store.save('../../evil', { v: 1 });
    store.save('AB1D', { v: 1 });
    await store.flush();
    expect(store.loadAll()).toEqual([]);
    expect(readdirSync(dir).sort()).toEqual(['abcd.json', 'notes.txt']);
  });

  it('读不了的文件报原因，留底改名后不再读', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'ABCD.json'), '{broken');
    const store = createRoomStore(dir);
    const [r] = store.loadAll();
    expect(r.name).toBe('ABCD.json');
    expect(r.error).toContain('读不了');
    store.quarantine('ABCD.json');
    expect(store.loadAll()).toEqual([]);
    expect(readdirSync(dir).some((f) => f.startsWith('ABCD.json.') && f.endsWith('.bad'))).toBe(true);
    // 留底只接受房间码文件名
    store.quarantine('../x');
  });
});
