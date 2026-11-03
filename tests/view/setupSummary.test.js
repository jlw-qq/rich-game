/**
 * 表现层：开局页「开短局」折叠时的阵容摘要（lineupSummary）。
 */
import { describe, it, expect } from 'vitest';
import { lineupSummary } from '../../src/view/ui/setup.js';

const NAMES = ['小红', '小蓝', '小黄', '小绿', '小紫'];

describe('阵容摘要', () => {
  it('默认阵容：你和 3 个普通 AI', () => {
    expect(lineupSummary(NAMES, ['human', 'normal', 'normal', 'normal', 'normal'], 4)).toBe('小红 + 3 个普通 AI · 4 人');
  });

  it('只看前 count 个座位；2 人', () => {
    expect(lineupSummary(NAMES, ['human', 'easy', 'human', 'human', 'human'], 2)).toBe('小红 + 1 个简单 AI · 2 人');
  });

  it('多个人类都写名字，AI 难度混合时分开计数', () => {
    expect(lineupSummary(NAMES, ['human', 'human', 'normal', 'easy', 'easy'], 5)).toBe('小红、小蓝 + 3 个 AI（普通 1、简单 2） · 5 人');
  });

  it('全是人类时不写 AI', () => {
    expect(lineupSummary(NAMES, ['human', 'human', 'human', 'normal', 'normal'], 3)).toBe('小红、小蓝、小黄 · 3 人');
  });

  it('全是 AI 就是观战', () => {
    expect(lineupSummary(NAMES, ['normal', 'easy', 'normal', 'normal', 'normal'], 4)).toBe('观战：4 个 AI');
  });

  it('名字为空或只有空格时写「玩家 n」，名字两端空格去掉', () => {
    expect(lineupSummary(['  ', ' 阿明 ', '', '', ''], ['human', 'human', 'normal', 'normal', 'normal'], 3)).toBe('玩家 1、阿明 + 1 个普通 AI · 3 人');
  });
});
