/**
 * 数据层：挑战最好成绩的本机记录，按挑战码存。只负责读写，记录是否合法、哪个更好由逻辑层判断。
 * 存储不可用、读写抛错或数据损坏时都当作没有记录，不影响游戏。
 */

export const DEFAULT_RECORDS_KEY = 'rich-game:challenge-best';
/** 最多保留的挑战码条数，超出时丢掉最早写入的 */
export const MAX_RECORDS = 50;

/**
 * @param {Storage | null} storage
 * @param {string} [key]
 */
export function createRecordStore(storage, key = DEFAULT_RECORDS_KEY) {
  function readAll() {
    try {
      const data = JSON.parse(storage?.getItem(key) ?? '{}');
      return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    } catch {
      return {};
    }
  }

  return {
    /** @param {string} code @returns {unknown} 原样返回，可能为 undefined */
    get(code) {
      const all = readAll();
      return Object.hasOwn(all, code) ? all[code] : undefined;
    },
    /**
     * @param {string} code
     * @param {object} record
     * @returns {boolean} 是否写入成功
     */
    set(code, record) {
      const all = readAll();
      delete all[code];
      all[code] = record;
      const keys = Object.keys(all);
      for (const k of keys.slice(0, Math.max(0, keys.length - MAX_RECORDS))) delete all[k];
      try {
        storage?.setItem(key, JSON.stringify(all));
        return Boolean(storage);
      } catch {
        return false;
      }
    },
  };
}
