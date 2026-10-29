/**
 * 表现层：落点高亮（animator.focus）和地产卡片数据（tileCardInfo）。
 */
import { describe, it, expect } from 'vitest';
import { TILES, GROUPS } from '../../src/data/config/board.js';
import { RULES } from '../../src/data/config/rules.js';
import { createBoard } from '../../src/logic/core/board.js';
import { createInitialState } from '../../src/logic/core/gameState.js';
import { createAnimator, HIGHLIGHT_MS } from '../../src/view/render/animator.js';
import { isCompactCard, MIN_CARD_TEXT_PX, CARD_TEXT_RATIO, tileCardInfo, upgradeText } from '../../src/view/render/tileCard.js';
import { upgradeBlocker } from '../../src/logic/systems/property.js';

const board = createBoard({ tiles: TILES, groups: GROUPS, rules: RULES });
const indexOf = (id) => TILES.findIndex((t) => t.id === id);
// 棕色组：西宁(1) 租金 [20,100,300,900,1600] / 银川(3)

function newState() {
  return createInitialState({ board, rules: RULES, players: [{ name: '甲' }, { name: '乙' }], seed: 1 });
}

describe('地产卡片数据', () => {
  const card = (state, id) => tileCardInfo({ state, board, rules: RULES }, indexOf(id));

  it('非地产格返回 null', () => {
    const state = newState();
    expect(tileCardInfo({ state, board, rules: RULES }, 0)).toBeNull();
    expect(tileCardInfo({ state, board, rules: RULES }, 99)).toBeNull();
  });

  it('无主：显示空地租金和 1 级租金（不写“下一级”）', () => {
    expect(card(newState(), 'xining')).toEqual({
      name: '西宁',
      group: 'brown',
      price: 600,
      level: 0,
      maxLevel: RULES.maxLevel,
      mortgaged: false,
      owner: null,
      rent: 20,
      groupBonus: false,
      upgrade: { kind: 'unowned', rent: 100 },
    });
  });

  it('有主但不成组：按当前等级收租，所有者带座位号', () => {
    const state = newState();
    Object.assign(state.properties.xining, { ownerId: 'p2' });
    expect(card(state, 'xining')).toMatchObject({ owner: { name: '乙', index: 1 }, rent: 20, groupBonus: false });
  });

  it('拥有整组空地时租金翻倍并标注；有建筑后按等级收租，不再标注', () => {
    const state = newState();
    Object.assign(state.properties.xining, { ownerId: 'p1' });
    Object.assign(state.properties.yinchuan, { ownerId: 'p1' });
    expect(card(state, 'xining')).toMatchObject({ rent: 20 * RULES.groupRentMultiplier, groupBonus: true });
    state.properties.xining.level = 2;
    expect(card(state, 'xining')).toMatchObject({ rent: 300, groupBonus: false, upgrade: { kind: 'ready', rent: 900 } });
  });

  it('已抵押：租金为 0，不标注整组', () => {
    const state = newState();
    Object.assign(state.properties.xining, { ownerId: 'p1', mortgaged: true });
    Object.assign(state.properties.yinchuan, { ownerId: 'p1' });
    expect(card(state, 'xining')).toMatchObject({ mortgaged: true, rent: 0, groupBonus: false });
  });

  it('最高等级没有下一级', () => {
    const state = newState();
    Object.assign(state.properties.xining, { ownerId: 'p1', level: RULES.maxLevel });
    Object.assign(state.properties.yinchuan, { ownerId: 'p1' });
    expect(card(state, 'xining')).toMatchObject({ rent: 1600, upgrade: { kind: 'max', rent: null } });
  });

  it('所有者已破产时租金为 0', () => {
    const state = newState();
    Object.assign(state.properties.xining, { ownerId: 'p2' });
    state.players[1].bankrupt = true;
    expect(card(state, 'xining')).toMatchObject({ rent: 0, groupBonus: false });
  });
});

describe('升级说明', () => {
  const ctx = (state) => ({ state, board, rules: RULES });
  const card = (state, id) => tileCardInfo(ctx(state), indexOf(id));
  const fmt = (n) => `¥${n}`;

  it('没凑齐整组：提示凑齐整组后才能升级，并给出 1 级租金', () => {
    const state = newState();
    Object.assign(state.properties.xining, { ownerId: 'p1' });
    const c = card(state, 'xining');
    expect(c.upgrade).toEqual({ kind: 'needGroup', rent: 100 });
    expect(upgradeText(c, fmt)).toBe('凑齐整组后可升级 · 1 级 ¥100');
  });

  it('本格已抵押：提示赎回；同组其他地已抵押：提示同组赎回', () => {
    const state = newState();
    Object.assign(state.properties.xining, { ownerId: 'p1', mortgaged: true });
    Object.assign(state.properties.yinchuan, { ownerId: 'p1' });
    expect(upgradeText(card(state, 'xining'), fmt)).toBe('赎回后才能升级');
    expect(upgradeText(card(state, 'yinchuan'), fmt)).toBe('同组赎回后才能升级');
  });

  it('各种情况的文字', () => {
    const state = newState();
    expect(upgradeText(card(state, 'xining'), fmt)).toBe('凑齐整组后可升级 · 1 级 ¥100');
    Object.assign(state.properties.xining, { ownerId: 'p1', level: 1 });
    Object.assign(state.properties.yinchuan, { ownerId: 'p1' });
    expect(upgradeText(card(state, 'xining'), fmt)).toBe('下一级 ¥300');
    state.properties.xining.level = RULES.maxLevel;
    expect(upgradeText(card(state, 'xining'), fmt)).toBe('已满级');
  });

  it('upgradeBlocker 与升级规则一致', () => {
    const state = newState();
    Object.assign(state.properties.xining, { ownerId: 'p1' });
    expect(upgradeBlocker(ctx(state), 'xining')?.code).toBe('notFullGroup');
    Object.assign(state.properties.yinchuan, { ownerId: 'p1', mortgaged: true });
    expect(upgradeBlocker(ctx(state), 'xining')?.code).toBe('mortgaged');
    state.properties.yinchuan.mortgaged = false;
    expect(upgradeBlocker(ctx(state), 'xining')).toBeNull();
    state.properties.xining.level = RULES.maxLevel;
    expect(upgradeBlocker(ctx(state), 'xining')?.code).toBe('maxLevel');
  });
});

describe('紧凑卡片判断', () => {
  it(`卡片正文小于 ${MIN_CARD_TEXT_PX}px 时切换`, () => {
    const edge = MIN_CARD_TEXT_PX / CARD_TEXT_RATIO;
    expect(isCompactCard(edge)).toBe(false);
    expect(isCompactCard(edge - 0.1)).toBe(true);
    expect(isCompactCard(45)).toBe(false); // 1440×900 的格高
    expect(isCompactCard(30)).toBe(true); // 约 1100px 双栏时的格高
  });
});

describe('落点高亮', () => {
  const move = (to) => ({ playerId: 'p1', from: 0, to, steps: to, path: Array.from({ length: to }, (_, k) => k + 1) });

  function setup(options) {
    const animator = createAnimator({ state: { players: [{ id: 'p1', position: 0 }] }, ...options });
    return animator;
  }

  it('棋子落地后才出现落点，高亮按时间结束但落点保留', () => {
    const a = setup();
    a.handle(move(3), 'playerMoved');
    a.tick(0);
    expect(a.focus).toBeNull(); // 移动中
    a.tick(10000); // 移动结束
    expect(a.focus).toMatchObject({ index: 3 });
    expect(a.focus.glow).toBeGreaterThan(0);
    expect(a.tick(10000 + HIGHLIGHT_MS / 2)).toBe(true); // 高亮期间需要继续出帧
    expect(a.tick(10000 + HIGHLIGHT_MS)).toBe(false);
    expect(a.focus).toEqual({ index: 3, glow: 0 });
  });

  it('下一次移动开始时清空落点，落地后换成新格子', () => {
    const a = setup();
    a.handle(move(3), 'playerMoved');
    a.tick(0);
    a.tick(10000);
    a.handle({ playerId: 'p1', from: 3, to: 5, steps: 2, path: [4, 5] }, 'playerMoved');
    a.tick(20000);
    expect(a.focus).toBeNull();
    a.tick(30000);
    expect(a.focus.index).toBe(5);
  });

  it('被送进监狱也高亮监狱格', () => {
    const a = setup();
    a.handle({ playerId: 'p1', from: 30, to: 10 }, 'sentToJail');
    a.tick(0);
    a.tick(10000);
    expect(a.focus.index).toBe(10);
  });

  it('4× 速度时高亮时长缩短到 1/4', () => {
    const a = setup();
    a.setSpeed(4);
    a.handle(move(1), 'playerMoved');
    a.tick(0);
    a.tick(10000);
    expect(a.tick(10000 + HIGHLIGHT_MS / 4 - 1)).toBe(true);
    expect(a.tick(10000 + HIGHLIGHT_MS / 4)).toBe(false);
  });

  it('减少动态效果时为静态高亮：全强度，到时结束', () => {
    const a = setup({ reducedMotion: true });
    a.handle(move(2), 'playerMoved');
    a.tick(0); // 移动动画时长为 0，立即落地
    for (const t of [0, HIGHLIGHT_MS * 0.3, HIGHLIGHT_MS * 0.7]) {
      a.tick(t);
      expect(a.focus.glow).toBe(1);
    }
    a.tick(HIGHLIGHT_MS);
    expect(a.focus.glow).toBe(0);
  });
});
