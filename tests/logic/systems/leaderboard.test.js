/**
 * 逻辑层：每日挑战排行榜的排名、去重、截断、日期规则。
 */
import { describe, it, expect } from 'vitest';
import {
  checkBoard,
  cleanNickname,
  emptyBoard,
  isAcceptedDate,
  isExpired,
  MAX_ENTRIES,
  PUBLIC_ENTRIES,
  publicBoard,
  submitScore,
  utcDateKey,
} from '../../../src/logic/systems/leaderboard.js';

const score = (rank, netWorth, round = 20, bankrupt = false) => ({ rank, players: 4, bankrupt, netWorth, round });
const entry = (entryId, s, at = 0, name = entryId) => ({ entryId, name, score: s, at });

describe('上榜', () => {
  it('按名次、总资产、轮数排；完全一样时先交的在前', () => {
    let b = emptyBoard('2026-11-03');
    for (const e of [entry('a', score(2, 30000), 1), entry('b', score(1, 20000), 2), entry('c', score(1, 25000), 3), entry('d', score(1, 25000, 18), 4), entry('e', score(1, 25000, 18), 5)]) {
      b = submitScore(b, e).board;
    }
    expect(b.entries.map((e) => e.entryId)).toEqual(['d', 'e', 'c', 'b', 'a']);
    expect(b.total).toBe(5);
  });

  it('同一台设备只留最好的一次：更好就替换，更差或一样不变（但会告诉你现在的名次）', () => {
    let b = submitScore(emptyBoard('d'), entry('x', score(2, 20000), 1)).board;
    b = submitScore(b, entry('y', score(1, 26000), 2)).board;
    const worse = submitScore(b, entry('x', score(3, 9000), 3));
    expect(worse).toMatchObject({ improved: false, rank: 2 });
    expect(worse.board.entries).toBe(b.entries);
    const better = submitScore(b, entry('x', score(1, 30000), 4));
    expect(better).toMatchObject({ improved: true, rank: 1 });
    expect(better.board.entries.map((e) => e.entryId)).toEqual(['x', 'y']);
    expect(better.board.total).toBe(2);
  });

  it('成绩没进步时可以改昵称', () => {
    const b = submitScore(emptyBoard('d'), entry('x', score(1, 20000), 1, '旧名')).board;
    const r = submitScore(b, entry('x', score(4, 0), 2, '新名'));
    expect(r.improved).toBe(false);
    expect(r.board.entries[0]).toMatchObject({ name: '新名', score: score(1, 20000) });
  });

  it(`最多留 ${MAX_ENTRIES} 条；掉出榜时名次为 null，人数照算`, () => {
    let b = emptyBoard('d');
    for (let i = 0; i < MAX_ENTRIES; i++) b = submitScore(b, entry(`e${i}`, score(1, 30000 - i), i)).board;
    const r = submitScore(b, entry('late', score(4, 0), 999));
    expect(r.rank).toBeNull();
    expect(r.board.entries).toHaveLength(MAX_ENTRIES);
    expect(r.board.total).toBe(MAX_ENTRIES + 1);
    // 公开的只有前 PUBLIC_ENTRIES 名，不带提交时间
    const pub = publicBoard(r.board);
    expect(pub.entries).toHaveLength(PUBLIC_ENTRIES);
    expect(pub.entries[0]).toEqual({ rank: 1, entryId: 'e0', name: 'e0', score: score(1, 30000) });
    expect(pub.total).toBe(MAX_ENTRIES + 1);
  });

  it('不修改传入的榜单', () => {
    const b = emptyBoard('d');
    submitScore(b, entry('x', score(1, 1)));
    expect(b).toEqual(emptyBoard('d'));
  });
});

describe('日期', () => {
  const now = Date.parse('2026-11-03T10:00:00Z');

  it('只收服务器 UTC 日期前后一天', () => {
    expect(utcDateKey(now)).toBe('2026-11-03');
    expect(['2026-11-02', '2026-11-03', '2026-11-04'].map((d) => isAcceptedDate(d, now))).toEqual([true, true, true]);
    expect(['2026-11-01', '2026-11-05', '2026-13-01', 'x'].map((d) => isAcceptedDate(d, now))).toEqual([false, false, false, false]);
  });

  it('保留 30 天', () => {
    expect(isExpired('2026-10-04', now)).toBe(false);
    expect(isExpired('2026-10-03', now)).toBe(true);
    expect(isExpired('bad', now)).toBe(true);
  });
});

describe('昵称和读回的文件', () => {
  it('昵称去掉控制字符、方向控制和零宽字符，最多 12 个字', () => {
    expect(cleanNickname(' 小\u0000红‮​﻿ ')).toBe('小红');
    expect(cleanNickname('一二三四五六七八九十甲乙丙')).toBe('一二三四五六七八九十甲乙');
    expect(cleanNickname('   ')).toBe('');
    expect(cleanNickname(42)).toBe('');
  });

  it('榜单文件被改坏时不用', () => {
    const good = submitScore(emptyBoard('2026-11-03'), entry('x', score(1, 1))).board;
    expect(checkBoard(good, '2026-11-03')).toBe(good);
    expect(checkBoard(good, '2026-11-04')).toBeNull();
    expect(checkBoard({ ...good, total: 0 }, '2026-11-03')).toBeNull();
    expect(checkBoard({ ...good, entries: [{ entryId: 'x', name: 'x', score: { rank: 0 }, at: 0 }] }, '2026-11-03')).toBeNull();
    expect(checkBoard(null, '2026-11-03')).toBeNull();
  });
});
