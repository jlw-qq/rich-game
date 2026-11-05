/**
 * 逻辑层：每日挑战排行榜（纯函数，不读写文件）。成绩由服务器重放得出（systems/replay.js），这里只负责排名。
 *
 * 一天一张榜：{ date, entries, total }。entries 按成绩从好到差，最多保留 MAX_ENTRIES 条；
 * total 是这一天上过榜的设备数（同一台设备只算一次，只保留最好的一次）。
 * 设备由浏览器随机生成的 deviceId 区分，榜上只存它的哈希 entryId，公开的数据里看不出原值。
 */
import { isBetterScore, isChallengeScore } from '../core/results.js';
import { isDateKey } from './challenge.js';

/** 每天保留多少条（公开时只给前 PUBLIC_ENTRIES 条） */
export const MAX_ENTRIES = 200;
export const PUBLIC_ENTRIES = 50;
/** 榜单保留多少天 */
export const KEEP_DAYS = 30;
/** 昵称最多几个字 */
export const MAX_NICKNAME = 12;

/**
 * @typedef {{ entryId: string, name: string, score: object, at: number }} Entry
 * @typedef {{ date: string, entries: Entry[], total: number }} Board
 */

/** 昵称：去掉控制、零宽和方向控制字符以及两端空白，超长截断；没剩下内容返回 '' */
export function cleanNickname(v) {
  if (typeof v !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const text = v.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, '').trim();
  return [...text].slice(0, MAX_NICKNAME).join('').trim();
}

/** 按 UTC 取日期 YYYY-MM-DD */
export function utcDateKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * 玩家本地的「今天」和服务器的 UTC 日期最多差一天（东八区早上 8 点前就是前一天），超出的不收。
 * @param {string} date
 * @param {number} now 服务器时间（毫秒）
 */
export function isAcceptedDate(date, now) {
  if (!isDateKey(date)) return false;
  const day = 86_400_000;
  return [now - day, now, now + day].some((t) => utcDateKey(t) === date);
}

/** 已经过了保留期的日期（按 UTC） */
export function isExpired(date, now) {
  if (!isDateKey(date)) return true;
  return Date.parse(`${date}T00:00:00Z`) < Date.parse(`${utcDateKey(now)}T00:00:00Z`) - KEEP_DAYS * 86_400_000;
}

/** 空榜 */
export function emptyBoard(date) {
  return { date, entries: [], total: 0 };
}

/** 读回来的榜单文件可能被改过或损坏，用之前先确认形状；不合格返回 null */
export function checkBoard(v, date) {
  if (!v || typeof v !== 'object' || v.date !== date || !Array.isArray(v.entries) || !Number.isInteger(v.total)) return null;
  const ok = v.entries.every(
    (e) => e && typeof e.entryId === 'string' && typeof e.name === 'string' && isChallengeScore(e.score) && Number.isFinite(e.at),
  );
  return ok && v.total >= v.entries.length ? v : null;
}

/** a 严格比 b 好（isBetterScore 在 b 为空时也返回 true，这里两边都有） */
const strictlyBetter = (a, b) => isBetterScore(a, b) && !isBetterScore(b, a);

/** 名次比较：成绩好的在前；完全一样时先上榜的在前 */
function compare(a, b) {
  if (strictlyBetter(a.score, b.score)) return -1;
  if (strictlyBetter(b.score, a.score)) return 1;
  return a.at - b.at;
}

/**
 * 交一份成绩。同一个 entryId 只留最好的一次；更差或相同的成绩不替换（但仍告诉你现在的名次）。
 * 不修改参数，返回新榜单。
 * @param {Board} board
 * @param {Entry} entry
 * @returns {{ board: Board, rank: number | null, improved: boolean, best: Entry }}
 *   rank：这台设备在榜上的名次（1 起）；掉出前 MAX_ENTRIES 时为 null。best：这台设备在榜上的那一条
 */
export function submitScore(board, entry) {
  const existing = board.entries.find((e) => e.entryId === entry.entryId);
  const improved = !existing || strictlyBetter(entry.score, existing.score);
  let entries = board.entries;
  let total = board.total;
  if (improved) {
    entries = [...entries.filter((e) => e.entryId !== entry.entryId), entry].sort(compare).slice(0, MAX_ENTRIES);
    // 新设备才增加人数；已在榜上（或掉出榜但曾经上过）的不重复算——掉出的无从得知，按新设备算
    if (!existing) total += 1;
  } else if (existing.name !== entry.name) {
    // 成绩没进步，但允许改昵称
    entries = entries.map((e) => (e.entryId === entry.entryId ? { ...e, name: entry.name } : e));
  }
  const index = entries.findIndex((e) => e.entryId === entry.entryId);
  const next = { date: board.date, entries, total };
  return { board: next, rank: index >= 0 ? index + 1 : null, improved, best: index >= 0 ? entries[index] : entry };
}

/**
 * 公开给网页的榜单：前 PUBLIC_ENTRIES 名，只给显示需要的字段。
 * @param {Board} board
 */
export function publicBoard(board) {
  return {
    date: board.date,
    total: board.total,
    entries: board.entries.slice(0, PUBLIC_ENTRIES).map((e, i) => ({ rank: i + 1, entryId: e.entryId, name: e.name, score: e.score })),
  };
}
