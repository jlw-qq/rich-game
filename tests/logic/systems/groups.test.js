/**
 * 逻辑层：凑齐颜色组的事件（groupCompleted）。买地、拍下、交易、继承破产资产都可能凑齐。
 */
import { describe, it, expect } from 'vitest';
import { TILES, GROUPS } from '../../../src/data/config/board.js';
import { RULES } from '../../../src/data/config/rules.js';
import { CARDS } from '../../../src/data/config/cards.js';
import { createBoard } from '../../../src/logic/core/board.js';
import { createEventBus } from '../../../src/logic/core/eventBus.js';
import { createInitialState } from '../../../src/logic/core/gameState.js';
import { createGame } from '../../../src/logic/core/game.js';
import { liquidateForBankruptcy } from '../../../src/logic/systems/bankruptcy.js';

const board = createBoard({ tiles: TILES, groups: GROUPS, rules: RULES });
// 棕色组：西宁(1) / 银川(3)

function setup() {
  const state = createInitialState({ board, rules: RULES, cards: CARDS, players: [1, 2, 3].map((i) => ({ name: `玩家${i}` })), seed: 1 });
  const bus = createEventBus();
  const events = [];
  bus.on('*', (payload, type) => events.push({ type, payload }));
  const game = createGame({ board, rules: RULES, state, bus, cards: CARDS, rollDice: () => ({ dice: [1, 2], total: 3, isDouble: false }) });
  const groups = () => events.filter((e) => e.type === 'groupCompleted').map((e) => e.payload);
  return { state, bus, game, groups };
}

const BROWN = { group: 'brown', tileIds: ['xining', 'yinchuan'] };

describe('凑齐颜色组', () => {
  it('买下组里最后一块时发出，买下第一块时不发', () => {
    const { state, game, groups } = setup();
    game.rollDice();
    game.buyProperty();
    expect(groups()).toEqual([]);
    state.properties.yinchuan.ownerId = null;
    state.properties.xining.ownerId = 'p1';
    const s2 = setup();
    s2.state.properties.xining.ownerId = 'p1';
    s2.game.rollDice();
    s2.game.buyProperty();
    expect(s2.groups()).toEqual([{ playerId: 'p1', ...BROWN }]);
  });

  it('拍下组里最后一块时发出', () => {
    const { state, game, groups } = setup();
    state.properties.xining.ownerId = 'p2';
    game.rollDice();
    game.declineProperty();
    game.auctionBid('p2', 60);
    game.auctionPass('p3');
    game.auctionPass('p1');
    expect(state.properties.yinchuan.ownerId).toBe('p2');
    expect(groups()).toEqual([{ playerId: 'p2', ...BROWN }]);
  });

  it('交易换来最后一块时，给收到地的一方发出', () => {
    const { state, game, groups } = setup();
    state.properties.xining.ownerId = 'p1';
    state.properties.yinchuan.ownerId = 'p2';
    game.proposeTrade('p1', { toId: 'p2', give: { cash: 500 }, take: { properties: ['yinchuan'] } });
    game.acceptTrade();
    expect(groups()).toEqual([{ playerId: 'p1', ...BROWN }]);
  });

  it('继承破产玩家的地产凑齐时发出；收归银行时不发', () => {
    const a = setup();
    a.state.properties.xining.ownerId = 'p1';
    a.state.properties.yinchuan.ownerId = 'p2';
    liquidateForBankruptcy({ state: a.state, board, rules: RULES, bus: a.bus }, 'p2', 'p1');
    expect(a.groups()).toEqual([{ playerId: 'p1', ...BROWN }]);

    const b = setup();
    b.state.properties.yinchuan.ownerId = 'p2';
    liquidateForBankruptcy({ state: b.state, board, rules: RULES, bus: b.bus }, 'p2', null);
    expect(b.groups()).toEqual([]);
  });
});
