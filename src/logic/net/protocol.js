/**
 * 逻辑层：联网消息格式。浏览器和服务器共用。
 * 客户端发来的每条消息都先经过 parseClientMessage：检查长度、JSON、版本、类型和字段，
 * 只把认识的字段拷进新对象，后面的代码拿到的一定是干净的数据。
 *
 * 客户端 → 服务器：{ v, t, ...字段 }
 *   create { name }            建房，自己坐 1 号位并成为房主
 *   join { code, name }        凭房间码加入，坐第一个空位
 *   leave {}                   离开房间
 *   setMode { mode }           房主改模式
 *   setSeat { index, kind }    房主改座位：open 空位 / closed 关闭 / normal、easy AI
 *   start {}                   房主开始（不能还有空位）
 * 服务器 → 客户端：
 *   room { room }              房间最新情况，见 room.js 的 roomView
 *   started { state, you }     对局开始：初始状态和你的玩家 id
 *   left {}                    已离开房间
 *   error { message }          操作被拒绝的原因
 */

export const PROTOCOL_VERSION = 1;
/** 单条消息的上限（字节）。现在的消息都很短，后面的交易消息也远小于这个数 */
export const MAX_MESSAGE_BYTES = 4096;
/** 房间码：4 位，去掉容易看混的 0 1 I L O */
export const ROOM_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const ROOM_CODE_LENGTH = 4;
/** 房主能设置的座位类型（human 只能由玩家加入产生） */
export const SEAT_SETTINGS = ['open', 'closed', 'normal', 'easy'];

const fail = (error) => ({ ok: false, error });
const isStr = (v, max) => typeof v === 'string' && v.length <= max;

/** 每种消息：字段名 → 检查函数 */
const SCHEMAS = {
  create: { name: (v) => isStr(v, 40) },
  join: { code: (v) => isStr(v, 16), name: (v) => isStr(v, 40) },
  leave: {},
  setMode: { mode: (v) => isStr(v, 20) },
  setSeat: { index: (v) => Number.isInteger(v) && v >= 0 && v < 16, kind: (v) => SEAT_SETTINGS.includes(v) },
  start: {},
};
export const CLIENT_MESSAGE_TYPES = Object.keys(SCHEMAS);

/**
 * @param {unknown} text 收到的原始文本
 * @returns {{ ok: true, msg: { t: string } & Record<string, unknown> } | { ok: false, error: string }}
 */
export function parseClientMessage(text) {
  if (typeof text !== 'string') return fail('消息必须是文本');
  // 按 UTF-8 最坏情况估算字节数，不用分配内存
  if (text.length * 3 > MAX_MESSAGE_BYTES && new TextEncoder().encode(text).length > MAX_MESSAGE_BYTES) return fail('消息太长');
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return fail('消息不是有效的 JSON');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return fail('消息格式无效');
  if (data.v !== PROTOCOL_VERSION) return fail('游戏版本不一致，请刷新页面');
  if (typeof data.t !== 'string' || !Object.hasOwn(SCHEMAS, data.t)) return fail(`未知消息类型: ${String(data.t).slice(0, 20)}`);
  const msg = { t: data.t };
  for (const [key, check] of Object.entries(SCHEMAS[data.t])) {
    if (!check(data[key])) return fail(`消息字段无效: ${key}`);
    msg[key] = data[key];
  }
  return { ok: true, msg };
}

/** 玩家输入的房间码：去空白、转大写 */
export function normalizeRoomCode(text) {
  return String(text).replace(/\s/g, '').toUpperCase();
}
