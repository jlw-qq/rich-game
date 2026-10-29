import { describe, it, expect } from 'vitest';
import { TILES, GROUPS } from '../../../src/data/config/board.js';
import { RULES } from '../../../src/data/config/rules.js';
import { CARDS } from '../../../src/data/config/cards.js';
import { createBoard } from '../../../src/logic/core/board.js';
import { createEventBus } from '../../../src/logic/core/eventBus.js';
import { createInitialState, migrateState, STATE_VERSION } from '../../../src/logic/core/gameState.js';
import { createGame } from '../../../src/logic/core/game.js';
import { PHASES as P } from '../../../src/logic/core/turnMachine.js';
import { performAction } from '../../../src/logic/core/actions.js';
import { prepareTrade } from '../../../src/logic/systems/trade.js';
import { exportSave, importSave } from '../../../src/logic/core/saveGame.js';
import { validateState } from '../../../src/logic/core/stateValidator.js';
import { serializeSave } from '../../../src/data/save/saveFormat.js';
import { createRng } from '../../../src/logic/utils/rng.js';
import { decideAction, evaluateTrade } from '../../../src/logic/ai/strategy.js';
import { createAiDriver } from '../../../src/logic/ai/driver.js';

const board = createBoard({ tiles: TILES, groups: GROUPS, rules: RULES });
// 棕色组：西宁 600 / 银川 600；深蓝组：上海 3500 / 北京 4000

function setup({ n = 2, ai = false, level = 'normal', rolls, cards = CARDS } = {}) {
  const state = createInitialState({
    board,
    rules: RULES,
    cards,
    players: Array.from({ length: n }, (_, i) => ({ name: `玩家${i + 1}`, isAI: ai, aiLevel: ai ? level : undefined })),
    seed: 5,
  });
  const bus = createEventBus();
  const events = [];
  bus.on('*', (payload, type) => events.push({ type, payload }));
  const queue = rolls ? [...rolls] : null;
  const fixedRoll = () => {
    const dice = queue.shift();
    return { dice, total: dice[0] + dice[1], isDouble: dice[0] === dice[1] };
  };
  const game = createGame({ board, rules: RULES, state, bus, cards, ...(queue && { rollDice: fixedRoll }) });
  const ctx = { state, board, rules: RULES, bus };
  return { state, game, events, ctx, p1: state.players[0], p2: state.players[1] };
}

const give = (state, id, ownerId, extra = {}) => Object.assign(state.properties[id], { ownerId, ...extra });
const side = (properties = [], cash = 0, jailCards = 0) => ({ properties, cash, jailCards });
const offer = (toId, g, t) => ({ toId, give: g, take: t });

describe('交易校验', () => {
  it('拒绝无效的玩家、空交易、和自己交易', () => {
    const { ctx } = setup();
    expect(prepareTrade(ctx, null).ok).toBe(false);
    expect(prepareTrade(ctx, { fromId: 'p1', toId: 'p9', give: side([], 100) }).ok).toBe(false);
    expect(prepareTrade(ctx, { fromId: 'p1', toId: 'p1', give: side([], 100) }).ok).toBe(false);
    expect(prepareTrade(ctx, { fromId: 'p1', toId: 'p2', give: side(), take: side() }).error).toContain('不能为空');
  });

  it.each([
    ['负数现金', side([], -1)],
    ['小数现金', side([], 1.5)],
    ['NaN 现金', side([], NaN)],
    ['字符串现金', { cash: '100' }],
    ['地产不是数组', { properties: 'xining' }],
    ['地产重复', side(['xining', 'xining'])],
    ['负数出狱卡', side([], 0, -1)],
  ])('拒绝格式错误：%s', (_, bad) => {
    const { state, ctx } = setup();
    give(state, 'xining', 'p1');
    expect(prepareTrade(ctx, { fromId: 'p1', toId: 'p2', give: bad, take: side([], 0) }).ok).toBe(false);
  });

  it('现金、出狱卡超出持有量，或地产不属于该方时拒绝', () => {
    const { state, ctx, p1 } = setup();
    p1.cash = 500;
    expect(prepareTrade(ctx, { fromId: 'p1', toId: 'p2', give: side([], 501) }).error).toContain('现金不足');
    expect(prepareTrade(ctx, { fromId: 'p1', toId: 'p2', give: side([], 500) }).ok).toBe(true);
    expect(prepareTrade(ctx, { fromId: 'p1', toId: 'p2', give: side([], 0, 1) }).ok).toBe(false);
    give(state, 'xining', 'p2');
    expect(prepareTrade(ctx, { fromId: 'p1', toId: 'p2', give: side(['xining']) }).error).toContain('不属于');
    expect(prepareTrade(ctx, { fromId: 'p1', toId: 'p2', take: side(['xining']) }).ok).toBe(true);
    expect(prepareTrade(ctx, { fromId: 'p1', toId: 'p2', take: side(['start']) }).ok).toBe(false);
  });

  it('颜色组内有建筑（哪怕是别的地）时不能交易', () => {
    const { state, ctx } = setup();
    give(state, 'xining', 'p1', { level: 1 });
    give(state, 'yinchuan', 'p1');
    expect(prepareTrade(ctx, { fromId: 'p1', toId: 'p2', give: side(['yinchuan']) }).error).toContain('建筑');
  });

  it('已破产的玩家不能参与交易', () => {
    const { ctx, p2 } = setup({ n: 3 });
    p2.bankrupt = true;
    p2.cash = 0;
    expect(prepareTrade(ctx, { fromId: 'p1', toId: 'p2', give: side([], 100) }).ok).toBe(false);
  });
});

describe('交易流程', () => {
  it('提议 → 对方操作 → 接受：地产（含抵押状态）、现金、出狱卡互换', () => {
    const { state, game, events, p1, p2 } = setup();
    give(state, 'xining', 'p1', { mortgaged: true });
    give(state, 'beijing', 'p2');
    p1.jailFreeCards = ['c-jail-free'];

    const r = game.proposeTrade('p1', offer('p2', side(['xining'], 1000, 1), side(['beijing'], 200)));
    expect(r.ok).toBe(true);
    expect(game.phase).toBe(P.AWAIT_TRADE);
    expect(game.actingPlayerId()).toBe('p2');
    expect(state.tradesThisTurn).toBe(1);

    expect(game.acceptTrade().ok).toBe(true);
    expect(game.phase).toBe(P.AWAIT_ROLL);
    expect(state.pendingTrade).toBeNull();
    expect(state.properties.xining).toMatchObject({ ownerId: 'p2', mortgaged: true });
    expect(state.properties.beijing.ownerId).toBe('p1');
    expect(p1.cash).toBe(RULES.startingCash - 1000 + 200);
    expect(p2.cash).toBe(RULES.startingCash + 1000 - 200);
    expect(p1.jailFreeCards).toEqual([]);
    expect(p2.jailFreeCards).toEqual(['c-jail-free']);
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['tradeProposed', 'tradeAccepted']));
  });

  it('拒绝后资产不变，回到掷骰前', () => {
    const { state, game, p1 } = setup();
    give(state, 'beijing', 'p2');
    game.proposeTrade('p1', offer('p2', side([], 5000), side(['beijing'])));
    expect(game.rejectTrade().ok).toBe(true);
    expect(game.phase).toBe(P.AWAIT_ROLL);
    expect(state.properties.beijing.ownerId).toBe('p2');
    expect(p1.cash).toBe(RULES.startingCash);
  });

  it('交易阶段不能掷骰、升级、抵押、再次提议', () => {
    const { state, game } = setup();
    give(state, 'xining', 'p1');
    give(state, 'yinchuan', 'p1');
    give(state, 'beijing', 'p2');
    game.proposeTrade('p1', offer('p2', side([], 100), side()));
    expect(game.rollDice().ok).toBe(false);
    expect(game.upgrade('p1', 'xining').ok).toBe(false);
    expect(game.mortgage('p2', 'beijing').ok).toBe(false);
    expect(game.proposeTrade('p1', offer('p2', side([], 100), side())).ok).toBe(false);
    expect(game.endTurn().ok).toBe(false);
  });

  it('只能在自己回合掷骰前发起；不在交易阶段不能答复', () => {
    const { game } = setup({ rolls: [[1, 3]] });
    expect(game.proposeTrade('p2', offer('p1', side([], 100), side())).ok).toBe(false);
    expect(game.acceptTrade().ok).toBe(false);
    expect(game.rejectTrade().ok).toBe(false);
    game.rollDice(); // 停在个人所得税，回合结束
    expect(game.phase).toBe(P.TURN_END);
    expect(game.proposeTrade('p1', offer('p2', side([], 100), side())).ok).toBe(false);
  });

  it('每回合最多发起 maxTradesPerTurn 次，换人后清零', () => {
    const { state, game } = setup({ rolls: [[1, 3]] });
    for (let i = 0; i < RULES.maxTradesPerTurn; i++) {
      expect(game.proposeTrade('p1', offer('p2', side([], 100), side())).ok).toBe(true);
      game.rejectTrade();
    }
    expect(game.proposeTrade('p1', offer('p2', side([], 100), side())).error).toContain('最多');
    game.rollDice();
    game.endTurn();
    expect(state.tradesThisTurn).toBe(0);
    expect(game.proposeTrade('p2', offer('p1', side([], 100), side())).ok).toBe(true);
  });

  it('失败的提议不计次数、不改状态', () => {
    const { state, game } = setup();
    const before = structuredClone(state);
    expect(game.proposeTrade('p1', offer('p2', side([], 999999), side())).ok).toBe(false);
    expect(state).toEqual(before);
  });

  it('交易让对方凑齐颜色组后可以立即升级', () => {
    const { state, game } = setup();
    give(state, 'xining', 'p1');
    give(state, 'yinchuan', 'p2');
    game.proposeTrade('p1', offer('p2', side([], 1500), side(['yinchuan'])));
    game.acceptTrade();
    expect(game.upgrade('p1', 'xining').ok).toBe(true);
  });

  it('通过 performAction 走统一入口，操作人取 actingPlayerId', () => {
    const { state, game } = setup();
    give(state, 'beijing', 'p2');
    expect(performAction(game, { kind: 'proposeTrade', trade: offer('p2', side([], 100), side(['beijing'])) }).ok).toBe(true);
    expect(performAction(game, { kind: 'acceptTrade' }).ok).toBe(true);
    expect(state.properties.beijing.ownerId).toBe('p1');
  });
});

describe('交易存档', () => {
  const ctx = { board, rules: RULES, cards: CARDS };

  it('交易阶段可以存档，读档后可以继续答复', () => {
    const { state, game } = setup();
    give(state, 'beijing', 'p2');
    game.proposeTrade('p1', offer('p2', side([], 6000), side(['beijing'])));
    const saved = exportSave(state);
    expect(saved.ok).toBe(true);
    const loaded = importSave(saved.text, ctx);
    expect(loaded.ok).toBe(true);
    const g2 = createGame({ board, rules: RULES, state: loaded.state, bus: createEventBus(), cards: CARDS });
    expect(g2.actingPlayerId()).toBe('p2');
    expect(g2.acceptTrade().ok).toBe(true);
    expect(loaded.state.properties.beijing.ownerId).toBe('p1');
  });

  it('校验器拒绝无效的交易数据', () => {
    const { state, game } = setup();
    game.proposeTrade('p1', offer('p2', side([], 100), side()));
    expect(validateState(state, ctx)).toEqual([]);

    const cases = [
      (s) => (s.pendingTrade = null),
      (s) => (s.pendingTrade.fromId = 'p2'),
      (s) => (s.pendingTrade.give.cash = 999999),
      (s) => (s.pendingTrade.take.properties = ['beijing']), // 北京无主
      (s) => (s.tradesThisTurn = RULES.maxTradesPerTurn + 1),
      (s) => ((s.phase = P.AWAIT_ROLL), s), // 非交易阶段却有交易
    ];
    for (const mutate of cases) {
      const bad = structuredClone(state);
      mutate(bad);
      expect(validateState(bad, ctx).length).toBeGreaterThan(0);
    }
  });

  it('版本 1 的存档自动升级后可以读取', () => {
    const { state } = setup();
    const v1 = structuredClone(state);
    v1.version = 1;
    delete v1.pendingTrade;
    delete v1.tradesThisTurn;
    const loaded = importSave(serializeSave(v1), ctx);
    expect(loaded.ok).toBe(true);
    expect(loaded.state).toMatchObject({ version: STATE_VERSION, pendingTrade: null, tradesThisTurn: 0 });
    expect(migrateState(v1)).not.toBe(v1); // 不修改原对象
    expect(v1.version).toBe(1);
  });

  it('未知版本仍被拒绝', () => {
    const { state } = setup();
    const loaded = importSave(serializeSave({ ...state, version: 99 }), ctx);
    expect(loaded.ok).toBe(false);
  });
});

describe('AI 交易', () => {
  const rng = () => createRng(1);

  it('估值：让对方凑齐颜色组的报价要高于地价加组价的一半才划算', () => {
    const { state } = setup();
    const view = { state, board, rules: RULES };
    give(state, 'shanghai', 'p1');
    give(state, 'beijing', 'p2');
    const t = (cash) => ({ fromId: 'p1', toId: 'p2', give: side([], cash), take: side(['beijing']) });
    // 深蓝组总价 7500，门槛 4000 + 3750 = 7750
    expect(evaluateTrade(view, 'p2', t(7700))).toBeLessThan(0);
    expect(evaluateTrade(view, 'p2', t(7800))).toBeGreaterThan(0);
    // 不看颜色组时只要现金高于地价
    expect(evaluateTrade(view, 'p2', t(4100), { groupAware: false })).toBeGreaterThan(0);
    // 对发起方来说凑齐颜色组是加分
    expect(evaluateTrade(view, 'p1', t(7800))).toBeGreaterThan(evaluateTrade(view, 'p1', t(7800), { groupAware: false }));
  });

  it('普通 AI 差一块凑齐颜色组时向 AI 对手报价，被拒后加价', () => {
    const { state, game } = setup({ ai: true });
    const view = { state, board, rules: RULES };
    give(state, 'xining', 'p1');
    give(state, 'yinchuan', 'p2');
    const first = decideAction(view, 'p1', { rng: rng() });
    expect(first).toMatchObject({ kind: 'proposeTrade', trade: { toId: 'p2', take: { properties: ['yinchuan'] } } });
    performAction(game, first);
    game.rejectTrade();
    const second = decideAction(view, 'p1', { rng: rng() });
    expect(second.trade.give.cash).toBeGreaterThan(first.trade.give.cash);
  });

  it('简单 AI 不主动交易；交易次数用完后不再提议', () => {
    const { state } = setup({ ai: true });
    const view = { state, board, rules: RULES };
    give(state, 'xining', 'p1');
    give(state, 'yinchuan', 'p2');
    expect(decideAction(view, 'p1', { level: 'easy', rng: rng() }).kind).toBe('roll');
    state.tradesThisTurn = RULES.maxTradesPerTurn;
    expect(decideAction(view, 'p1', { rng: rng() }).kind).toBe('roll');
  });

  it('付出现金后低于安全下限时拒绝', () => {
    const { state, game, p2 } = setup({ ai: true });
    const view = { state, board, rules: RULES };
    give(state, 'beijing', 'p1');
    p2.cash = 1500;
    game.proposeTrade('p1', offer('p2', side(['beijing']), side([], 1000)));
    expect(decideAction(view, 'p2', { rng: rng() }).kind).toBe('rejectTrade');
  });

  it('AI 答复人类的交易：划算就接受', () => {
    const { state, game } = setup({ n: 2 });
    state.players[1].isAI = true;
    state.players[1].aiLevel = 'normal';
    give(state, 'xining', 'p2');
    const driver = createAiDriver({ game, state, board, rules: RULES });
    game.proposeTrade('p1', offer('p2', side([], 2000), side(['xining'])));
    expect(driver.isAiTurn()).toBe(true);
    const r = driver.step();
    expect(r).toMatchObject({ action: { kind: 'acceptTrade' }, fallback: false });
    expect(state.properties.xining.ownerId).toBe('p1');
  });

  it('决策出错时兜底拒绝交易，不会卡住', () => {
    const { state, game } = setup({ ai: true });
    const driver = createAiDriver({
      game,
      state,
      board,
      rules: RULES,
      decide: () => {
        throw new Error('坏了');
      },
    });
    game.proposeTrade('p1', offer('p2', side([], 100), side()));
    const r = driver.step();
    expect(r.fallback).toBe(true);
    expect(game.phase).toBe(P.AWAIT_ROLL);
  });

  it('全 AI 对局：交易能成交，且不会触发兜底或死循环', () => {
    let trades = 0;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const state = createInitialState({
        board,
        rules: RULES,
        cards: CARDS,
        players: Array.from({ length: 4 }, (_, i) => ({ name: `AI${i + 1}`, isAI: true, aiLevel: i % 2 ? 'easy' : 'normal' })),
        seed,
      });
      const bus = createEventBus();
      bus.on('tradeAccepted', () => trades++);
      const game = createGame({ board, rules: RULES, state, bus, cards: CARDS });
      const driver = createAiDriver({ game, state, board, rules: RULES });
      let steps = 0;
      while (driver.isAiTurn() && steps++ < 100000) driver.step();
      expect(state.phase).toBe(P.GAME_OVER);
      expect(driver.stats.fallbacks).toBe(0);
    }
    expect(trades).toBeGreaterThan(0);
  });
});
