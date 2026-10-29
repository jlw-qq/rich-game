/**
 * 表现层：关键事件结果卡的文案（describePopup）和播放时机（animator.popup）。
 */
import { describe, it, expect } from 'vitest';
import { TILES, GROUPS } from '../../src/data/config/board.js';
import { RULES } from '../../src/data/config/rules.js';
import { createBoard } from '../../src/logic/core/board.js';
import { createInitialState } from '../../src/logic/core/gameState.js';
import { createAnimator } from '../../src/view/render/animator.js';
import { createPopupDescriber, popupMotion, POPUP_MS, TOAST_MS } from '../../src/view/render/popup.js';

const board = createBoard({ tiles: TILES, groups: GROUPS, rules: RULES });

function setup() {
  const state = createInitialState({ board, rules: RULES, players: [{ name: '小红' }, { name: '小蓝' }, { name: '小绿' }], seed: 1 });
  const describe = createPopupDescriber();
  return { state, ctx: { state, board, rules: RULES }, describe };
}

describe('结果卡文案', () => {
  it('买地：写明谁拿下哪里，以及其他玩家停在这里要付多少（不是“经过”）', () => {
    const { state, ctx, describe } = setup();
    state.properties.wuhan.ownerId = 'p2';
    const card = describe('propertyBought', { playerId: 'p2', tileId: 'wuhan', price: 2200 }, ctx);
    expect(card).toMatchObject({ kind: 'buy', title: '小蓝 拿下武汉！', text: '其他玩家停在这里需付 ¥180', tileId: 'wuhan', group: 'red', playerIndex: 1 });
  });

  it('收租：写明谁付给谁多少；交税、付给银行的款项不弹卡', () => {
    const { ctx, describe } = setup();
    const rent = { payerId: 'p1', payeeIds: ['p2'], amount: 180, reason: { type: 'rent', tileId: 'wuhan' } };
    expect(describe('paymentMade', rent, ctx)).toMatchObject({ kind: 'rent', title: '武汉 收租', text: '小红 付给 小蓝 ¥180', playerIndex: 1 });
    expect(describe('paymentMade', { payerId: 'p1', payeeIds: [], amount: 2000, reason: { type: 'tax', tileId: 'tax-income' } }, ctx)).toBeNull();
  });

  it('只有升到满级才弹“建成地标”', () => {
    const { state, ctx, describe } = setup();
    Object.assign(state.properties.beijing, { ownerId: 'p1', level: RULES.maxLevel });
    Object.assign(state.properties.shanghai, { ownerId: 'p1' });
    expect(describe('propertyUpgraded', { playerId: 'p1', tileId: 'beijing', level: 3, cost: 2000 }, ctx)).toBeNull();
    expect(describe('propertyUpgraded', { playerId: 'p1', tileId: 'beijing', level: 4, cost: 2000 }, ctx)).toMatchObject({
      kind: 'landmark',
      title: '北京建成城楼！',
      text: '租金涨到 ¥17,000',
    });
  });

  it('破产：根据清算结果写明地产归谁', () => {
    const { ctx, describe } = setup();
    describe('assetsLiquidated', { debtorId: 'p3', heirId: 'p2', properties: ['xining'], cash: 0 }, ctx);
    expect(describe('playerBankrupt', { playerId: 'p3' }, ctx)).toMatchObject({ kind: 'bankrupt', title: '小绿 破产了', text: '退出本局，地产归 小蓝' });
    describe('assetsLiquidated', { debtorId: 'p1', heirId: null, properties: ['yinchuan'], cash: 0 }, ctx);
    expect(describe('playerBankrupt', { playerId: 'p1' }, ctx).text).toBe('退出本局，地产收归银行');
    // 没有地产可清算时不提地产
    describe('assetsLiquidated', { debtorId: 'p2', heirId: 'p1', properties: [], cash: 0 }, ctx);
    expect(describe('playerBankrupt', { playerId: 'p2' }, ctx).text).toBe('退出本局');
  });

  it('交易成交：列出双方交换的内容', () => {
    const { ctx, describe } = setup();
    const trade = { fromId: 'p1', toId: 'p2', give: { properties: [], cash: 500, jailCards: 0 }, take: { properties: ['xining'], cash: 0, jailCards: 0 } };
    expect(describe('tradeAccepted', { trade }, ctx).text).toBe('小红 用「500 元」换来「西宁」');
  });

  it('其他事件不弹卡', () => {
    const { ctx, describe } = setup();
    expect(describe('diceRolled', { playerId: 'p1', dice: [1, 2] }, ctx)).toBeNull();
    expect(describe('propertyMortgaged', { playerId: 'p1', tileId: 'xining', amount: 300 }, ctx)).toBeNull();
  });
});

describe('结果卡动画曲线', () => {
  it('开头从 0.6 回弹放大到 1，结尾淡出；减少动态效果时不缩放', () => {
    expect(popupMotion(0).scale).toBeCloseTo(0.6);
    expect(popupMotion(0.5)).toEqual({ scale: 1, alpha: 1 });
    expect(popupMotion(1).alpha).toBe(0);
    expect(popupMotion(0, true)).toEqual({ scale: 1, alpha: 1 });
  });
});

describe('结果卡播放时机', () => {
  const state = { players: [{ id: 'p1', position: 0 }, { id: 'p2', position: 0 }] };
  const card = { kind: 'buy', title: 'x', text: 'y', tileId: 'wuhan', group: 'red', playerIndex: 0 };
  const describePopup = (type) => (type === 'propertyBought' ? card : null);
  const bought = { playerId: 'p1', tileId: 'wuhan', price: 2200 };
  const next = { playerId: 'p1', amount: 100 };

  it('普通对局：结果卡停留期间暂停后续事件', () => {
    const events = [];
    const a = createAnimator({ state, describePopup, onEvent: (type) => events.push(type) });
    a.handle(bought, 'propertyBought');
    a.handle(next, 'cashGained');
    a.tick(0);
    expect(a.popup).toMatchObject({ data: card, toast: false });
    a.tick(POPUP_MS - 1);
    expect(events).toEqual(['propertyBought']);
    a.tick(POPUP_MS);
    expect(events).toEqual(['propertyBought', 'cashGained']);
    expect(a.popup).toBeNull();
  });

  it('播放倍速同样缩短停留时间', () => {
    const a = createAnimator({ state, describePopup });
    a.setSpeed(4);
    a.handle(bought, 'propertyBought');
    a.tick(0);
    a.tick(POPUP_MS / 4);
    expect(a.popup).toBeNull();
    expect(a.busy).toBe(false);
  });

  it('观战模式：小提示条不阻塞后续事件', () => {
    const events = [];
    const a = createAnimator({ state, describePopup, onEvent: (type) => events.push(type) });
    a.setCalm(true);
    a.handle(bought, 'propertyBought');
    a.handle(next, 'cashGained');
    a.tick(0);
    expect(events).toEqual(['propertyBought', 'cashGained']);
    expect(a.popup).toMatchObject({ toast: true });
    expect(a.tick(TOAST_MS - 1)).toBe(true); // 提示条还在，继续出帧
    a.tick(TOAST_MS);
    expect(a.popup).toBeNull();
  });

  it('减少动态效果时仍然显示结果卡（只是不弹出）', () => {
    const a = createAnimator({ state, describePopup, reducedMotion: true });
    a.handle(bought, 'propertyBought');
    a.tick(0);
    a.tick(POPUP_MS / 2);
    expect(a.popup?.t).toBeCloseTo(0.5);
  });
});
