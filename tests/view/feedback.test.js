/**
 * 表现层：棋子性格和情绪反馈（走路样子、动作、收租金币、整组发光、破产倒下）。
 */
import { describe, it, expect } from 'vitest';
import { COIN_MS, EFFECT_MS, POSE_MS, WALK_STYLES, createAnimator, poseShape } from '../../src/view/render/animator.js';
import { COLLAPSED_COUNT } from '../../src/view/ui/log.js';

const state = { players: [0, 1, 2].map((i) => ({ id: `p${i + 1}`, position: 0 })) };
const move = (id, n) => ({ playerId: id, from: 0, to: n, steps: n, path: Array.from({ length: n }, (_, k) => k + 1) });

/** 播一个事件并推进到 now */
function play(a, type, payload, now = 0) {
  a.handle(payload, type);
  a.tick(now);
}

describe('棋子动作的样子', () => {
  it('落地压扁后复原；欢呼跳起；垂头时矮下去；倒下后淡出', () => {
    expect(poseShape('land', 0.5).sy).toBeLessThan(0.8);
    expect(poseShape('land', 1).sy).toBeCloseTo(1);
    expect(poseShape('cheer', 0.25).dz).toBeGreaterThan(0.3);
    expect(poseShape('cheer', 1).dz).toBeCloseTo(0);
    expect(poseShape('sad', 0.5)).toMatchObject({ sy: expect.any(Number), tilt: expect.any(Number) });
    expect(poseShape('sad', 0.5).sy).toBeLessThan(0.9);
    expect(poseShape('sad', 1).sy).toBeCloseTo(1);
    expect(poseShape('fall', 0.5).tilt).toBeCloseTo(Math.PI / 2);
    expect(poseShape('fall', 0.4).alpha).toBe(1);
    expect(poseShape('fall', 1).alpha).toBeCloseTo(0);
    expect(poseShape('unknown', 0.5)).toEqual({ dz: 0, tilt: 0, sx: 1, sy: 1, alpha: 1 });
  });

  it('不同座位走路的样子不同', () => {
    const hops = new Set(WALK_STYLES.map((s) => s.hop));
    expect(hops.size).toBe(WALK_STYLES.length);
    // 第 3 位走一格的中点比第 1 位跳得高
    const a = createAnimator({ state });
    play(a, 'playerMoved', move('p1', 1));
    a.tick(80);
    const z1 = a.tokens.get('p1').z;
    play(a, 'playerMoved', move('p3', 1), 2000);
    a.tick(2080);
    expect(a.tokens.get('p3').z).toBeGreaterThan(z1);
  });
});

describe('事件触发的动作', () => {
  it('落地压扁一下，买到地欢呼，付钱垂头，赌输垂头、赌赢欢呼', () => {
    const a = createAnimator({ state });
    play(a, 'playerMoved', move('p1', 2));
    a.tick(1000);
    expect(a.poses.get('p1')?.kind).toBe('land');
    play(a, 'propertyBought', { playerId: 'p2', tileId: 'x', price: 600 }, 2000);
    expect(a.poses.get('p2')?.kind).toBe('cheer');
    play(a, 'paymentMade', { payerId: 'p3', payeeIds: [], amount: 200, reason: { type: 'tax' } }, 3000);
    expect(a.poses.get('p3')?.kind).toBe('sad');
    play(a, 'gambleRolled', { playerId: 'p1', won: false, dice: [1, 1], total: 2, target: 8, amount: 500 }, 5000);
    expect(a.poses.get('p1')?.kind).toBe('sad');
    // 动作播完就清掉，并且会继续请求下一帧直到播完
    expect(a.tick(5000 + POSE_MS.sad - 1)).toBe(true);
    a.tick(10_000);
    expect(a.poses.size).toBe(0);
  });

  it('收租：金币从付钱的人飞向收钱的人，金额越大金币越多', () => {
    const a = createAnimator({ state });
    play(a, 'paymentMade', { payerId: 'p1', payeeIds: ['p2'], amount: 300, reason: { type: 'rent', tileId: 'x' } });
    expect(a.coins).toEqual([{ from: 'p1', to: 'p2', count: 2, t: 0 }]);
    a.tick(COIN_MS / 2);
    expect(a.coins[0].t).toBeCloseTo(0.5);
    a.tick(COIN_MS);
    expect(a.coins).toEqual([]);
    play(a, 'paymentMade', { payerId: 'p1', payeeIds: ['p2'], amount: 5000, reason: { type: 'rent', tileId: 'x' } }, 5000);
    expect(a.coins[0].count).toBe(6);
    // 交税付给银行：没有金币
    play(a, 'paymentMade', { payerId: 'p1', payeeIds: [], amount: 200, reason: { type: 'tax' } }, 9000);
    expect(a.coins).toEqual([]);
  });

  it('凑齐颜色组：整组格子都发光，主角欢呼', () => {
    const a = createAnimator({ state });
    play(a, 'groupCompleted', { playerId: 'p1', group: 'brown', tileIds: ['xining', 'yinchuan'] });
    expect([...a.effects.keys()].sort()).toEqual(['xining', 'yinchuan']);
    expect(a.effects.get('xining').kind).toBe('group');
    expect(a.poses.get('p1')?.kind).toBe('cheer');
    a.tick(EFFECT_MS.group);
    expect(a.effects.size).toBe(0);
  });

  it('破产：棋子倒下，被收走的地产闪暗', () => {
    const a = createAnimator({ state });
    play(a, 'assetsLiquidated', { debtorId: 'p2', heirId: null, payeeIds: [], cash: 0, properties: ['lanzhou'] });
    expect(a.effects.get('lanzhou').kind).toBe('bankrupt');
    play(a, 'playerBankrupt', { playerId: 'p2' }, 10);
    expect(a.poses.get('p2')?.kind).toBe('fall');
  });

  it('减少动态效果：没有动作和金币；立即播完时全部清掉', () => {
    const calm = createAnimator({ state, reducedMotion: true });
    play(calm, 'propertyBought', { playerId: 'p1', tileId: 'x', price: 600 });
    play(calm, 'paymentMade', { payerId: 'p1', payeeIds: ['p2'], amount: 300, reason: { type: 'rent', tileId: 'x' } }, 5000);
    expect(calm.poses.size).toBe(0);
    expect(calm.coins).toEqual([]);

    const a = createAnimator({ state });
    a.handle(move('p1', 3), 'playerMoved');
    a.handle({ payerId: 'p1', payeeIds: ['p2'], amount: 300, reason: { type: 'rent', tileId: 'x' } }, 'paymentMade');
    a.skipAll();
    expect(a.poses.size).toBe(0);
    expect(a.coins).toEqual([]);
    expect(a.tokens.get('p1').tilt).toBe(0);
  });
});

describe('事件日志', () => {
  it('收起时只显示最近一条', () => {
    expect(COLLAPSED_COUNT).toBe(1);
  });
});
