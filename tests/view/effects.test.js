/**
 * 表现层：关键事件反馈（格子特效、飘字缩放、骰子弹跳）和动画曲线。
 */
import { describe, it, expect } from 'vitest';
import { createAnimator, DICE_BOUNCE_MS, EFFECT_MS } from '../../src/view/render/animator.js';
import { diceBounce, easeOutBack, flash, popScale } from '../../src/view/render/easing.js';

const state = { players: [{ id: 'p1', position: 0 }, { id: 'p2', position: 0 }] };

describe('动画曲线', () => {
  it('回弹放大：从 0 开始，中途超过 1，结束时回到 1', () => {
    expect(easeOutBack(0)).toBeCloseTo(0);
    expect(Math.max(...[0.5, 0.6, 0.7, 0.8].map(easeOutBack))).toBeGreaterThan(1);
    expect(easeOutBack(1)).toBeCloseTo(1);
  });

  it('闪烁：首尾为 0，中间有两个亮峰', () => {
    expect(flash(0)).toBeCloseTo(0);
    expect(flash(1)).toBeCloseTo(0);
    expect(flash(0.5)).toBeCloseTo(0);
    expect(flash(0.25)).toBeGreaterThan(0.8);
    expect(flash(0.75)).toBeGreaterThan(0.6);
  });

  it('飘字缩放：先放大到 1.25，之后回到 1', () => {
    expect(popScale(0)).toBe(1);
    expect(popScale(0.15)).toBeCloseTo(1.25);
    expect(popScale(0.35)).toBeCloseTo(1);
    expect(popScale(1)).toBe(1);
  });

  it('骰子弹跳：触地时压扁，结束时归位', () => {
    expect(diceBounce(0)).toMatchObject({ lift: 0 });
    expect(diceBounce(0).scaleY).toBeLessThan(1);
    expect(diceBounce(1 / 6).lift).toBeGreaterThan(0.1); // 第一跳最高点
    expect(diceBounce(1)).toEqual({ lift: 0, scaleX: 1, scaleY: 1 });
    expect(diceBounce(0.999).lift).toBeCloseTo(0, 3);
  });
});

describe('格子特效', () => {
  const play = (a, type, payload, now = 0) => {
    a.handle(payload, type);
    a.tick(now);
  };

  it.each([
    ['propertyBought', { playerId: 'p1', tileId: 'xining', price: 600 }, 'buy', undefined],
    ['propertyUpgraded', { playerId: 'p1', tileId: 'xining', level: 2, cost: 500 }, 'upgrade', 2],
    ['buildingSold', { playerId: 'p1', tileId: 'xining', level: 1, refund: 250 }, 'sell', 1],
    ['propertyMortgaged', { playerId: 'p1', tileId: 'xining', amount: 300 }, 'mortgage', undefined],
    ['propertyRedeemed', { playerId: 'p1', tileId: 'xining', cost: 330 }, 'redeem', undefined],
  ])('%s → %s 特效，播完后清除', (type, payload, kind, level) => {
    const a = createAnimator({ state });
    play(a, type, payload);
    expect(a.effects.get('xining')).toEqual({ kind, level, t: 0 });
    a.tick(EFFECT_MS[kind] / 2);
    expect(a.effects.get('xining').t).toBeCloseTo(0.5);
    a.tick(EFFECT_MS[kind] - 1);
    expect(a.effects.size).toBe(1);
    a.tick(EFFECT_MS[kind]);
    expect(a.effects.size).toBe(0);
  });

  it('只有特效（没有飘字）时也会继续请求下一帧', () => {
    const a = createAnimator({ state });
    // 升级费为 0 时不产生飘字，只剩格子特效
    play(a, 'propertyUpgraded', { playerId: 'p1', tileId: 'xining', level: 1, cost: 0 });
    expect(a.floaters).toEqual([]);
    expect(a.tick(EFFECT_MS.upgrade - 1)).toBe(true);
    expect(a.tick(EFFECT_MS.upgrade)).toBe(false);
  });

  it('交易换手的地产都闪色条', () => {
    const a = createAnimator({ state });
    const trade = {
      fromId: 'p1',
      toId: 'p2',
      give: { properties: ['xining'], cash: 0, jailCards: 0 },
      take: { properties: ['beijing', 'shanghai'], cash: 100, jailCards: 0 },
    };
    play(a, 'tradeAccepted', { trade });
    expect([...a.effects.keys()].sort()).toEqual(['beijing', 'shanghai', 'xining']);
    expect([...a.effects.values()].every((e) => e.kind === 'buy')).toBe(true);
  });

  it('特效时长随播放倍速缩短', () => {
    const a = createAnimator({ state });
    a.setSpeed(4);
    play(a, 'propertyBought', { playerId: 'p1', tileId: 'xining', price: 600 });
    a.tick(EFFECT_MS.buy / 4 - 1);
    expect(a.effects.size).toBe(1);
    a.tick(EFFECT_MS.buy / 4);
    expect(a.effects.size).toBe(0);
  });

  it('减少动态效果时不产生特效，飘字不放大', () => {
    const a = createAnimator({ state, reducedMotion: true });
    play(a, 'propertyBought', { playerId: 'p1', tileId: 'xining', price: 600 });
    expect(a.effects.size).toBe(0);
    expect(a.floaters.map((f) => f.scale)).toEqual([1]);
  });

  it('飘字一出现先放大', () => {
    const a = createAnimator({ state });
    play(a, 'cashGained', { playerId: 'p1', amount: 100 });
    expect(a.floaters[0].scale).toBe(1);
    a.tick(1200 * 0.15);
    expect(a.floaters[0].scale).toBeCloseTo(1.25);
  });
});

describe('骰子落定弹跳', () => {
  const roll = { playerId: 'p1', dice: [3, 4], total: 7, isDouble: false };

  it('落定后弹跳，不阻塞后续事件，结束后归位', () => {
    const a = createAnimator({ state });
    a.handle(roll, 'diceRolled');
    a.handle({ playerId: 'p1', amount: 100 }, 'cashGained');
    a.tick(0);
    a.tick(600); // 骰子停止滚动
    expect(a.busy).toBe(false); // 后续事件已经开始播放
    expect(a.dice.values).toEqual([3, 4]);
    a.tick(600 + DICE_BOUNCE_MS / 6);
    expect(a.dice.bounce.lift).toBeGreaterThan(0);
    a.tick(600 + DICE_BOUNCE_MS);
    expect(a.dice.bounce).toEqual({ lift: 0, scaleX: 1, scaleY: 1 });
  });

  it('减少动态效果时不弹跳', () => {
    const a = createAnimator({ state, reducedMotion: true });
    a.handle(roll, 'diceRolled');
    a.tick(0);
    a.tick(DICE_BOUNCE_MS / 6);
    expect(a.dice.bounce.lift).toBe(0);
  });
});

describe('卡片标题栏对比度', () => {
  it('八个颜色组的标题栏文字对比度都不低于 4.5:1', async () => {
    const { GROUP_COLORS, GROUP_HEADERS, MIN_TEXT_CONTRAST, contrastRatio } = await import('../../src/view/render/theme.js');
    expect(Object.keys(GROUP_HEADERS).sort()).toEqual(Object.keys(GROUP_COLORS).sort());
    for (const [group, { bg, text }] of Object.entries(GROUP_HEADERS)) {
      expect(contrastRatio(bg, text), group).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    }
    // 原本就达标的颜色不改底色
    expect(GROUP_HEADERS.darkBlue.bg).toBe(GROUP_COLORS.darkBlue);
  });

  it('对比度计算：黑白为 21，同色为 1', async () => {
    const { contrastRatio } = await import('../../src/view/render/theme.js');
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21);
    expect(contrastRatio('#e04646', '#e04646')).toBeCloseTo(1);
  });
});

describe('落点光边与地产特效交棒', () => {
  const tileIds = Array.from({ length: 40 }, (_, i) => (i === 3 ? 'yinchuan' : `t${i}`));
  const move = { playerId: 'p1', from: 0, to: 3, steps: 3, path: [1, 2, 3] };

  it('同一格开始播放买地特效后，光边在 150 毫秒内淡出', () => {
    const a = createAnimator({ state, tileIds });
    a.handle(move, 'playerMoved');
    a.tick(0);
    a.tick(1000); // 落地并结束停顿
    expect(a.focus.glow).toBeGreaterThan(0);
    a.handle({ playerId: 'p1', tileId: 'yinchuan', price: 600 }, 'propertyBought');
    a.tick(1100);
    expect(a.effects.get('yinchuan').kind).toBe('buy');
    a.tick(1175);
    expect(a.focus.glow).toBeGreaterThan(0);
    a.tick(1250);
    expect(a.focus).toEqual({ index: 3, glow: 0 }); // 落点仍保留，供卡片使用
  });

  it('在落点格收租时，金额出现后光边淡出', () => {
    const a = createAnimator({ state, tileIds });
    a.handle(move, 'playerMoved');
    a.tick(0);
    a.tick(1000);
    a.handle({ payerId: 'p1', payeeIds: ['p2'], amount: 40, reason: { type: 'rent', tileId: 'yinchuan' } }, 'paymentMade');
    a.tick(1100);
    expect(a.floaters.length).toBe(2);
    a.tick(1250);
    expect(a.focus.glow).toBe(0);
  });

  it('其他格子的特效不影响光边', () => {
    const a = createAnimator({ state, tileIds });
    a.handle(move, 'playerMoved');
    a.tick(0);
    a.tick(1000);
    a.handle({ playerId: 'p1', tileId: 't9', level: 1, cost: 0 }, 'propertyUpgraded');
    a.tick(1300);
    expect(a.focus.glow).toBeGreaterThan(0);
  });

  it('观战模式：光边只淡入淡出一次，没有脉冲', () => {
    const a = createAnimator({ state, tileIds });
    a.setCalm(true);
    a.handle(move, 'playerMoved');
    a.tick(0);
    a.tick(480); // 刚落地
    const samples = [];
    for (let t = 0; t <= 1200; t += 60) {
      a.tick(480 + t);
      samples.push(a.focus.glow);
    }
    const peak = samples.indexOf(Math.max(...samples));
    // 先升后降：峰值之前单调不减，之后单调不增
    expect(samples.slice(0, peak + 1).every((v, i, arr) => i === 0 || v >= arr[i - 1])).toBe(true);
    expect(samples.slice(peak).every((v, i, arr) => i === 0 || v <= arr[i - 1])).toBe(true);
    expect(samples[0]).toBeCloseTo(0);
  });
});
