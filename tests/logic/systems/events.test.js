import { describe, it, expect } from 'vitest';
import { TILES, GROUPS } from '../../../src/data/config/board.js';
import { RULES } from '../../../src/data/config/rules.js';
import { CARDS } from '../../../src/data/config/cards.js';
import { createBoard } from '../../../src/logic/core/board.js';
import { createEventBus } from '../../../src/logic/core/eventBus.js';
import { createInitialState, GameSetupError } from '../../../src/logic/core/gameState.js';
import { createGame, MAX_CARD_CHAIN } from '../../../src/logic/core/game.js';
import { PHASES as P } from '../../../src/logic/core/turnMachine.js';
import { validateCards } from '../../../src/logic/systems/cards.js';

const board = createBoard({ tiles: TILES, groups: GROUPS, rules: RULES });
const JAIL = TILES.findIndex((t) => t.type === 'jail');
const idx = (id) => TILES.findIndex((t) => t.id === id);

/**
 * @param {{ n?: number, rolls?: number[][], cards?: object[], deck?: Record<string, string[]>, rules?: object }} opts
 *   deck 用于固定牌堆顺序
 */
function setup({ n = 2, rolls, cards = CARDS, deck, rules = RULES } = {}) {
  const state = createInitialState({
    board,
    rules,
    cards,
    players: Array.from({ length: n }, (_, i) => ({ name: `玩家${i + 1}` })),
    seed: 9,
  });
  if (deck) Object.assign(state.decks, structuredClone(deck));
  const bus = createEventBus();
  const events = [];
  bus.on('*', (payload, type) => events.push({ type, payload }));
  const queue = rolls ? [...rolls] : null;
  const fixedRoll = () => {
    const dice = queue.shift();
    if (!dice) throw new Error('测试骰子序列用完');
    return { dice, total: dice[0] + dice[1], isDouble: dice[0] === dice[1] };
  };
  const game = createGame({ board, rules, state, bus, cards, ...(queue && { rollDice: fixedRoll }) });
  return { state, events, game, p1: state.players[0], p2: state.players[1] };
}

const cash0 = RULES.startingCash;

/** 掷骰；停在无主地产时放弃购买，然后结束回合 */
function playTurn(game) {
  game.rollDice();
  if (game.phase === P.AWAIT_DECISION) game.declineProperty();
  return game.endTurn();
}
// 下标：2 命运、4 所得税 2000、5 机会、7 机会、10 监狱、30 入狱、38 奢侈品税 1000

describe('卡牌配置', () => {
  it('真实卡牌通过校验，两个牌堆都有牌', () => {
    expect(validateCards(CARDS, board)).toEqual([]);
    expect(CARDS.filter((c) => c.deck === 'chance').length).toBeGreaterThanOrEqual(12);
    expect(CARDS.filter((c) => c.deck === 'fate').length).toBeGreaterThanOrEqual(12);
  });

  it('坏卡牌被拒绝', () => {
    const bad = [
      { id: 'a', deck: 'chance', title: 't', text: 't', effect: { type: 'gain', amount: 0 } },
      { id: 'a', deck: 'luck', title: 't', text: 't', effect: { type: 'fly' } },
      { id: 'b', deck: 'fate', title: 't', text: 't', effect: { type: 'moveTo', tileId: 'mars' } },
      { id: 'c', deck: 'fate', title: 't', text: 't', effect: { type: 'move', steps: 0 } },
    ];
    const errs = validateCards(bad, board).join('\n');
    expect(errs).toContain('amount');
    expect(errs).toContain('id 重复');
    expect(errs).toContain('未知牌堆');
    expect(errs).toContain('目标格不存在');
    expect(errs).toContain('steps');
    expect(() => createInitialState({ board, rules: RULES, cards: bad, players: [{ name: 'A' }, { name: 'B' }], seed: 1 })).toThrow(
      GameSetupError,
    );
  });

  it('开局洗牌：同种子相同，牌数守恒', () => {
    const a = setup().state.decks;
    const b = setup().state.decks;
    expect(a).toEqual(b);
    expect(a.chance.length + a.fate.length).toBe(CARDS.length);
  });
});

describe('税收', () => {
  it('停在税收格扣钱', () => {
    const { game, p1 } = setup({ rolls: [[1, 3]] });
    game.rollDice();
    expect(p1.cash).toBe(cash0 - 2000);
    expect(game.phase).toBe(P.TURN_END);
  });

  it('现金不足进入还款，破产时地产收回银行', () => {
    const { state, game, p1 } = setup({ n: 3, rolls: [[1, 3]] });
    p1.cash = 100;
    state.properties.xining = { ownerId: 'p1', level: 0, mortgaged: false }; // 抵押价 300
    game.rollDice();
    expect(game.phase).toBe(P.AWAIT_PAYMENT);
    expect(state.pendingDebt).toMatchObject({ creditorId: null, amount: 2000 });
    expect(game.declareBankruptcy().ok).toBe(true);
    expect(state.properties.xining.ownerId).toBeNull();
    expect(state.players[1].cash + state.players[2].cash).toBe(2 * cash0); // 欠银行，其他玩家不得钱
  });
});

describe('卡牌效果', () => {
  /** p1 从 0 掷 2 步到命运格（下标 2），抽指定命运卡 */
  const drawFate = (cardId, opts = {}) => setup({ rolls: [[1, 1], [1, 2]], deck: { fate: [cardId] }, ...opts });

  it('gain / pay', () => {
    const a = drawFate('f-bank-error');
    a.game.rollDice();
    expect(a.p1.cash).toBe(cash0 + 2000);
    const b = drawFate('f-hospital');
    b.game.rollDice();
    expect(b.p1.cash).toBe(cash0 - 1000);
  });

  it('collectFromEach：对方钱不够只付现有现金，不会变负', () => {
    const { state, game, p1 } = drawFate('f-birthday', { n: 3 });
    state.players[2].cash = 30;
    game.rollDice();
    expect(p1.cash).toBe(cash0 + 100 + 30);
    expect(state.players[1].cash).toBe(cash0 - 100);
    expect(state.players[2].cash).toBe(0);
  });

  it('payEach：付给每位存活玩家，破产玩家不收钱', () => {
    const { state, game, p1 } = setup({ n: 4, rolls: [[2, 3]], deck: { chance: ['c-chairman'] } });
    state.players[3].bankrupt = true;
    game.rollDice(); // 到 5 机会
    expect(p1.cash).toBe(cash0 - 1000);
    expect(state.players[1].cash).toBe(cash0 + 500);
    expect(state.players[2].cash).toBe(cash0 + 500);
    expect(state.players[3].cash).toBe(cash0);
  });

  it('payEach 付不起：破产后现金平分给各债主，地产收回银行', () => {
    const { state, game, p1 } = setup({ n: 3, rolls: [[2, 3]], deck: { chance: ['c-chairman'] } });
    p1.cash = 301;
    game.rollDice();
    expect(state.pendingDebt.creditorId).toEqual(['p2', 'p3']);
    expect(game.declareBankruptcy().ok).toBe(true);
    expect(state.players[1].cash).toBe(cash0 + 150);
    expect(state.players[2].cash).toBe(cash0 + 150);
  });

  it('moveTo 起点：领奖且不重复', () => {
    const { game, p1 } = drawFate('f-advance-start');
    game.rollDice();
    expect(p1.position).toBe(0);
    expect(p1.cash).toBe(cash0 + RULES.passStartBonus);
  });

  it('moveTo 地产后触发购买决策', () => {
    const { game, p1 } = setup({ rolls: [[2, 3]], deck: { chance: ['c-to-beijing'] } });
    game.rollDice();
    expect(p1.position).toBe(idx('beijing'));
    expect(game.phase).toBe(P.AWAIT_DECISION);
  });

  it('后退 3 格：从 7 退到 4 交所得税，不领起点奖励', () => {
    const { game, p1 } = setup({ rolls: [[3, 4]], deck: { chance: ['c-back-3'] } });
    game.rollDice();
    expect(p1.position).toBe(4);
    expect(p1.cash).toBe(cash0 - 2000);
  });

  it('goToJail：直接入狱，不领奖，双数也不追加掷骰', () => {
    const { game, p1 } = drawFate('f-go-jail');
    game.rollDice(); // [1,1] 双数
    expect(p1).toMatchObject({ position: JAIL, inJail: true, cash: cash0 });
    expect(game.phase).toBe(P.TURN_END);
    game.endTurn();
    expect(game.currentPlayer().id).toBe('p2');
  });

  it('repairs：按建筑总等级收费，没有建筑不收', () => {
    const a = setup({ rolls: [[2, 3]], deck: { chance: ['c-repairs'] } });
    Object.assign(a.state.properties.xining, { ownerId: 'p1', level: 2 });
    Object.assign(a.state.properties.yinchuan, { ownerId: 'p1', level: 1 });
    a.game.rollDice();
    expect(a.p1.cash).toBe(cash0 - 3 * 250);
    const b = setup({ rolls: [[2, 3]], deck: { chance: ['c-repairs'] } });
    b.game.rollDice();
    expect(b.p1.cash).toBe(cash0);
  });

  it('普通卡抽完放回牌堆底部，牌堆循环', () => {
    const { state, game } = setup({ rolls: [[2, 3]], deck: { chance: ['c-speeding', 'c-repairs'] } });
    game.rollDice();
    expect(state.decks.chance).toEqual(['c-repairs', 'c-speeding']);
  });

  it('空牌堆不报错，直接结算', () => {
    const { game, p1 } = setup({ rolls: [[2, 3]], deck: { chance: [] } });
    expect(game.rollDice().ok).toBe(true);
    expect(p1.cash).toBe(cash0);
    expect(game.phase).toBe(P.TURN_END);
  });
});

describe('卡牌连锁上限', () => {
  // 构造一组互相跳转的卡：每张都前进 2 格，落到下一个卡牌格
  const loopCards = [
    { id: 'hop', deck: 'chance', title: '跳', text: '前进 2 格', effect: { type: 'move', steps: 2 } },
  ];
  // 格子 1–9 全改为机会格，“前进 2 格”会无限连锁
  const loopTiles = TILES.map((t, i) => (i >= 1 && i <= 9 ? { index: i, type: 'chance', id: `x${i}`, name: '机会' } : t));
  // 被替换掉的颜色组（棕色、浅蓝）不再有地产，从组配置里去掉
  const loopGroups = Object.fromEntries(
    Object.entries(GROUPS).filter(([g]) => loopTiles.some((t) => t.type === 'property' && t.group === g)),
  );

  it(`连续移动最多 ${MAX_CARD_CHAIN} 次后停止`, () => {
    const loopBoard = createBoard({ tiles: loopTiles, groups: loopGroups, rules: RULES });
    const state = createInitialState({ board: loopBoard, rules: RULES, cards: loopCards, players: [{ name: 'A' }, { name: 'B' }], seed: 1 });
    const bus = createEventBus();
    const events = [];
    bus.on('*', (payload, type) => events.push(type));
    const game = createGame({ board: loopBoard, rules: RULES, state, bus, cards: loopCards, rollDice: () => ({ dice: [1, 2], total: 3, isDouble: false }) });
    expect(game.rollDice().ok).toBe(true);
    expect(state.players[0].position).toBe(3 + 2 * MAX_CARD_CHAIN);
    expect(events.filter((t) => t === 'cardDrawn')).toHaveLength(MAX_CARD_CHAIN + 1);
    expect(events).toContain('cardChainLimited');
    expect(game.phase).toBe(P.TURN_END);
  });
});

describe('监狱', () => {
  it('停在入狱格：送进监狱，不经过起点', () => {
    const { game, p1 } = setup({ rolls: [[4, 5]] });
    p1.position = 21;
    game.rollDice();
    expect(p1).toMatchObject({ position: JAIL, inJail: true, cash: cash0 });
  });

  it('停在监狱格只是探监', () => {
    const { game, p1 } = setup({ rolls: [[4, 6]] });
    game.rollDice();
    expect(p1).toMatchObject({ position: JAIL, inJail: false });
  });

  it('掷出双数出狱并移动，不追加掷骰', () => {
    const { game, p1 } = setup({ rolls: [[2, 2]] });
    Object.assign(p1, { inJail: true, position: JAIL });
    game.rollDice();
    expect(p1.inJail).toBe(false);
    expect(p1.position).toBe(JAIL + 4);
    if (game.phase === P.AWAIT_DECISION) game.declineProperty();
    game.endTurn();
    expect(game.currentPlayer().id).toBe('p2');
  });

  it('坐牢 3 回合：前两回合原地，第 3 回合强制保释后移动', () => {
    const { game, p1 } = setup({ rolls: [[1, 2], [3, 1], [1, 2], [1, 3], [2, 4]] });
    Object.assign(p1, { inJail: true, position: JAIL });
    game.rollDice(); // p1 第 1 回合
    expect(p1).toMatchObject({ inJail: true, jailTurns: 1, position: JAIL });
    game.endTurn();
    playTurn(game); // p2 到 4 所得税
    game.rollDice(); // p1 第 2 回合
    expect(p1.jailTurns).toBe(2);
    game.endTurn();
    playTurn(game); // p2 到 8 呼和浩特，放弃购买
    expect(game.currentPlayer().id).toBe('p1');
    game.rollDice(); // p1 第 3 回合：交保释金，走 6 格到 16 长沙
    expect(p1.inJail).toBe(false);
    expect(p1.cash).toBe(cash0 - RULES.jailBail);
    expect(p1.position).toBe(JAIL + 6);
  });

  it('强制保释现金不足：还款阶段变现后出狱移动', () => {
    const { state, game, p1 } = setup({ rolls: [[1, 2]] });
    Object.assign(p1, { inJail: true, position: JAIL, jailTurns: 2, cash: 100 });
    state.properties.beijing.ownerId = 'p1';
    game.rollDice();
    expect(game.phase).toBe(P.AWAIT_PAYMENT);
    expect(p1.position).toBe(JAIL);
    expect(game.mortgage('p1', 'beijing').ok).toBe(true);
    expect(game.payDebt().ok).toBe(true);
    expect(p1.inJail).toBe(false);
    expect(p1.position).toBe(JAIL + 3);
    expect(p1.cash).toBe(100 + 2000 - RULES.jailBail);
  });

  it('强制保释付不起又没资产：破产', () => {
    const { state, game, p1 } = setup({ n: 3, rolls: [[1, 2]] });
    Object.assign(p1, { inJail: true, position: JAIL, jailTurns: 2, cash: 100 });
    game.rollDice();
    expect(game.declareBankruptcy().ok).toBe(true);
    expect(p1.bankrupt).toBe(true);
    game.endTurn();
    expect(game.currentPlayer().id).toBe('p2');
    expect(state.phase).toBe(P.AWAIT_ROLL);
  });

  it('主动保释：现金不足被拒绝，够则出狱后正常掷骰', () => {
    const { game, p1 } = setup({ rolls: [[1, 2]] });
    Object.assign(p1, { inJail: true, position: JAIL, cash: 499 });
    expect(game.payBail().ok).toBe(false);
    expect(p1.inJail).toBe(true);
    p1.cash = 500;
    expect(game.payBail().ok).toBe(true);
    expect(p1).toMatchObject({ inJail: false, cash: 0 });
    game.rollDice();
    expect(p1.position).toBe(JAIL + 3);
  });

  it('出狱卡：抽到持有、离开牌堆，用掉后放回原牌堆', () => {
    const { state, game, p1 } = setup({ rolls: [[1, 1], [1, 2]], deck: { fate: ['f-jail-free', 'f-bank-error'] } });
    game.rollDice();
    expect(p1.jailFreeCards).toEqual(['f-jail-free']);
    expect(state.decks.fate).toEqual(['f-bank-error']);
    Object.assign(p1, { inJail: true, position: JAIL });
    game.endTurn(); // 双数但在狱中，不追加
    expect(game.currentPlayer().id).toBe('p2');
    playTurn(game); // p2 到 3 银川，放弃购买
    expect(game.useJailFreeCard().ok).toBe(true);
    expect(p1.inJail).toBe(false);
    expect(p1.jailFreeCards).toEqual([]);
    expect(state.decks.fate).toEqual(['f-bank-error', 'f-jail-free']);
    expect(game.useJailFreeCard().ok).toBe(false);
  });

  it('破产时持有的出狱卡放回牌堆', () => {
    const { state, game, p1 } = setup({ n: 3, rolls: [[1, 3]] });
    p1.cash = 0;
    p1.jailFreeCards = ['c-jail-free'];
    state.decks.chance = state.decks.chance.filter((id) => id !== 'c-jail-free');
    game.rollDice(); // 所得税
    game.declareBankruptcy();
    expect(state.decks.chance).toContain('c-jail-free');
    expect(p1.jailFreeCards).toEqual([]);
  });

  it('不在狱中或非掷骰阶段不能出狱', () => {
    const { game } = setup({ rolls: [[1, 2]] });
    expect(game.payBail().ok).toBe(false);
    game.rollDice();
    expect(game.useJailFreeCard().ok).toBe(false);
  });

  it('坐牢期间照常收租', () => {
    const { state, game, p1, p2 } = setup({ rolls: [[1, 2], [1, 2]] });
    Object.assign(p1, { inJail: true, position: JAIL });
    state.properties.yinchuan.ownerId = 'p1';
    game.rollDice();
    game.endTurn();
    game.rollDice(); // p2 到银川
    expect(p2.cash).toBe(cash0 - 40);
    expect(p1.cash).toBe(cash0 + 40);
  });
});

describe('5 人局', () => {
  it.each([1, 2, 3])('种子 %i：跑到终局，轮流顺序正确，不变量成立', (seed) => {
    const state = createInitialState({
      board,
      rules: RULES,
      cards: CARDS,
      players: Array.from({ length: 5 }, (_, i) => ({ name: `玩家${i + 1}` })),
      seed,
    });
    const game = createGame({ board, rules: RULES, state, bus: createEventBus(), cards: CARDS });
    const order = [];
    for (let step = 0; step < 100000 && game.phase !== P.GAME_OVER; step++) {
      switch (game.phase) {
        case P.AWAIT_ROLL:
          order.push(game.currentPlayer().id);
          expect(game.rollDice().ok).toBe(true);
          break;
        case P.AWAIT_DECISION:
          if (!game.buyProperty().ok) game.declineProperty();
          break;
        case P.AWAIT_PAYMENT: {
          const me = game.actingPlayerId();
          for (const t of TILES) {
            while (state.properties[t.id]?.ownerId === me && state.properties[t.id].level > 0) game.sellBuilding(me, t.id);
          }
          for (const t of TILES) if (state.properties[t.id]?.ownerId === me) game.mortgage(me, t.id);
          if (!game.payDebt().ok) expect(game.declareBankruptcy().ok).toBe(true);
          break;
        }
        case P.AWAIT_CHOICE:
          // 轮流试不同选项（冒险、升级不可选时退回稳妥）
          if (!game.chooseOption(step % 2).ok) expect(game.chooseOption(0).ok).toBe(true);
          break;
        case P.TURN_END:
          expect(game.endTurn().ok).toBe(true);
          break;
        default:
          throw new Error(`停在中间阶段: ${game.phase}`);
      }
      if (state.players.some((p) => p.cash < 0)) throw new Error('现金为负');
    }
    expect(game.phase).toBe(P.GAME_OVER);
    expect(state.round).toBeLessThanOrEqual(RULES.maxRounds);
    // 开局前 5 次掷骰按座位顺序（双数会让同一人连掷，去重后比较）
    const firstRound = [...new Set(order)].slice(0, 5);
    expect(firstRound).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
  });
});

describe('回合上限', () => {
  it('打满轮数后按总资产判胜', () => {
    const rules = { ...RULES, maxRounds: 2 };
    // 不放卡牌，避免抽到随机卡影响资产
    const { state, game } = setup({ rules, cards: [], rolls: [[3, 4], [1, 2], [3, 4], [1, 2], [3, 4]] });
    state.properties.beijing.ownerId = 'p2';
    while (game.phase !== P.GAME_OVER) {
      game.rollDice();
      if (game.phase === P.AWAIT_DECISION) game.declineProperty();
      game.endTurn();
    }
    expect(state.round).toBe(2);
    expect(state.endReason).toBe('roundLimit');
    expect(state.winnerId).toBe('p2');
    expect(game.netWorth('p2')).toBeGreaterThan(game.netWorth('p1'));
  });

  it('总资产：抵押地产扣除抵押价，建筑按升级费计', () => {
    const { state, game, p1 } = setup();
    p1.cash = 1000;
    Object.assign(state.properties.xining, { ownerId: 'p1', level: 2 });
    Object.assign(state.properties.beijing, { ownerId: 'p1', mortgaged: true });
    expect(game.netWorth('p1')).toBe(1000 + 600 + 2 * 500 + 4000 - 2000);
  });
});
