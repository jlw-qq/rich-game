/**
 * 服务器存盘：每个房间一个 JSON 文件（<房间码>.json）。
 * 写入时先写临时文件再改名，写到一半断电或崩溃，原文件仍然完整。
 * 同一个房间的写入排队进行，只保留最新的一份待写内容，频繁更新时不会堆积。
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

/** 只认房间码命名的文件，其他文件一概不碰 */
const FILE = /^[23456789A-HJKMNP-Z]{4}\.json$/;
/** 单个房间存档的上限，超过视为损坏 */
const MAX_FILE_BYTES = 2_000_000;

/** @param {string} dir */
export function createRoomStore(dir) {
  mkdirSync(dir, { recursive: true });
  /** 房间码 → { writing, next }：next 为 undefined 表示没有待写内容，null 表示要删除 */
  const queues = new Map();

  async function drain(code) {
    const q = queues.get(code);
    if (q.writing) return;
    q.writing = true;
    while (q.next !== undefined) {
      const snap = q.next;
      q.next = undefined;
      const file = join(dir, `${code}.json`);
      try {
        if (snap === null) await rm(file, { force: true });
        else {
          const tmp = `${file}.tmp`;
          await writeFile(tmp, JSON.stringify(snap));
          await rename(tmp, file);
        }
      } catch (err) {
        console.error(`房间 ${code} 存盘失败`, err);
      }
    }
    q.writing = false;
    queues.delete(code);
  }

  return {
    /** 读回所有房间。读不了的文件返回错误原因，由调用方决定怎么处理 */
    loadAll() {
      return readdirSync(dir)
        .filter((name) => FILE.test(name))
        .map((name) => {
          try {
            const text = readFileSync(join(dir, name), 'utf8');
            if (text.length > MAX_FILE_BYTES) return { name, error: '文件太大' };
            return { name, snapshot: JSON.parse(text) };
          } catch (err) {
            return { name, error: `读不了：${err.message}` };
          }
        });
    },
    /** 把读不了的文件改名留底（.bad），不删除，也不再读 */
    quarantine(name) {
      if (!FILE.test(name)) return;
      try {
        renameSync(join(dir, name), join(dir, `${name}.${Date.now()}.bad`));
      } catch {
        rmSync(join(dir, name), { force: true });
      }
    },
    /** @param {string} code @param {object | null} snapshot null 表示删除 */
    save(code, snapshot) {
      if (!FILE.test(`${code}.json`)) return;
      const q = queues.get(code) ?? { writing: false, next: undefined };
      q.next = snapshot;
      queues.set(code, q);
      drain(code);
    },
    /** 等所有排队的写入完成（关闭服务器前调用） */
    async flush() {
      while (queues.size > 0) await new Promise((r) => setTimeout(r, 10));
    },
  };
}
