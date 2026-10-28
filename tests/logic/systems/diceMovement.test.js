import { describe, it, expect } from 'vitest';
import { TILES, GROUPS } from '../../../src/data/config/board.js';
import { RULES } from '../../../src/data/config/rules.js';
import { createBoard } from '../../../src/logic/core/board.js';
import { createEventBus } from '../../../src/logic/core/eventBus.js';
import { createInitialState } from '../../../src/logic/core/gameState.js';
import { createGame } from '../../../src/logic/core/game.js';
import { PHASES as P } from '../../../src/logic/core/turnMachine.js';
import { rollDice } from '../../../src/logic/systems/dice.js';
import { movePlayer, sendToJail } from '../../../src/logic/systems/movement.js';

const board = createBoard({ tiles: TILES, groups: GROUPS, rules: RULES });
const JAIL = TILES.findIndex((t) => t.type === 'jail');

function setup({ n = 2, rolls } = {}) {
  const state = createInitialState({
    board,
    rules: RULES,
    players: Array.from({ length: n }, (_, i) => ({ name: `玩家${i + 1}` })),
    seed: 123,
  });
  const bus = createEventBus();
  const events = [];
  bus.on('*', (payload, type) => events.push({ type, payload }));
  // 固定骰子序列：每项为 [d1, d2]
  const queue = rolls ? [...rolls] : null;
  const fixedRoll = () => {
    const dice = queue.shift();
    if (!dice) throw new Error('测试骰子序列用完');
    return { dice, total: dice[0] + dice[1], isDouble: dice[0] === dice[1] };
  };
  const game = createGame({ board, rules: RULES, state, bus, ...(queue && { rollDice: fixedRoll }) });
  return { state, bus, events, game, ctx: { state, board, rules: RULES, bus } };
}

const types = (events) => events.map((e) => e.type);

/** 掷骰；停在无主地产时放弃购买，让回合走到 turnEnd（本文件只测移动） */
function roll(game) {
  const r = game.rollDice();
  if (game.phase === P.AWAIT_DECISION) game.declineProperty();
  return r;
}

describe('rollDice', () => {
  it('1 万次不越界，2–12 每个总和都出现', () => {
    const state = { rngState: 7 };
    const totals = new Set();
    for (let i = 0; i < 10000; i++) {
      const { dice, total, isDouble } = rollDice(state);
      expect(dice).toHaveLength(2);
      for (const d of dice) expect(d >= 1 && d <= 6 && Number.isInteger(d)).toBe(true);
      expect(total).toBe(dice[0] + dice[1]);
      expect(isDouble).toBe(dice[0] === dice[1]);
      totals.add(total);
    }
    expect([...totals].sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('同种子序列相同，且 rngState 推进后可续接', () => {
    const a = { rngState: 42 };
    const b = { rngState: 42 };
    const seqA = Array.from({ length: 10 }, () => rollDice(a).dice);
    const seqB = Array.from({ length: 5 }, () => rollDice(b).dice);
    // 模拟存档：只保留 rngState
    const resumed = { rngState: JSON.parse(JSON.stringify(b)).rngState };
    seqB.push(...Array.from({ length: 5 }, () => rollDice(resumed).dice));
    expect(seqB).toEqual(seqA);
  });
});

describe('movePlayer / sendToJail', () => {
  it('普通前进不发奖励，路径逐格', () => {
    const { state, ctx, events } = setup();
    movePlayer(ctx, 'p1', 3);
    expect(state.players[0].position).toBe(3);
    expect(state.players[0].cash).toBe(RULES.startingCash);
    expect(events[0].payload.path).toEqual([1, 2, 3]);
  });

  it('经过起点与正好停在起点都发奖励', () => {
    const { state, ctx } = setup();
    const p = state.players[0];
    p.position = 38;
    movePlayer(ctx, 'p1', 4);
    expect(p.position).toBe(2);
    expect(p.cash).toBe(RULES.startingCash + RULES.passStartBonus);
    p.position = 37;
    movePlayer(ctx, 'p1', 3);
    expect(p.position).toBe(0);
    expect(p.cash).toBe(RULES.startingCash + 2 * RULES.passStartBonus);
  });

  it('绕两圈发两次奖励，后退不发奖励', () => {
    const { state, ctx, events } = setup();
    const p = state.players[0];
    movePlayer(ctx, 'p1', 80);
    expect(p.cash).toBe(RULES.startingCash + 2 * RULES.passStartBonus);
    movePlayer(ctx, 'p1', -3);
    expect(p.position).toBe(37);
    expect(p.cash).toBe(RULES.startingCash + 2 * RULES.passStartBonus);
    expect(events.at(-1).payload.path).toEqual([39, 38, 37]);
  });

  it('非法输入抛错且不改状态', () => {
    const { state, ctx } = setup();
    expect(() => movePlayer(ctx, 'p9', 3)).toThrow(RangeError);
    expect(() => movePlayer(ctx, 'p1', 2.5)).toThrow(RangeError);
    expect(state.players[0].position).toBe(0);
  });

  it('入狱不经过起点', () => {
    const { state, ctx } = setup();
    const p = state.players[0];
    p.position = 30;
    sendToJail(ctx, 'p1');
    expect(p).toMatchObject({ position: JAIL, inJail: true, jailTurns: 0, cash: RULES.startingCash });
  });
});

describe('game.rollDice 回合流程', () => {
  it('掷骰 → 移动 → 回合结束 → 换人', () => {
    const { state, game, events } = setup({ rolls: [[2, 3]] });
    const r = roll(game);
    expect(r).toMatchObject({ ok: true, jailed: false });
    expect(state.players[0].position).toBe(5);
    expect(game.phase).toBe(P.TURN_END);
    expect(types(events)).toEqual(expect.arrayContaining(['diceRolled', 'playerMoved']));
    expect(game.endTurn().ok).toBe(true);
    expect(game.currentPlayer().id).toBe('p2');
    expect(state.turn).toBe(2);
  });

  it('非掷骰阶段调用被拒绝，状态不变', () => {
    const { state, game } = setup({ rolls: [[2, 3]] });
    roll(game);
    const before = structuredClone(state);
    expect(game.rollDice().ok).toBe(false);
    expect(state).toEqual(before);
  });

  it('掷骰阶段不能结束回合', () => {
    const { game } = setup();
    expect(game.endTurn().ok).toBe(false);
  });

  it('双数再掷一次，不换人不加回合数', () => {
    const { state, game } = setup({ rolls: [[3, 3], [1, 2]] });
    roll(game);
    expect(game.endTurn().ok).toBe(true);
    expect(game.currentPlayer().id).toBe('p1');
    expect(state.turn).toBe(1);
    expect(game.phase).toBe(P.AWAIT_ROLL);
    roll(game);
    expect(state.players[0].position).toBe(9);
    game.endTurn();
    expect(game.currentPlayer().id).toBe('p2');
    expect(state.doublesCount).toBe(0);
  });

  it('连续 3 次双数入狱，不移动不领奖，结束后换人', () => {
    const { state, game } = setup({ rolls: [[6, 6], [6, 6], [1, 1]] });
    roll(game); // 到 12
    game.endTurn();
    roll(game); // 到 24
    game.endTurn();
    const r = roll(game);
    expect(r.jailed).toBe(true);
    expect(state.players[0]).toMatchObject({ position: JAIL, inJail: true });
    expect(game.phase).toBe(P.TURN_END);
    game.endTurn();
    expect(game.currentPlayer().id).toBe('p2');
    expect(state.doublesCount).toBe(0);
  });

  it('双数计数在换人时清零', () => {
    const { state, game } = setup({ rolls: [[2, 2], [1, 3], [5, 5]] });
    roll(game);
    game.endTurn();
    roll(game); // p1 非双数，doublesCount 清零
    game.endTurn();
    expect(game.currentPlayer().id).toBe('p2');
    roll(game); // p2 双数，计数从 1 开始
    expect(state.doublesCount).toBe(1);
  });

  it('随机骰子跑到回合上限，不卡死、位置不越界', () => {
    const { state, game } = setup({ n: 4 });
    let steps = 0;
    while (game.phase !== P.GAME_OVER && steps++ < 5000) {
      expect(roll(game).ok).toBe(true);
      expect(game.endTurn().ok).toBe(true);
      expect(state.players.every((x) => x.position >= 0 && x.position < 40)).toBe(true);
    }
    expect(game.phase).toBe(P.GAME_OVER);
    expect(state.endReason).toBe('roundLimit');
    expect(state.round).toBe(RULES.maxRounds);
  });
});
