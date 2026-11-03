/**
 * 逻辑层：分享链接的参数（纯函数，不读写地址栏）。
 *
 * 挑战链接：?c=挑战码&by=名字&s=名次.人数.总资产.轮数.是否破产，朋友打开后可以玩同一局，打完和你比成绩。
 * 邀请链接：?room=房间码，朋友打开后直接进入「和朋友联机」并填好房间码。
 *
 * 参数来自别人发来的链接，一律当作不可信输入：任何一项不合法就丢掉这一项，不会让页面出错。
 * 成绩是对方本机算出来的，无法核实，只用于比较。
 */
import { decodeChallenge } from './challenge.js';
import { isChallengeScore, isBetterScore } from '../core/results.js';
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, normalizeRoomCode } from '../net/protocol.js';

/** 名字最多几个字（和开局页、联机的名字框一致） */
export const MAX_SHARE_NAME = 12;
/** 分享链接用到的参数名；打开后从地址栏清掉 */
export const SHARE_PARAMS = ['c', 'by', 's', 'room'];

/**
 * @typedef {{ rank: number, players: number, bankrupt: boolean, netWorth: number, round: number }} Score
 */

/**
 * 生成挑战链接的查询字符串（不带 ?）。没有成绩时只带挑战码。
 * @param {{ code: string, by?: string, score?: Score | null }} share
 */
export function encodeChallengeLink({ code, by = '', score = null }) {
  const params = new URLSearchParams({ c: code });
  const name = cleanName(by);
  if (score && name) params.set('by', name);
  if (score) params.set('s', [score.rank, score.players, score.netWorth, score.round, score.bankrupt ? 1 : 0].join('.'));
  return params.toString();
}

/** 邀请链接的查询字符串（不带 ?） */
export function encodeRoomLink(code) {
  return new URLSearchParams({ room: code }).toString();
}

/**
 * 解析地址栏的查询字符串。
 * @param {string} search location.search（可带 ?）
 * @returns {{
 *   challenge: { code: string, config: object, by: string | null, score: Score | null } | null,
 *   room: string | null,
 *   error: string | null,
 * }} error：链接里有分享参数但挑战码或房间码无效时给出的提示
 */
export function parseShareParams(search) {
  const params = new URLSearchParams(typeof search === 'string' ? search : '');
  let challenge = null;
  let room = null;
  let error = null;

  const c = params.get('c');
  if (c !== null) {
    const r = decodeChallenge(c);
    if (r.ok) {
      const score = parseScore(params.get('s'));
      challenge = {
        code: r.code,
        config: r.config,
        // 成绩的人数要和挑战码一致，否则是拼错或改过的链接
        score: score && score.players === r.config.kinds.length ? score : null,
        by: null,
      };
      // 名字只在有成绩时才有意义（「小红邀请你挑战：第 1 名……」）
      if (challenge.score) challenge.by = cleanName(params.get('by')) || null;
    } else error = `链接里的挑战码无效：${r.error}`;
  }

  const roomText = params.get('room');
  if (roomText !== null) {
    const code = normalizeRoomCode(roomText.slice(0, 16));
    if (code.length === ROOM_CODE_LENGTH && [...code].every((ch) => ROOM_CODE_ALPHABET.includes(ch))) room = code;
    else error ??= '链接里的房间码无效';
  }
  return { challenge, room, error };
}

/**
 * 你和对方的成绩比较（同一个挑战码）。
 * @param {Score} mine
 * @param {Score} theirs
 * @returns {'win' | 'lose' | 'tie'}
 */
export function compareScores(mine, theirs) {
  if (isBetterScore(mine, theirs) && !isBetterScore(theirs, mine)) return 'win';
  if (isBetterScore(theirs, mine) && !isBetterScore(mine, theirs)) return 'lose';
  return 'tie';
}

/** 名字：去掉控制字符、零宽和方向控制字符以及两端空白，超长截断；空的返回 '' */
function cleanName(v) {
  if (typeof v !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const text = v.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '').trim();
  return [...text].slice(0, MAX_SHARE_NAME).join('').trim();
}

/** 「名次.人数.总资产.轮数.是否破产」→ 成绩；任何一项不合法返回 null */
function parseScore(v) {
  if (typeof v !== 'string' || v.length > 40 || !/^\d+(\.\d+){4}$/.test(v)) return null;
  const [rank, players, netWorth, round, bankrupt] = v.split('.').map(Number);
  if (bankrupt > 1) return null;
  const score = { rank, players, bankrupt: bankrupt === 1, netWorth, round };
  return isChallengeScore(score) && Number.isSafeInteger(netWorth) ? score : null;
}
