import { describe, it, expect } from 'vitest';
import { TILES, GROUPS } from '../../../src/data/config/board.js';
import { RULES } from '../../../src/data/config/rules.js';
import { CARDS } from '../../../src/data/config/cards.js';
import { createBoard } from '../../../src/logic/core/board.js';
import { createEventBus } from '../../../src/logic/core/eventBus.js';
import { createInitialState, validatePlayerSetup } from '../../../src/logic/core/gameState.js';
import { createGame } from '../../../src/logic/core/game.js';
import { PHASES as P } from '../../../src/logic/core/turnMachine.js';
import { performAction } from '../../../src/logic/core/actions.js';
import { createRng } from '../../../src/logic/utils/rng.js';
import { decideAction, reserveFor } from '../../../src/logic/ai/strategy.js';
import { createAiDriver } from '../../../src/logic/ai/driver.js';

const board = createBoard({ tiles: TILES, groups: GROUPS, rules: RULES });
const JAIL = TILES.findIndex((t) => t.type === 'jail');

function setup({ n = 2, rolls, ai = true, level = 'normal', seed = 3, rules = RULES, cards = [] } = {}) {
  const state = createInitialState({
    board,
    rules,
    cards,
    players: Array.from({ length: n }, (_, i) => ({ name: `AI${i + 1}`, isAI: ai, aiLevel: ai ? level : undefined })),
    seed,
  });
  const queue = rolls ? [...rolls] : null;
  const fixedRoll = () => {
    const dice = queue.shift();
    if (!dice) throw new Error('测试骰子序列用完');
    return { dice, total: dice[0] + dice[1], isDouble: dice[0] === dice[1] };
  };
  const game = createGame({ board, rules, state, bus: createEventBus(), cards, ...(queue && { rollDice: fixedRoll }) });
  const view = { state, board, rules };
  const decide = (id = game.actingPlayerId(), lv = level) => decideAction(view, id, { level: lv, rng: createRng(1) });
  return { state, game, view, decide, p1: state.players[0], p2: state.players[1] };
}

const give = (state, id, ownerId, extra = {}) => Object.assign(state.properties[id], { ownerId, ...extra });

describe('开局参数', () => {
  it('aiLevel 校验与默认值', () => {
    expect(validatePlayerSetup([{ name: 'A' }, { name: 'B', isAI: true, aiLevel: 'hard' }], RULES).join()).toContain('aiLevel');
    const state = createInitialState({ board, rules: RULES, players: [{ name: 'A' }, { name: 'B', isAI: true }], seed: 1 });
    expect(state.players.map((p) => p.aiLevel)).toEqual([null, 'normal']);
  });
});

describe('performAction', () => {
  it('未知操作返回错误，不抛异常', () => {
    const { game } = setup();
    expect(performAction(game, { kind: 'fly' }).ok).toBe(false);
    expect(performAction(game, null).ok).toBe(false);
  });
});

describe('策略：普通难度', () => {
  it('掷骰阶段默认掷骰，回合结束阶段结束回合', () => {
    const { game, decide } = setup({ rolls: [[1, 2]] });
    expect(decide()).toEqual({ kind: 'roll' });
    game.rollDice(); // 到银川，等待决策
    game.declineProperty();
    expect(decide()).toEqual({ kind: 'endTurn' });
  });

  it('买地：留得出安全现金就买，留不出就不买', () => {
    const a = setup({ rolls: [[1, 2]] });
    a.game.rollDice();
    expect(a.decide()).toEqual({ kind: 'buy' });

    const b = setup({ rolls: [[1, 2]] });
    b.p1.cash = 1200; // 买 600 后剩 600 < 1000
    b.game.rollDice();
    expect(b.decide()).toEqual({ kind: 'decline' });
  });

  it('买地：能凑组时放宽到一半安全现金', () => {
    const { state, game, decide, p1 } = setup({ rolls: [[1, 2]] });
    give(state, 'xining', 'p1');
    p1.cash = 1200; // 剩 600 ≥ 500
    game.rollDice();
    expect(decide()).toEqual({ kind: 'buy' });
  });

  it('安全现金随对手最高租金提高，且有上限', () => {
    const { state, view } = setup();
    expect(reserveFor(view, 'p1')).toBe(1000);
    give(state, 'tianjin', 'p2', { level: 2 }); // 租 3600
    expect(reserveFor(view, 'p1')).toBe(3600);
    give(state, 'beijing', 'p2', { level: 4 }); // 租 17000
    expect(reserveFor(view, 'p1')).toBe(6000);
  });

  it('升级：整组在手、现金充足时先升级再掷骰，低等级优先', () => {
    const { state, decide } = setup();
    give(state, 'xining', 'p1', { level: 1 });
    give(state, 'yinchuan', 'p1');
    expect(decide()).toEqual({ kind: 'upgrade', tileId: 'yinchuan' });
  });

  it('升级：不成组、组内有抵押、钱不够都不升', () => {
    const a = setup();
    give(a.state, 'xining', 'p1');
    expect(a.decide()).toEqual({ kind: 'roll' });

    const b = setup();
    give(b.state, 'xining', 'p1');
    give(b.state, 'yinchuan', 'p1', { mortgaged: true });
    b.p1.cash = 100; // 赎不起
    expect(b.decide()).toEqual({ kind: 'roll' });

    const c = setup();
    give(c.state, 'xining', 'p1');
    give(c.state, 'yinchuan', 'p1');
    c.p1.cash = 1400; // 升级后剩 900 < 1000
    expect(c.decide()).toEqual({ kind: 'roll' });
  });

  it('赎回：现金宽裕时先赎回整组里的地', () => {
    const { state, decide } = setup();
    give(state, 'xining', 'p1');
    give(state, 'yinchuan', 'p1', { mortgaged: true });
    give(state, 'beijing', 'p1', { mortgaged: true });
    expect(decide()).toEqual({ kind: 'redeem', tileId: 'yinchuan' });
  });

  it('还款：先抵押零散地，再卖建筑，最后抵押整组；都没了才破产', () => {
    const { state, game, decide, p1 } = setup({ rolls: [[1, 3]] }); // 所得税 2000
    give(state, 'xining', 'p1', { level: 1 });
    give(state, 'yinchuan', 'p1');
    give(state, 'lanzhou', 'p1');
    p1.cash = 0;
    game.rollDice();
    expect(game.phase).toBe(P.AWAIT_PAYMENT);

    const seen = [];
    for (let i = 0; i < 10 && game.phase === P.AWAIT_PAYMENT; i++) {
      const a = decide();
      seen.push(a.tileId ? `${a.kind}:${a.tileId}` : a.kind);
      expect(performAction(game, a).ok).toBe(true);
    }
    // 兰州 500 → 卖西宁建筑 250 → 抵押西宁、银川各 300 = 1350 < 2000 → 破产
    expect(seen).toEqual(['mortgage:lanzhou', 'sell:xining', 'mortgage:xining', 'mortgage:yinchuan', 'bankrupt']);
    expect(p1.bankrupt).toBe(true);
  });

  it('还款：凑够即付款，不多卖', () => {
    const { state, game, decide, p1 } = setup({ rolls: [[1, 3]] });
    give(state, 'beijing', 'p1');
    give(state, 'lanzhou', 'p1');
    p1.cash = 1600;
    game.rollDice();
    expect(decide()).toEqual({ kind: 'mortgage', tileId: 'lanzhou' });
    performAction(game, decide());
    expect(decide()).toEqual({ kind: 'payDebt' });
    expect(state.properties.beijing.mortgaged).toBe(false);
  });

  it('坐牢：对手地产少时尽快出狱（先用卡，再交钱），地产多时留在牢里', () => {
    const a = setup();
    Object.assign(a.p1, { inJail: true, position: JAIL, jailFreeCards: ['c-jail-free'] });
    expect(a.decide()).toEqual({ kind: 'jailCard' });
    a.p1.jailFreeCards = [];
    expect(a.decide()).toEqual({ kind: 'bail' });

    const b = setup();
    Object.assign(b.p1, { inJail: true, position: JAIL });
    TILES.filter((t) => t.type === 'property').slice(0, 10).forEach((t) => give(b.state, t.id, 'p2'));
    expect(b.decide()).toEqual({ kind: 'roll' });
  });

  it('不是自己的回合或已破产时返回 null', () => {
    const { state, view, p2 } = setup();
    state.phase = P.GAME_OVER;
    expect(decideAction(view, 'p1', { rng: createRng(1) })).toBeNull();
    state.phase = P.AWAIT_ROLL;
    p2.bankrupt = true;
    expect(decideAction(view, 'p2', { rng: createRng(1) })).toBeNull();
  });

  it('当前玩家刚破产、停在 turnEnd 时仍结束回合', () => {
    const { state, view, p1 } = setup();
    p1.bankrupt = true;
    state.phase = P.TURN_END;
    expect(decideAction(view, 'p1', { rng: createRng(1) })).toEqual({ kind: 'endTurn' });
  });
});

describe('策略：简单难度', () => {
  it('同一随机种子决策可复现，只返回合法的操作种类', () => {
    const kinds = new Set();
    for (let s = 1; s <= 50; s++) {
      const { game, view } = setup({ rolls: [[1, 2]], level: 'easy' });
      game.rollDice();
      const a = decideAction(view, 'p1', { level: 'easy', rng: createRng(s) });
      const b = decideAction(view, 'p1', { level: 'easy', rng: createRng(s) });
      expect(a).toEqual(b);
      kinds.add(a.kind);
    }
    expect([...kinds].sort()).toEqual(['buy', 'decline']);
  });
});

describe('driver 兜底', () => {
  function driverSetup(decide, opts = {}) {
    const s = setup({ rolls: Array.from({ length: 50 }, () => [1, 2]), ...opts });
    const driver = createAiDriver({ game: s.game, state: s.state, board, rules: RULES, decide, maxStepsPerTurn: 5 });
    return { ...s, driver };
  }

  it('人类回合不操作', () => {
    const s = setup({ ai: false });
    const driver = createAiDriver({ game: s.game, state: s.state, board, rules: RULES });
    expect(driver.step()).toBeNull();
  });

  it('决策抛错 → 兜底掷骰', () => {
    const { driver, game } = driverSetup(() => {
      throw new Error('boom');
    });
    const r = driver.step();
    expect(r).toMatchObject({ fallback: true, error: expect.stringContaining('boom') });
    expect(game.phase).not.toBe(P.AWAIT_ROLL);
  });

  it('非法操作 → 兜底', () => {
    const { driver } = driverSetup(() => ({ kind: 'buy' }));
    const r = driver.step();
    expect(r.fallback).toBe(true);
    expect(r.result.ok).toBe(true);
  });

  it('返回 null → 兜底', () => {
    const { driver } = driverSetup(() => null);
    expect(driver.step()).toMatchObject({ fallback: true });
  });

  it('坏策略也能让整局在有限步内结束', () => {
    let k = 0;
    const kinds = ['upgrade', 'redeem', 'buy', 'sell', 'mortgage', 'bail', 'fly'];
    const s = setup({ n: 3, seed: 8, cards: CARDS });
    const driver = createAiDriver({ game: s.game, state: s.state, board, rules: RULES, decide: () => ({ kind: kinds[k++ % kinds.length], tileId: 'beijing' }) });
    let steps = 0;
    while (driver.isAiTurn() && steps++ < 50000) driver.step();
    expect(s.game.phase).toBe(P.GAME_OVER);
  });

  it('付不起欠款时兜底：先付款，不行再破产，必定推进', () => {
    const { state, game, driver, p1 } = driverSetup(() => ({ kind: 'endTurn' }), { n: 3 });
    give(state, 'yinchuan', 'p2', { level: 4 });
    p1.cash = 100;
    give(state, 'beijing', 'p1');
    driver.step(); // endTurn 非法 → 兜底掷骰，到银川欠 3200
    expect(game.phase).toBe(P.AWAIT_PAYMENT);
    driver.step(); // endTurn 非法 → 兜底：变现 2100 不够，破产
    expect(p1.bankrupt).toBe(true);
  });
});

describe('AI 对战', () => {
  /** 全 AI 跑到终局，检查不变量。返回统计 */
  function selfPlay({ n, seed, level = 'normal', rules = RULES }) {
    const state = createInitialState({
      board,
      rules,
      cards: CARDS,
      players: Array.from({ length: n }, (_, i) => ({ name: `AI${i + 1}`, isAI: true, aiLevel: Array.isArray(level) ? level[i] : level })),
      seed,
    });
    const game = createGame({ board, rules, state, bus: createEventBus(), cards: CARDS });
    const driver = createAiDriver({ game, state, board, rules, seed });
    let steps = 0;
    while (driver.isAiTurn() && steps < 200000) {
      steps++;
      const r = driver.step();
      if (!r.result.ok) throw new Error(`兜底也失败了: ${r.result.error}`);
      for (const p of state.players) if (p.cash < 0) throw new Error(`现金为负: ${p.id}`);
      for (const [id, prop] of Object.entries(state.properties)) {
        const owner = state.players.find((p) => p.id === prop.ownerId);
        if (prop.ownerId && owner.bankrupt) throw new Error(`${id} 属于已破产玩家`);
        if (prop.mortgaged && prop.level > 0) throw new Error(`${id} 抵押且有建筑`);
      }
    }
    return { state, steps, fallbacks: driver.stats.fallbacks };
  }

  it('100 局（2–5 人，两档难度混合）全部在有限步内终局，策略不触发兜底', () => {
    let totalFallbacks = 0;
    for (let i = 0; i < 100; i++) {
      const n = 2 + (i % 4);
      const level = Array.from({ length: n }, (_, k) => ((i + k) % 3 === 0 ? 'easy' : 'normal'));
      const { state, fallbacks } = selfPlay({ n, seed: i + 1, level });
      expect(state.phase).toBe(P.GAME_OVER);
      expect(state.round).toBeLessThanOrEqual(RULES.maxRounds);
      expect(state.winnerId).not.toBeNull();
      totalFallbacks += fallbacks;
    }
    expect(totalFallbacks).toBe(0);
  });
});
