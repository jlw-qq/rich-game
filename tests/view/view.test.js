/**
 * 表现层中不依赖 DOM 的部分：布局、日志文字、动画排队。
 */
import { describe, it, expect, vi } from 'vitest';
import { TILES, GROUPS } from '../../src/data/config/board.js';
import { RULES } from '../../src/data/config/rules.js';
import { CARDS } from '../../src/data/config/cards.js';
import { createBoard } from '../../src/logic/core/board.js';
import { createEventBus } from '../../src/logic/core/eventBus.js';
import { createInitialState } from '../../src/logic/core/gameState.js';
import { createGame } from '../../src/logic/core/game.js';
import { PHASES as P } from '../../src/logic/core/turnMachine.js';
import { computeLayout, gridOf, outwardOf, project, SIDE } from '../../src/view/render/layout.js';
import { formatEvent, tradeSideText } from '../../src/view/ui/format.js';
import { createAnimator, easeInOut, LAND_PAUSE_MS } from '../../src/view/render/animator.js';

const board = createBoard({ tiles: TILES, groups: GROUPS, rules: RULES });

describe('layout', () => {
  it('40 格落在 11×11 外圈，互不重叠，相邻格相邻', () => {
    const cells = TILES.map((t) => gridOf(t.index));
    expect(new Set(cells.map(({ gx, gy }) => `${gx},${gy}`)).size).toBe(40);
    for (const { gx, gy } of cells) {
      expect(gx === 0 || gx === SIDE || gy === 0 || gy === SIDE).toBe(true);
    }
    for (let i = 0; i < 40; i++) {
      const a = cells[i];
      const b = cells[(i + 1) % 40];
      expect(Math.abs(a.gx - b.gx) + Math.abs(a.gy - b.gy)).toBe(1);
    }
    expect(gridOf(0)).toEqual({ gx: SIDE, gy: SIDE });
  });

  it('投影后整个棋盘在画布内', () => {
    for (const [w, h] of [[960, 600], [400, 250], [1600, 700]]) {
      const L = computeLayout(w, h);
      for (const t of TILES) {
        const { gx, gy } = gridOf(t.index);
        const c = project(L, gx, gy);
        expect(c.x - L.tw / 2).toBeGreaterThanOrEqual(-0.5);
        expect(c.x + L.tw / 2).toBeLessThanOrEqual(w + 0.5);
        expect(c.y - L.th / 2).toBeGreaterThanOrEqual(-0.5);
        expect(c.y + L.th / 2 + L.depth).toBeLessThanOrEqual(h + 0.5);
      }
    }
  });
});

/** 跑一局到终局，收集所有事件 */
function playRecordedGame(seed) {
  const rules = { ...RULES, maxRounds: 30 };
  const state = createInitialState({ board, rules, cards: CARDS, players: [{ name: '甲' }, { name: '乙' }, { name: '丙' }], seed });
  const bus = createEventBus();
  const events = [];
  bus.on('*', (payload, type) => events.push({ type, payload }));
  const game = createGame({ board, rules, state, bus, cards: CARDS });
  for (let i = 0; i < 20000 && game.phase !== P.GAME_OVER; i++) {
    switch (game.phase) {
      case P.AWAIT_ROLL:
        game.rollDice();
        break;
      case P.AWAIT_DECISION:
        if (!game.buyProperty().ok) game.declineProperty();
        break;
      case P.AWAIT_PAYMENT: {
        const me = game.actingPlayerId();
        for (const t of TILES) if (state.properties[t.id]?.ownerId === me) game.mortgage(me, t.id);
        if (!game.payDebt().ok) game.declareBankruptcy();
        break;
      }
      case P.AWAIT_CHOICE:
        // 优先选第二个选项，让冒险、免费升级的事件也被翻译到
        if (!game.chooseOption(1).ok) game.chooseOption(0);
        break;
      default:
        game.endTurn();
    }
  }
  return { state, events };
}

describe('formatEvent', () => {
  it('整局所有事件都能翻译，不抛错，文字里没有 undefined', () => {
    const seen = new Set();
    for (const seed of [1, 2, 3]) {
      const { state, events } = playRecordedGame(seed);
      for (const { type, payload } of events) {
        seen.add(type);
        const text = formatEvent(type, payload, { state, board, cards: CARDS });
        if (text !== null) {
          expect(typeof text).toBe('string');
          expect(text).not.toMatch(/undefined|NaN|\[object/);
        }
      }
    }
    expect(seen).toContain('diceRolled');
    expect(seen).toContain('cardDrawn');
    expect(seen).toContain('gameOver');
  });

  it('付款给银行与多人', () => {
    const { state } = playRecordedGame(1);
    const ctx = { state, board, cards: CARDS };
    expect(formatEvent('paymentMade', { payerId: 'p1', payeeIds: [], amount: 2000, reason: { type: 'tax', tileId: 'tax-income' } }, ctx)).toBe(
      '甲 付给 银行 2,000 元（个人所得税）',
    );
    expect(formatEvent('paymentMade', { payerId: 'p1', payeeIds: ['p2', 'p3'], amount: 1000, reason: null }, ctx)).toBe(
      '甲 付给 乙、丙 1,000 元',
    );
  });
});

describe('animator', () => {
  function setup(reducedMotion = false) {
    const state = createInitialState({ board, rules: RULES, cards: CARDS, players: [{ name: 'A' }, { name: 'B' }], seed: 5 });
    const onEvent = vi.fn();
    const onIdle = vi.fn();
    const animator = createAnimator({ state, reducedMotion, onEvent, onIdle });
    return { animator, onEvent, onIdle };
  }

  it('按顺序播放，移动动画结束后棋子停在终点，idle 只触发一次', () => {
    const { animator, onEvent, onIdle } = setup();
    animator.handle({ playerId: 'p1', dice: [2, 3], total: 5, isDouble: false }, 'diceRolled');
    animator.handle({ playerId: 'p1', from: 0, to: 5, steps: 5, path: [1, 2, 3, 4, 5] }, 'playerMoved');
    animator.handle({ playerId: 'p1', amount: 100 }, 'cashGained');

    animator.tick(0);
    expect(onEvent.mock.calls.map((c) => c[0])).toEqual(['diceRolled']);
    expect(animator.busy).toBe(true);
    animator.tick(10000); // 骰子播完，开始移动
    animator.tick(20000); // 移动播完
    expect(onEvent.mock.calls.map((c) => c[0])).toEqual(['diceRolled', 'playerMoved', 'cashGained']);
    expect(animator.tokens.get('p1')).toEqual({ ...gridOf(5), z: 0 });
    expect(animator.dice.values).toEqual([2, 3]);
    expect(animator.busy).toBe(false);
    expect(onIdle).toHaveBeenCalledTimes(1);
    animator.tick(30000);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('减少动态效果时棋子直接到终点，只保留落地停顿', () => {
    const { animator } = setup(true);
    animator.handle({ playerId: 'p1', from: 0, to: 3, steps: 3, path: [1, 2, 3] }, 'playerMoved');
    animator.handle({ playerId: 'p1', from: 3, to: 10 }, 'sentToJail');
    animator.tick(0);
    expect(animator.tokens.get('p1')).toEqual({ ...gridOf(3), z: 0 });
    expect(animator.busy).toBe(true); // 停顿中
    animator.tick(LAND_PAUSE_MS);
    expect(animator.tokens.get('p1')).toEqual({ ...gridOf(10), z: 0 });
    animator.tick(LAND_PAUSE_MS * 2);
    expect(animator.busy).toBe(false);
  });

  it('付款产生飘字，过期后消失', () => {
    const { animator } = setup(true);
    animator.handle({ payerId: 'p1', payeeIds: ['p2'], amount: 40, reason: null }, 'paymentMade');
    animator.tick(0);
    expect(animator.floaters.map((f) => f.text)).toEqual(['−40', '+40']);
    animator.tick(5000);
    expect(animator.floaters).toEqual([]);
  });
});

describe('交易文字', () => {
  it('一边的内容按地产、现金、出狱卡列出；空的一边写明', () => {
    expect(tradeSideText({ properties: ['xining', 'beijing'], cash: 1500, jailCards: 1 }, board)).toBe('西宁、北京、1,500 元、出狱卡 ×1');
    expect(tradeSideText({ properties: [], cash: 0, jailCards: 0 }, board)).toBe('什么都不给');
  });

  it('提议、接受、拒绝都有日志', () => {
    const state = createInitialState({ board, rules: RULES, players: [{ name: '甲' }, { name: '乙' }], seed: 1 });
    const trade = { fromId: 'p1', toId: 'p2', give: { properties: [], cash: 100, jailCards: 0 }, take: { properties: ['xining'], cash: 0, jailCards: 0 } };
    const ctx = { state, board, cards: CARDS };
    expect(formatEvent('tradeProposed', { trade }, ctx)).toBe('甲 向 乙 提议交易：拿出 100 元，换取 西宁');
    expect(formatEvent('tradeAccepted', { trade }, ctx)).toBe('乙 接受了交易');
    expect(formatEvent('tradeRejected', { trade }, ctx)).toBe('乙 拒绝了交易');
  });
});

describe('播放倍速', () => {
  const state = { players: [{ id: 'p1', position: 0 }] };

  it('4× 时骰子动画用 1/4 的时间播完；非法倍速被忽略', () => {
    const animator = createAnimator({ state });
    animator.setSpeed(4);
    animator.setSpeed(0);
    animator.setSpeed(NaN);
    animator.handle({ playerId: 'p1', dice: [2, 3], total: 5, isDouble: false }, 'diceRolled');
    animator.tick(0);
    animator.tick(149);
    expect(animator.busy).toBe(true);
    animator.tick(150); // 600 / 4
    expect(animator.busy).toBe(false);
  });
});

describe('组色带方向', () => {
  it('非角格的朝外方向都远离棋盘中心，角格没有方向', () => {
    for (const t of TILES) {
      const out = outwardOf(t.index);
      if (t.index % SIDE === 0) {
        expect(out).toBeNull();
        continue;
      }
      const { gx, gy } = gridOf(t.index);
      const c = SIDE / 2;
      const before = Math.hypot(gx - c, gy - c);
      expect(Math.hypot(gx + out[0] - c, gy + out[1] - c)).toBeGreaterThan(before);
    }
  });
});

describe('移动节奏', () => {
  const state = { players: [{ id: 'p1', position: 0 }] };
  const move = (n) => ({ playerId: 'p1', from: 0, to: n, steps: n, path: Array.from({ length: n }, (_, k) => k + 1) });
  const STEP = 160;

  it('缓动曲线：两端固定，t = 0.5 走一半，前四分之一比匀速慢', () => {
    expect(easeInOut(0)).toBe(0);
    expect(easeInOut(1)).toBe(1);
    expect(easeInOut(0.5)).toBeCloseTo(0.5);
    expect(easeInOut(0.25)).toBeLessThan(0.25);
    expect(easeInOut(0.75)).toBeGreaterThan(0.75);
  });

  it('每格单独缓入缓出：一格的四分之一时间走不到四分之一，一半时间正好在两格中间且跳得最高', () => {
    const a = createAnimator({ state });
    a.handle(move(2), 'playerMoved');
    a.tick(0);
    const start = gridOf(0);
    const next = gridOf(1);
    const progress = () => (a.tokens.get('p1').gx - start.gx) / (next.gx - start.gx);
    a.tick(STEP / 4);
    expect(progress()).toBeLessThan(0.25);
    a.tick(STEP / 2);
    expect(progress()).toBeCloseTo(0.5);
    expect(a.tokens.get('p1').z).toBeCloseTo(0.3);
  });

  it('落地后停顿，停顿结束前不播放后续事件', () => {
    const onEvent = vi.fn();
    const a = createAnimator({ state, onEvent });
    a.handle(move(3), 'playerMoved');
    a.handle({ playerId: 'p1', tileId: 'yinchuan', price: 600 }, 'propertyBought');
    a.tick(0);
    a.tick(3 * STEP); // 刚落地
    expect(a.focus?.index).toBe(3); // 落点立即高亮
    a.tick(3 * STEP + LAND_PAUSE_MS - 1);
    expect(onEvent.mock.calls.map((c) => c[0])).toEqual(['playerMoved']);
    a.tick(3 * STEP + LAND_PAUSE_MS);
    expect(onEvent.mock.calls.map((c) => c[0])).toEqual(['playerMoved', 'propertyBought']);
  });

  it('长路径总时长不超过 2.4 秒；4× 速度时移动和停顿都缩短到 1/4', () => {
    const doneAt = (speed, n) => {
      const a = createAnimator({ state });
      a.setSpeed(speed);
      a.handle(move(n), 'playerMoved');
      a.tick(0);
      for (let t = 1; t < 10000; t++) {
        a.tick(t);
        if (!a.busy) return t;
      }
      return Infinity;
    };
    expect(doneAt(1, 39)).toBe(2400 + LAND_PAUSE_MS);
    expect(doneAt(1, 5)).toBe(5 * STEP + LAND_PAUSE_MS);
    expect(doneAt(4, 5)).toBe((5 * STEP + LAND_PAUSE_MS) / 4);
  });
});

describe('事件日志收起', () => {
  it('条数不超过收起显示数时不需要按钮；否则显示展开或收起', async () => {
    const { COLLAPSED_COUNT, logToggleLabel } = await import('../../src/view/ui/log.js');
    expect(logToggleLabel(0, false)).toBeNull();
    expect(logToggleLabel(COLLAPSED_COUNT, false)).toBeNull();
    expect(logToggleLabel(COLLAPSED_COUNT + 1, false)).toBe(`展开全部记录（共 ${COLLAPSED_COUNT + 1} 条）`);
    expect(logToggleLabel(50, true)).toBe('收起记录');
  });
});

describe('城市事件文字', () => {
  it('选项说明写明概率和金额；稳妥选项不重复金额', async () => {
    const { choiceDetail } = await import('../../src/view/ui/format.js');
    expect(choiceDetail({ outcome: { type: 'gain', amount: 500 } })).toBe('');
    expect(choiceDetail({ outcome: { type: 'gamble', target: 7, win: 2500, lose: 800 }, chance: 21 / 36 })).toBe('掷两颗骰子：7 点及以上（58%）得 2,500 元，否则付 800 元');
    expect(choiceDetail({ outcome: { type: 'upgrade' }, target: { name: '北京' } })).toBe('北京 免费升一级');
    expect(choiceDetail({ outcome: { type: 'upgrade' }, target: null })).toContain('没有可以升级');
  });
});
