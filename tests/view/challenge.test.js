/**
 * 表现层：挑战成绩与分享文字。
 */
import { describe, it, expect } from 'vitest';
import { dateLabel, scoreText, shareText } from '../../src/view/ui/format.js';

describe('挑战文字', () => {
  const score = { rank: 2, players: 4, bankrupt: false, netWorth: 23400, round: 25 };

  it('成绩一行字', () => {
    expect(scoreText(score)).toBe('第 2/4 名 · 总资产 23,400 元 · 25 轮');
    expect(scoreText({ ...score, rank: 4, bankrupt: true, netWorth: 0 })).toBe('第 4/4 名 · 已破产 · 25 轮');
  });

  it('分享文字带挑战码；每日挑战写明日期', () => {
    expect(dateLabel('2026-01-05')).toBe('1 月 5 日');
    expect(shareText({ code: 'CR-AAAA-BBBB-CCCC', daily: '2026-10-30', score })).toBe(
      '城市大富翁 · 10 月 30 日每日挑战\n挑战码 CR-AAAA-BBBB-CCCC\n我的成绩：第 2/4 名 · 总资产 23,400 元 · 25 轮',
    );
    expect(shareText({ code: 'CR-AAAA-BBBB-CCCC', daily: null, score }).split('\n')[0]).toBe('城市大富翁 · 挑战');
  });
});
