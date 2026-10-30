/**
 * 逻辑层：对局模式（短局 / 经典）、开局分地、目标资产获胜、租金倍数、存档迁移。
 */
import { describe, it, expect } from 'vitest';
import { TILES, GROUPS } from '../../../src/data/config/board.js';
import { RULES } from '../../../src/data/config/rules.js';
import { CARDS } from '../../../src/data/config/cards.js';
import { MODES, rulesFor } from '../../../src/data/config/modes.js';
import { createBoard } from '../../../src/logic/core/board.js';
import { createEventBus } from '../../../src/logic/core/eventBus.js';
import { createInitialState, migrateState, STATE_VERSION } from '../../../src/logic/core/gameState.js';
import { createGame } from '../../../src/logic/core/game.js';
import { createAiDriver } from '../../../src/logic/ai/driver.js';
import { PHASES as P } from '../../../src/logic/core/turnMachine.js';
import { validateRules } from '../../../src/logic/core/boardValidator.js';
import { validateState } from '../../../src/logic/core/stateValidator.js';
import { calcRent, netWorth, rentAt } from '../../../src/logic/systems/property.js';
import { importSave } from '../../../src/logic/core/saveGame.js';
import { serializeSave } from '../../../src/data/save/saveFormat.js';

const board = createBoard({ tiles: TILES, groups: GROUPS, rules: RULES });
const players = (n) => Array.from({ length: n }, (_, i) => ({ name: `P${i + 1}`, isAI: true }));

function quick(n = 4, seed = 1) {
  const rules = rulesFor('quick', n);
  const state = createInitialState({ board, rules, cards: CARDS, players: players(n), seed, mode: 'quick' });
  return { rules, state };
}

describe('模式规则', () => {
  it('每种模式的规则都通过规则校验', () => {
    for (const mode of Object.keys(MODES)) {
      for (const n of [2, 3, 4, 5]) expect(validateRules(rulesFor(mode, n)), `${mode} ${n}人`).toEqual([]);
    }
  });

  it('经典模式与原规则完全一致；短局回合上限随人数减少', () => {
    expect(rulesFor('classic', 4)).toEqual(RULES);
    const rounds = [2, 3, 4, 5].map((n) => rulesFor('quick', n).maxRounds);
    expect(rounds).toEqual([...rounds].sort((a, b) => b - a));
    expect(() => rulesFor('blitz')).toThrow();
  });

  it('未知模式开局被拒绝', () => {
    expect(() => createInitialState({ board, rules: RULES, players: players(2), seed: 1, mode: 'blitz' })).toThrow('模式');
  });
});

describe('开局分地', () => {
  it('短局每人恰好分到规定块数，且没人一开局就凑齐整个颜色组', () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      for (const n of [2, 3, 4, 5]) {
        const { rules, state } = quick(n, seed);
        for (const p of state.players) {
          const owned = TILES.filter((t) => state.properties[t.id]?.ownerId === p.id);
          expect(owned.length).toBe(rules.startingProperties);
          for (const g of Object.keys(GROUPS)) {
            expect(board.getGroupTiles(g).every((t) => state.properties[t.id].ownerId === p.id), `${seed} ${p.id} ${g}`).toBe(false);
          }
        }
        expect(validateState(state, { board, rules: RULES, cards: CARDS })).toEqual([]);
      }
    }
  });

  it('同一个种子分到的地完全一样；经典模式不分地', () => {
    expect(quick(4, 9).state.properties).toEqual(quick(4, 9).state.properties);
    const classic = createInitialState({ board, rules: RULES, cards: CARDS, players: players(4), seed: 9 });
    expect(Object.values(classic.properties).every((p) => p.ownerId === null)).toBe(true);
    expect(classic.mode).toBe('classic');
  });
});

describe('租金倍数', () => {
  it('短局租金翻倍，四舍五入为整数；经典模式不变', () => {
    const tile = TILES.find((t) => t.id === 'xining');
    expect(rentAt(tile, 0, RULES)).toBe(20);
    expect(rentAt(tile, 0, rulesFor('quick', 2))).toBe(40);
    expect(rentAt(tile, 1, { ...RULES, rentMultiplier: 1.25 })).toBe(125);
    expect(rentAt(tile, 0, { ...RULES, rentMultiplier: 1.3 })).toBe(26);
  });

  it('calcRent 使用这一局的倍数（整组空地再翻倍）', () => {
    const rules = rulesFor('quick', 2);
    const state = createInitialState({ board, rules, players: players(2), seed: 1, mode: 'quick' });
    for (const p of Object.values(state.properties)) p.ownerId = null;
    state.properties.xining.ownerId = 'p1';
    const ctx = { state, board, rules };
    expect(calcRent(ctx, 'xining')).toBe(40);
    state.properties.yinchuan.ownerId = 'p1';
    expect(calcRent(ctx, 'xining')).toBe(80);
  });
});

describe('目标资产获胜', () => {
  it('回合结束时总资产达到目标立即获胜，终局原因为 goal', () => {
    const rules = rulesFor('quick', 2);
    const state = createInitialState({ board, rules, players: players(2), seed: 1, mode: 'quick' });
    const game = createGame({ board, rules, state, bus: createEventBus(), rollDice: () => ({ dice: [1, 3], total: 4, isDouble: false }) });
    state.players[1].cash = rules.goalNetWorth; // 对手先达到目标也算：在当前玩家回合结束时判定
    game.rollDice(); // 1 + 3 = 4，停在个人所得税格，付完税回合结束
    expect(state.phase).toBe(P.TURN_END);
    expect(game.endTurn().ok).toBe(true);
    expect(state.phase).toBe(P.GAME_OVER);
    expect(state.endReason).toBe('goal');
    expect(state.winnerId).toBe('p2');
  });

  it('多人同时达到目标时，总资产最高者获胜', () => {
    const rules = rulesFor('quick', 3);
    const state = createInitialState({ board, rules, players: players(3), seed: 1, mode: 'quick' });
    state.phase = P.TURN_END;
    state.players[0].cash = rules.goalNetWorth + 10;
    state.players[2].cash = rules.goalNetWorth + 900;
    const game = createGame({ board, rules, state, bus: createEventBus() });
    game.endTurn();
    expect(state.winnerId).toBe('p3');
  });

  it('经典模式没有目标资产', () => {
    const state = createInitialState({ board, rules: RULES, players: players(2), seed: 1 });
    state.phase = P.TURN_END;
    state.players[0].cash = 10 ** 7;
    const game = createGame({ board, rules: RULES, state, bus: createEventBus() });
    game.endTurn();
    expect(state.phase).toBe(P.AWAIT_ROLL);
  });

  it('短局全 AI 对局都能结束，终局原因合法，且不超过回合上限', () => {
    for (const n of [2, 3, 4, 5]) {
      for (const seed of [11, 12, 13]) {
        const { rules, state } = quick(n, seed);
        const game = createGame({ board, rules, state, bus: createEventBus(), cards: CARDS });
        const driver = createAiDriver({ game, state, board, rules });
        let steps = 0;
        while (driver.isAiTurn() && steps++ < 100000) driver.step();
        expect(state.phase).toBe(P.GAME_OVER);
        expect(['bankruptcy', 'roundLimit', 'goal']).toContain(state.endReason);
        expect(state.round).toBeLessThanOrEqual(rules.maxRounds);
        expect(driver.stats.fallbacks).toBe(0);
        if (state.endReason === 'goal') expect(netWorth({ state, board }, state.winnerId)).toBeGreaterThanOrEqual(rules.goalNetWorth);
      }
    }
  });
});

describe('存档迁移到版本 3', () => {
  const ctx = { board, rules: RULES, cards: CARDS };

  it('版本 2 存档自动按经典模式读取', () => {
    const state = createInitialState({ board, rules: RULES, cards: CARDS, players: players(2), seed: 1 });
    const v2 = structuredClone(state);
    v2.version = 2;
    delete v2.mode;
    const loaded = importSave(serializeSave(v2), ctx);
    expect(loaded.ok).toBe(true);
    expect(loaded.state).toMatchObject({ version: STATE_VERSION, mode: 'classic' });
    expect(migrateState({ version: 1, players: [] })).toMatchObject({ version: STATE_VERSION, mode: 'classic', pendingTrade: null, pendingChoice: null });
  });

  it('短局存档按短局的回合上限校验；未知模式被拒绝', () => {
    const { state } = quick(5, 1);
    state.round = 21; // 5 人短局上限 20
    expect(validateState(state, ctx).join()).toContain('回合上限');
    state.round = 20;
    expect(validateState(state, ctx)).toEqual([]);
    expect(validateState({ ...state, mode: 'blitz' }, ctx).join()).toContain('模式');
  });
});
