/**
 * 逻辑层：挑战码与每日挑战，不需要服务器。
 * 同一个种子加同一套开局配置，开局分地、牌堆、骰子、城市事件和 AI 的选择都完全一样，
 * 所以把配置和种子编成一串短码，别人输入后就能玩到同一局。
 *
 * 挑战码 60 位，用 Crockford Base32 写成 12 个字符（不含容易看混的 I L O U），显示为 CR-XXXX-XXXX-XXXX。
 * 位布局（高位在前）：版本 3 | 模式 1 | 人数-2 2 | 座位类型 5×2 | 种子 32 | 校验 12
 * 校验只用来发现抄错，不是防篡改签名。
 */
import { DAILY_CHALLENGE, SEAT_NAMES, SOLO_HUMAN_NAME } from '../../data/config/challenge.js';

export const CHALLENGE_VERSION = 1;
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const PREFIX = 'CR';
const BODY_LENGTH = 12;
/** 输入框里粘贴的内容超过这个长度直接拒绝 */
const MAX_INPUT_LENGTH = 40;
/** 模式在挑战码里的编号，只能在末尾追加 */
export const CHALLENGE_MODES = ['quick', 'classic'];
/** 座位类型：人类 / 普通 AI / 简单 AI，编号同样只能追加 */
export const SEAT_KINDS = ['human', 'normal', 'easy'];
const MIN_SEATS = 2;
const MAX_SEATS = 5;

const fail = (error) => ({ ok: false, error });
const isUint32 = (v) => Number.isInteger(v) && v >= 0 && v <= 0xffffffff;

/** FNV-1a 32 位 */
function fnv1a(bytes) {
  let h = 0x811c9dc5;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 48 位数据 → 12 位校验 */
function check(data) {
  const bytes = Array.from({ length: 6 }, (_, i) => Number((data >> BigInt(8 * (5 - i))) & 0xffn));
  const h = fnv1a(bytes);
  return (h ^ (h >>> 12) ^ (h >>> 24)) & 0xfff;
}

/** @param {{ isAI: boolean, aiLevel?: string | null }[]} players */
export function seatKinds(players) {
  return players.map((p) => (p?.isAI ? p.aiLevel : 'human'));
}

/**
 * @param {{ mode: string, kinds: string[], seed: number }} config
 * @returns {string} 形如 CR-XXXX-XXXX-XXXX
 */
export function encodeChallenge({ mode, kinds, seed }) {
  const m = CHALLENGE_MODES.indexOf(mode);
  if (m < 0) throw new RangeError(`挑战码不支持的模式: ${mode}`);
  if (!Array.isArray(kinds) || kinds.length < MIN_SEATS || kinds.length > MAX_SEATS) {
    throw new RangeError(`挑战码人数必须在 ${MIN_SEATS}–${MAX_SEATS} 之间`);
  }
  const k = kinds.map((x) => SEAT_KINDS.indexOf(x));
  if (k.some((v) => v < 0)) throw new RangeError(`挑战码不支持的玩家类型: ${kinds.join(',')}`);
  if (!isUint32(seed)) throw new RangeError(`挑战码种子必须是 32 位无符号整数: ${seed}`);

  let data = BigInt(CHALLENGE_VERSION);
  data = (data << 1n) | BigInt(m);
  data = (data << 2n) | BigInt(kinds.length - MIN_SEATS);
  for (let i = 0; i < MAX_SEATS; i++) data = (data << 2n) | BigInt(k[i] ?? 0);
  data = (data << 32n) | BigInt(seed);
  const value = (data << 12n) | BigInt(check(data));

  let body = '';
  for (let i = BODY_LENGTH - 1; i >= 0; i--) body += ALPHABET[Number((value >> BigInt(5 * i)) & 31n)];
  return `${PREFIX}-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8)}`;
}

/**
 * 解析玩家输入的挑战码。不区分大小写，可以不带 CR 和横线，O 当 0、I/L 当 1。
 * @param {unknown} text
 * @returns {{ ok: true, code: string, config: { mode: string, kinds: string[], seed: number } } | { ok: false, error: string }}
 *   code 是规范写法
 */
export function decodeChallenge(text) {
  if (typeof text !== 'string' || text.trim() === '') return fail('请输入挑战码');
  if (text.length > MAX_INPUT_LENGTH) return fail('挑战码太长了');
  let body = text.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (body.length === PREFIX.length + BODY_LENGTH && body.startsWith(PREFIX)) body = body.slice(PREFIX.length);
  if (body.length !== BODY_LENGTH) return fail(`挑战码应为 ${BODY_LENGTH} 位（不算开头的 CR 和横线），现在是 ${body.length} 位`);
  const bad = [...body].find((c) => !ALPHABET.includes(c));
  if (bad) return fail(`挑战码含有无效字符：${bad}`);

  let value = 0n;
  for (const c of body) value = (value << 5n) | BigInt(ALPHABET.indexOf(c));
  const data = value >> 12n;
  if (Number(value & 0xfffn) !== check(data)) return fail('挑战码校验不通过，可能抄错了');

  const bits = (from, width) => Number((data >> BigInt(from)) & ((1n << BigInt(width)) - 1n));
  const version = bits(45, 3);
  if (version > CHALLENGE_VERSION) return fail('这个挑战码来自更新版本的游戏，请刷新页面后再试');
  if (version !== CHALLENGE_VERSION) return fail('挑战码无效');
  const mode = CHALLENGE_MODES[bits(44, 1)];
  const count = bits(42, 2) + MIN_SEATS;
  const slots = Array.from({ length: MAX_SEATS }, (_, i) => bits(32 + 2 * (MAX_SEATS - 1 - i), 2));
  if (slots.slice(0, count).some((v) => v >= SEAT_KINDS.length)) return fail('挑战码里的玩家类型无效');
  // 多余的座位必须为 0，保证一局只有一种写法
  if (slots.slice(count).some((v) => v !== 0)) return fail('挑战码无效');
  const config = { mode, kinds: slots.slice(0, count).map((v) => SEAT_KINDS[v]), seed: bits(0, 32) };
  return { ok: true, code: encodeChallenge(config), config };
}

/**
 * 按挑战配置生成开局玩家。名字按座位取，只有一位人类时叫“你”。
 * @param {string[]} kinds
 */
export function challengePlayers(kinds) {
  const solo = kinds.filter((k) => k === 'human').length === 1;
  return kinds.map((kind, i) =>
    kind === 'human' ? { name: solo ? SOLO_HUMAN_NAME : SEAT_NAMES[i], isAI: false } : { name: SEAT_NAMES[i], isAI: true, aiLevel: kind },
  );
}

const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 本地日期 YYYY-MM-DD：每日挑战按玩家所在时区的日历日换题 */
export function localDateKey(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** @param {unknown} v */
export function isDateKey(v) {
  const m = typeof v === 'string' && DATE_KEY.exec(v);
  if (!m) return false;
  const [y, mo, d] = m.slice(1).map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/**
 * 某一天的每日挑战。同一天所有人拿到同一个种子。
 * @param {string} dateKey YYYY-MM-DD
 * @returns {{ mode: string, kinds: string[], seed: number }}
 */
export function dailyChallenge(dateKey) {
  if (!isDateKey(dateKey)) throw new RangeError(`日期格式无效: ${dateKey}`);
  const seed = fnv1a([...`rich-game-daily:${dateKey}`].map((c) => c.charCodeAt(0)));
  return { mode: DAILY_CHALLENGE.mode, kinds: [...DAILY_CHALLENGE.kinds], seed };
}

/**
 * 检查对局上记录的挑战信息。
 * @param {unknown} challenge { code, daily } 或 null
 * @param {{ mode: string, players: object[], seed?: number }} game seed 给出时还要求挑战码的种子与之一致
 * @returns {string[]}
 */
export function challengeErrors(challenge, { mode, players, seed }) {
  if (challenge === null) return [];
  if (!challenge || typeof challenge !== 'object' || Array.isArray(challenge)) return ['challenge 必须是对象或 null'];
  const errors = [];
  const decoded = decodeChallenge(challenge.code);
  if (!decoded.ok || decoded.code !== challenge.code) errors.push('挑战码无效');
  else {
    const { config } = decoded;
    if (config.mode !== mode || config.kinds.join() !== seatKinds(players).join()) errors.push('挑战码与对局设置不一致');
    if (seed !== undefined && config.seed !== seed >>> 0) errors.push('挑战码与对局种子不一致');
  }
  if (challenge.daily !== null && !isDateKey(challenge.daily)) errors.push('每日挑战日期无效');
  if (challenge.daily !== null && decoded.ok && isDateKey(challenge.daily)) {
    const expected = dailyChallenge(challenge.daily);
    if (encodeChallenge(expected) !== decoded.code) errors.push('挑战码不是这一天的每日挑战');
  }
  return errors;
}
