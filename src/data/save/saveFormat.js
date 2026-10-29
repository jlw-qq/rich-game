/**
 * 数据层：存档格式与存取。只负责序列化、完整性校验和读写存储，不理解游戏规则
 * （对局数据是否合法由 logic/core/stateValidator.js 判断）。
 *
 * 存档结构：{ format, version, savedAt, checksum, state }
 * checksum 只用来发现存档被截断或手动改过，不是安全签名。
 */

export const SAVE_FORMAT = 'rich-game-save';
export const SAVE_VERSION = 1;
/** 存档文本长度上限，导入超大文件时直接拒绝 */
export const MAX_SAVE_LENGTH = 1_000_000;
export const DEFAULT_SAVE_KEY = 'rich-game:autosave';

const fail = (error) => ({ ok: false, error });

/** FNV-1a 32 位哈希，返回 8 位十六进制字符串 */
export function checksum(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * @param {object} state 可 JSON 序列化的对局状态
 * @param {{ savedAt?: number }} [options]
 * @returns {string}
 */
export function serializeSave(state, { savedAt = Date.now() } = {}) {
  return JSON.stringify({
    format: SAVE_FORMAT,
    version: SAVE_VERSION,
    savedAt,
    checksum: checksum(JSON.stringify(state)),
    state,
  });
}

/**
 * 解析存档文本并检查格式、版本和校验和。不检查对局内容。
 * @param {unknown} text
 * @returns {{ ok: true, state: object, savedAt: number | null } | { ok: false, error: string }}
 */
export function parseSave(text) {
  if (typeof text !== 'string' || text.length === 0) return fail('存档为空');
  if (text.length > MAX_SAVE_LENGTH) return fail('存档文件过大');

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return fail('存档不是有效的 JSON');
  }
  if (!data || typeof data !== 'object' || data.format !== SAVE_FORMAT) return fail('这不是城市大富翁的存档');
  if (data.version !== SAVE_VERSION) return fail(`存档版本 ${data.version} 不兼容（当前版本 ${SAVE_VERSION}）`);
  if (!data.state || typeof data.state !== 'object' || Array.isArray(data.state)) return fail('存档缺少对局数据');
  if (checksum(JSON.stringify(data.state)) !== data.checksum) return fail('存档校验失败，可能已损坏或被修改');

  return { ok: true, state: data.state, savedAt: Number.isFinite(data.savedAt) ? data.savedAt : null };
}

/**
 * 包装一个 Web Storage 兼容的存储（localStorage 或测试用的假对象）。
 * 存储不可用、容量满等异常都转成返回值，不向外抛。
 * @param {{ getItem(k: string): string | null, setItem(k: string, v: string): void, removeItem(k: string): void } | null} storage
 * @param {string} [key]
 */
export function createSaveStore(storage, key = DEFAULT_SAVE_KEY) {
  /** @returns {{ ok: true } | { ok: false, error: string }} */
  function save(state) {
    if (!storage) return fail('浏览器不支持本地存储');
    try {
      storage.setItem(key, serializeSave(state));
      return { ok: true };
    } catch (err) {
      return fail(`自动存档失败：${err?.message ?? err}`);
    }
  }

  /** @returns {null | ReturnType<typeof parseSave>} null 表示没有存档 */
  function load() {
    if (!storage) return null;
    let text;
    try {
      text = storage.getItem(key);
    } catch (err) {
      return fail(`读取存档失败：${err?.message ?? err}`);
    }
    return text === null ? null : parseSave(text);
  }

  function clear() {
    try {
      storage?.removeItem(key);
    } catch {
      // 存储不可用时没有可删的东西
    }
  }

  return { save, load, clear };
}
