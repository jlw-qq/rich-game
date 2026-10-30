/**
 * 逻辑层：城市事件卡（稳妥 / 冒险 / 免费升级）。
 */
import { describe, it, expect } from 'vitest';
import { TILES, GROUPS } from '../../../src/data/config/board.js';
import { RULES } from '../../../src/data/config/rules.js';
import { CARDS, REPLACED_CARD_IDS } from '../../../src/data/config/cards.js';
import { createBoard } from '../../../src/logic/core/board.js';
import { createEventBus } from '../../../src/logic/core/eventBus.js';
import { createInitialState, migrateState } from '../../../src/logic/core/gameState.js';
import { createGame } from '../../../src/logic/core/game.js';
import { PHASES as P } from '../../../src/logic/core/turnMachine.js';
import { performAction } from '../../../src/logic/core/actions.js';
import { validateCards } from '../../../src/logic/systems/cards.js';
import { chanceAtLeast, choiceOptions, upgradeTarget } from '../../../src/logic/systems/choice.js';
import { validateState } from '../../../src/logic/core/stateValidator.js';
import { exportSave, importSave } from '../../../src/logic/core/saveGame.js';
import { serializeSave } from '../../../src/data/save/saveFormat.js';
import { createRng } from '../../../src/logic/utils/rng.js';
import { decideAction } from '../../../src/logic/ai/strategy.js';

const board = createBoard({ tiles: TILES, groups: GROUPS, rules: RULES });
const card = (id) => CARDS.find((c) => c.id === id);

/**
 * 两人局，玩家 1 第一次掷 [2, 3] 走到机会格，机会牌堆顶放 cardId。
 * 之后的掷骰依次取 rolls。
 */
function setup(cardId, { rolls = [], cash } = {}) {
  const state = createInitialState({ board, rules: RULES, cards: CARDS, players: [{ name: '甲' }, { name: '乙' }], seed: 7 });
  state.decks.chance = [cardId, ...state.decks.chance.filter((id) => id !== cardId)];
  if (cash !== undefined) state.players[0].cash = cash;
  const queue = [[2, 3], ...rolls];
  const bus = createEventBus();
  const events = [];
  bus.on('*', (payload, type) => events.push({ type, payload }));
  const game = createGame({
    board,
    rules: RULES,
    state,
    bus,
    cards: CARDS,
    rollDice: () => {
      const dice = queue.shift();
      return { dice, total: dice[0] + dice[1], isDouble: dice[0] === dice[1] };
    },
  });
  return { state, game, events, ctx: { state, board, rules: RULES, bus } };
}

describe('城市事件卡配置', () => {
  it('配置合法；第一个选项都是稳妥拿钱', () => {
    expect(validateCards(CARDS, board)).toEqual([]);
    const choices = CARDS.filter((c) => c.effect.type === 'choice');
    expect(choices.length).toBe(8);
    for (const c of choices) expect(c.effect.options[0].outcome.type).toBe('gain');
  });

  it('拒绝无效的选项配置', () => {
    const bad = (options) => validateCards([{ id: 'x', deck: 'chance', title: 't', text: 't', effect: { type: 'choice', options } }], board);
    expect(bad([{ label: 'a', outcome: { type: 'gain', amount: 1 } }]).join()).toContain('2 个选项');
    expect(bad([{ label: 'a', outcome: { type: 'gamble', target: 7, win: 1, lose: 1 } }, { label: 'b', outcome: { type: 'gain', amount: 1 } }]).join()).toContain('稳妥');
    expect(bad([{ label: 'a', outcome: { type: 'gain', amount: 1 } }, { label: 'b', outcome: { type: 'gamble', target: 13, win: 1, lose: 1 } }]).join()).toContain('3–12');
  });

  it('被替换的旧卡都有对应的新卡，且在同一个牌堆', () => {
    for (const [, to] of Object.entries(REPLACED_CARD_IDS)) expect(card(to)?.effect.type).toBe('choice');
    for (const [from, to] of Object.entries(REPLACED_CARD_IDS)) expect(from[0]).toBe(to[0]); // c- / f- 前缀一致
  });
});

describe('概率', () => {
  it('两颗骰子点数和 ≥ N 的概率', () => {
    expect(chanceAtLeast(2)).toBe(1);
    expect(chanceAtLeast(7)).toBeCloseTo(21 / 36);
    expect(chanceAtLeast(12)).toBeCloseTo(1 / 36);
    expect(chanceAtLeast(13)).toBe(0);
  });
});

describe('选择流程', () => {
  it('抽到城市事件后停在选择阶段，由当前玩家操作；其他操作被拒绝', () => {
    const { state, game } = setup('c-new-district');
    game.rollDice();
    expect(game.phase).toBe(P.AWAIT_CHOICE);
    expect(state.pendingChoice).toEqual({ playerId: 'p1', cardId: 'c-new-district' });
    expect(game.actingPlayerId()).toBe('p1');
    expect(game.rollDice().ok).toBe(false);
    expect(game.endTurn().ok).toBe(false);
    expect(game.chooseOption(5).ok).toBe(false);
    expect(game.chooseOption('0').ok).toBe(false);
  });

  it('稳妥：拿钱后回合结束', () => {
    const { state, game } = setup('c-new-district');
    game.rollDice();
    const cash = state.players[0].cash;
    expect(performAction(game, { kind: 'choose', index: 0 }).ok).toBe(true);
    expect(state.players[0].cash).toBe(cash + 500);
    expect(state.pendingChoice).toBeNull();
    expect(game.phase).toBe(P.TURN_END);
  });

  it('冒险：用事件专用随机数掷骰，赢了拿奖金，输了付钱；移动骰子的序列不受影响', () => {
    const results = [];
    for (let k = 0; k < 40; k++) {
      const { state, game, events } = setup('c-new-district');
      state.eventRngState = 1000 + k;
      const diceState = state.rngState;
      game.rollDice();
      const cash = state.players[0].cash;
      game.chooseOption(1);
      const g = events.find((e) => e.type === 'gambleRolled').payload;
      expect(g.total).toBe(g.dice[0] + g.dice[1]);
      expect(g.won).toBe(g.total >= 7);
      expect(state.players[0].cash).toBe(cash + (g.won ? 2500 : -800));
      expect(state.rngState).toBe(diceState);
      results.push(g.won);
    }
    expect(results).toContain(true);
    expect(results).toContain(false);
  });

  it('冒险输了付不起：进入还款阶段', () => {
    const { state, game } = setup('c-new-district', { cash: 100 });
    // 找一个必输的事件随机状态
    for (let s = 1; ; s++) {
      const rng = createRng(s);
      if (rng.int(1, 6) + rng.int(1, 6) < 7) {
        state.eventRngState = s;
        break;
      }
    }
    game.rollDice();
    game.chooseOption(1);
    expect(game.phase).toBe(P.AWAIT_PAYMENT);
    expect(state.pendingDebt).toMatchObject({ debtorId: 'p1', amount: 800, creditorId: null });
  });

  it('免费升级：没有可升级的地产时不能选；有时升级租金涨得最多的一块，不花钱', () => {
    const a = setup('c-expo');
    a.game.rollDice();
    expect(a.game.pendingChoice().options[1].available).toBe(false);
    expect(a.game.chooseOption(1).ok).toBe(false);
    expect(a.game.phase).toBe(P.AWAIT_CHOICE);

    const b = setup('c-expo');
    for (const id of ['xining', 'yinchuan', 'shanghai', 'beijing']) b.state.properties[id].ownerId = 'p1';
    b.game.rollDice();
    expect(upgradeTarget(b.ctx, 'p1').id).toBe('beijing');
    const cash = b.state.players[0].cash;
    expect(b.game.chooseOption(1).ok).toBe(true);
    expect(b.state.properties.beijing.level).toBe(1);
    expect(b.state.players[0].cash).toBe(cash);
  });

  it('组内有抵押、已满级的地产不会成为升级目标', () => {
    const { state, ctx } = setup('c-expo');
    for (const id of ['shanghai', 'beijing']) state.properties[id].ownerId = 'p1';
    state.properties.shanghai.mortgaged = true;
    expect(upgradeTarget(ctx, 'p1')).toBeNull();
    state.properties.shanghai.mortgaged = false;
    state.properties.shanghai.level = 4;
    state.properties.beijing.level = 4;
    expect(upgradeTarget(ctx, 'p1')).toBeNull();
    expect(choiceOptions(ctx, 'p1', card('c-expo'))[1].available).toBe(false);
  });
});

describe('存档', () => {
  const sctx = { board, rules: RULES, cards: CARDS };

  it('选择阶段可以存档，读档后继续选', () => {
    const { state, game } = setup('c-startup');
    game.rollDice();
    const r = importSave(exportSave(state).text, sctx);
    expect(r.ok).toBe(true);
    const g2 = createGame({ board, rules: RULES, state: r.state, bus: createEventBus(), cards: CARDS });
    expect(g2.chooseOption(0).ok).toBe(true);
  });

  it('校验器拒绝无效的城市事件数据', () => {
    const { state, game } = setup('c-startup');
    game.rollDice();
    expect(validateState(state, sctx)).toEqual([]);
    for (const mutate of [
      (s) => (s.pendingChoice = null),
      (s) => (s.pendingChoice.playerId = 'p2'),
      (s) => (s.pendingChoice.cardId = 'c-speeding'),
      (s) => (s.phase = P.TURN_END),
      (s) => (s.eventRngState = -1),
    ]) {
      const bad = structuredClone(state);
      mutate(bad);
      expect(validateState(bad, sctx).length).toBeGreaterThan(0);
    }
  });

  it('版本 3 存档：被替换的卡换成新卡，牌堆顺序不变', () => {
    const state = createInitialState({ board, rules: RULES, cards: CARDS, players: [{ name: '甲' }, { name: '乙' }], seed: 3 });
    const v3 = structuredClone(state);
    v3.version = 3;
    delete v3.pendingChoice;
    delete v3.eventRngState;
    const back = Object.fromEntries(Object.entries(REPLACED_CARD_IDS).map(([a, b]) => [b, a]));
    v3.decks.chance = v3.decks.chance.map((id) => back[id] ?? id);
    v3.decks.fate = v3.decks.fate.map((id) => back[id] ?? id);
    const migrated = migrateState(v3);
    expect(migrated.decks).toEqual(state.decks);
    const loaded = importSave(serializeSave(v3), sctx);
    expect(loaded.ok).toBe(true);
    expect(loaded.state.pendingChoice).toBeNull();
  });
});

describe('AI 选择', () => {
  const view = (state) => ({ state, board, rules: RULES, cards: CARDS });

  it('现金充足时冒险（期望收益更高），现金紧张时稳妥', () => {
    const rich = setup('c-new-district');
    rich.game.rollDice();
    expect(decideAction(view(rich.state), 'p1', { rng: createRng(1) })).toEqual({ kind: 'choose', index: 1 });

    const poor = setup('c-new-district', { cash: 1200 });
    poor.game.rollDice();
    expect(decideAction(view(poor.state), 'p1', { rng: createRng(1) })).toEqual({ kind: 'choose', index: 0 });
  });

  it('不可选的选项不会被选中（简单难度也一样）', () => {
    const { state, game } = setup('c-expo');
    game.rollDice();
    for (let s = 1; s <= 20; s++) {
      expect(decideAction(view(state), 'p1', { level: 'easy', rng: createRng(s) })).toEqual({ kind: 'choose', index: 0 });
    }
    expect(decideAction(view(state), 'p1', { rng: createRng(1) })).toEqual({ kind: 'choose', index: 0 });
  });
});
