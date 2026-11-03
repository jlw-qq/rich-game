/**
 * 逻辑层：分享链接参数（挑战链接、邀请链接）的生成、解析和成绩比较。
 */
import { describe, it, expect } from 'vitest';
import { encodeChallenge } from '../../../src/logic/systems/challenge.js';
import { compareScores, encodeChallengeLink, encodeRoomLink, parseShareParams, MAX_SHARE_NAME } from '../../../src/logic/systems/shareLink.js';
import { compareText } from '../../../src/view/ui/results.js';

const config = { mode: 'quick', kinds: ['human', 'normal', 'normal', 'normal'], seed: 12345 };
const code = encodeChallenge(config);
const score = { rank: 1, players: 4, bankrupt: false, netWorth: 31200, round: 18 };

describe('挑战链接', () => {
  it('挑战码 + 名字 + 成绩往返不变', () => {
    const q = encodeChallengeLink({ code, by: '小红', score });
    expect(parseShareParams(`?${q}`)).toEqual({ challenge: { code, config, by: '小红', score }, room: null, error: null });
  });

  it('破产也能带上；没有成绩时只带挑战码，名字也不带', () => {
    const lost = { ...score, rank: 4, bankrupt: true, netWorth: 0 };
    expect(parseShareParams(encodeChallengeLink({ code, by: '小红', score: lost })).challenge.score).toEqual(lost);
    const q = encodeChallengeLink({ code, by: '小红', score: null });
    expect(q).toBe(new URLSearchParams({ c: code }).toString());
    expect(parseShareParams(q).challenge).toEqual({ code, config, by: null, score: null });
  });

  it('挑战码可以小写、不带横线', () => {
    expect(parseShareParams(`c=${code.toLowerCase().replace(/-/g, '')}`).challenge.code).toBe(code);
  });

  it('挑战码无效：没有挑战，给出提示', () => {
    const r = parseShareParams('c=CR-0000-0000-0000&by=x&s=1.4.100.3.0');
    expect(r.challenge).toBeNull();
    expect(r.error).toMatch(/^链接里的挑战码无效/);
  });

  it.each([
    ['名次大于人数', '5.4.100.3.0'],
    ['人数和挑战码不一致', '1.3.100.3.0'],
    ['负数', '1.4.-100.3.0'],
    ['小数', '1.4.100.5.3.0'],
    ['名次为 0', '0.4.100.3.0'],
    ['轮数为 0', '1.4.100.0.0'],
    ['破产标记不是 0/1', '1.4.100.3.2'],
    ['少一项', '1.4.100.3'],
    ['有字母', '1.4.1e5.3.0'],
    ['超大数字', `1.4.${'9'.repeat(30)}.3.0`],
  ])('成绩不合法（%s）时丢掉成绩和名字，挑战码照常', (_, s) => {
    const r = parseShareParams(new URLSearchParams({ c: code, by: '小红', s }).toString());
    expect(r.challenge).toEqual({ code, config, by: null, score: null });
    expect(r.error).toBeNull();
  });

  it('名字：去掉控制字符和方向控制字符、两端空白，超长截断；只剩空白时当作没有名字', () => {
    const long = '一二三四五六七八九十甲乙丙丁';
    const parse = (by) => parseShareParams(new URLSearchParams({ c: code, by, s: '1.4.100.3.0' }).toString()).challenge.by;
    expect(parse(long)).toBe(long.slice(0, MAX_SHARE_NAME));
    expect(parse(' 小\u0000红‮ ')).toBe('小红');
    expect(parse('   ')).toBeNull();
    // 名字里的 HTML 只是文字（表现层用文本节点显示）
    expect(parse('<b>x</b>')).toBe('<b>x</b>');
  });

  it('生成链接时名字同样清理', () => {
    const q = encodeChallengeLink({ code, by: ` 小红\u0007 `, score });
    expect(new URLSearchParams(q).get('by')).toBe('小红');
  });
});

describe('邀请链接', () => {
  it('房间码往返；小写和空格会规范化', () => {
    expect(parseShareParams(encodeRoomLink('AB23')).room).toBe('AB23');
    expect(parseShareParams('room=%20ab23%20').room).toBe('AB23');
  });

  it.each(['ABC', 'ABCDE', 'AB1O', '', 'A B C D E'])('房间码 %j 无效：给出提示', (room) => {
    const r = parseShareParams(new URLSearchParams({ room }).toString());
    expect(r.room).toBeNull();
    expect(r.error).toBe('链接里的房间码无效');
  });

  it('没有分享参数时什么都没有；不是字符串也不出错', () => {
    expect(parseShareParams('?foo=1')).toEqual({ challenge: null, room: null, error: null });
    expect(parseShareParams(undefined)).toEqual({ challenge: null, room: null, error: null });
  });
});

describe('和朋友比成绩', () => {
  it('名次靠前赢；同名次比总资产，再比轮数；完全一样是平局', () => {
    expect(compareScores({ ...score, rank: 1 }, { ...score, rank: 2 })).toBe('win');
    expect(compareScores({ ...score, netWorth: 30000 }, score)).toBe('lose');
    expect(compareScores({ ...score, round: 17 }, score)).toBe('win');
    expect(compareScores(score, { ...score })).toBe('tie');
  });

  it('对比文字：输赢、差额；朋友没写名字时叫「朋友」；破产写「已破产」', () => {
    const mine = { ...score, rank: 2, netWorth: 29000 };
    expect(compareText(mine, { by: '小红', score }).text).toBe('你 第 2/4 名 · 29,000 元 ／ 小红 第 1/4 名 · 31,200 元 → 小红赢了，总资产差 2,200 元');
    expect(compareText(score, { by: null, score: mine })).toEqual({
      result: 'win',
      text: '你 第 1/4 名 · 31,200 元 ／ 朋友 第 2/4 名 · 29,000 元 → 你赢了，总资产差 2,200 元',
    });
    const broke = { ...score, rank: 4, bankrupt: true, netWorth: 0 };
    expect(compareText(broke, { by: '小红', score: broke }).text).toBe('你 第 4/4 名 · 已破产 ／ 小红 第 4/4 名 · 已破产 → 打平');
  });
});
