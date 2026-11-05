/**
 * 逻辑层：地产拍卖（轮流加价）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TILES, GROUPS } from '../../../src/data/config/board.js';
import { RULES } from '../../../src/data/config/rules.js';
import { CARDS } from '../../../src/data/config/cards.js';
import { createBoard } from '../../../src/logic/core/board.js';
import { createEventBus } from '../../../src/logic/core/eventBus.js';
import { createInitialState, migrateState, STATE_VERSION } from '../../../src/logic/core/gameState.js';
import { createGame } from '../../../src/logic/core/game.js';
import { performAction } from '../../../src/logic/core/actions.js';
import { PHASES as P } from '../../../src/logic/core/turnMachine.js';
import { validateRules } from '../../../src/logic/core/boardValidator.js';
import { validateState } from '../../../src/logic/core/stateValidator.js';
import { exportSave, importSave } from '../../../src/logic/core/saveGame.js';
import { auctionStartPrice, minBid } from '../../../src/logic/systems/auction.js';
import { decideAction } from '../../../src/logic/ai/strategy.js';
import { createRng } from '../../../src/logic/utils/rng.js';
import { PROTOCOL_VERSION, parseClientMessage } from '../../../src/logic/net/protocol.js';
import { AUCTION_TIMEOUT_MS } from '../../../src/logic/net/match.js';
import { network } from '../net/fakeNet.js';

const board = createBoard({ tiles: TILES, groups: GROUPS, rules: RULES });
const saveCtx = { board, rules: RULES, cards: CARDS };
// 第 3 格银川：标价 600，起拍价 60

/** p1 掷 1+2 走到银川并放弃购买，开拍 */
function auction({ n = 3, cash = null } = {}) {
  const state = createInitialState({ board, rules: RULES, cards: CARDS, players: Array.from({ length: n }, (_, i) => ({ name: `玩家${i + 1}` })), seed: 1 });
  if (cash) cash.forEach((c, i) => (state.players[i].cash = c));
  const bus = createEventBus();
  const events = [];
  bus.on('*', (payload, type) => events.push({ type, payload }));
  const game = createGame({ board, rules: RULES, state, bus, cards: CARDS, rollDice: () => ({ dice: [1, 2], total: 3, isDouble: false }) });
  game.rollDice();
  expect(game.phase).toBe(P.AWAIT_DECISION);
  game.declineProperty();
  const act = (action) => performAction(game, action);
  return { state, game, events, act, types: () => events.map((e) => e.type) };
}

describe('开拍', () => {
  it('从放弃的人的下一位开始轮流，放弃的人排在最后；起拍价为标价的 10%', () => {
    const { state, game, events } = auction({ n: 4 });
    expect(game.phase).toBe(P.AWAIT_AUCTION);
    expect(state.auction).toMatchObject({ tileId: 'yinchuan', starterId: 'p1', start: 60, high: null, highId: null, active: ['p2', 'p3', 'p4', 'p1'], turn: 0 });
    expect(game.actingPlayerId()).toBe('p2');
    expect(events.at(-1)).toEqual({ type: 'auctionStarted', payload: { tileId: 'yinchuan', starterId: 'p1', start: 60, order: ['p2', 'p3', 'p4', 'p1'] } });
    expect(auctionStartPrice({ price: 3500 }, RULES)).toBe(350);
    expect(auctionStartPrice({ price: 50 }, RULES)).toBe(10);
  });

  it('破产玩家不参加', () => {
    const state = createInitialState({ board, rules: RULES, cards: CARDS, players: [1, 2, 3].map((i) => ({ name: `玩家${i}` })), seed: 1 });
    Object.assign(state.players[1], { bankrupt: true, bankruptOrder: 1, cash: 0 });
    const game = createGame({ board, rules: RULES, state, bus: createEventBus(), cards: CARDS, rollDice: () => ({ dice: [1, 2], total: 3, isDouble: false }) });
    game.rollDice();
    game.declineProperty();
    expect(state.auction.active).toEqual(['p3', 'p1']);
  });

  it('所有人都出不起起拍价：当场流拍，回合照常结束', () => {
    const { state, game, types } = auction({ cash: [50, 10, 59] });
    expect(game.phase).toBe(P.TURN_END);
    expect(state.auction).toBeNull();
    expect(state.properties.yinchuan.ownerId).toBeNull();
    expect(types().filter((t) => t === 'auctionPassed').length).toBe(3);
    expect(types()).toContain('auctionUnsold');
  });

  it('规则校验：起拍比例和最低加价', () => {
    expect(validateRules(RULES)).toEqual([]);
    expect(validateRules({ ...RULES, auctionStartRate: 0 }).join()).toContain('auctionStartRate');
    expect(validateRules({ ...RULES, auctionStartRate: 1.5 }).join()).toContain('auctionStartRate');
    expect(validateRules({ ...RULES, auctionMinRaise: 0 }).join()).toContain('auctionMinRaise');
  });
});

describe('出价', () => {
  it('第一口不低于起拍价，之后至少加 100；不能超过现金；只能轮到自己时出', () => {
    const { state, game, act } = auction({ cash: [15000, 300, 15000] });
    expect(act({ kind: 'bid', amount: 50 }).error).toContain('至少 60');
    expect(act({ kind: 'bid', amount: 60.5 }).error).toContain('整数');
    expect(act({ kind: 'bid', amount: 301 }).error).toContain('现金不足');
    expect(game.auctionBid('p3', 100).error).toContain('还没轮到');
    expect(act({ kind: 'bid', amount: 60 }).ok).toBe(true);
    expect(state.auction).toMatchObject({ high: 60, highId: 'p2' });
    expect(game.actingPlayerId()).toBe('p3');
    expect(minBid({ state, rules: RULES })).toBe(160);
    expect(act({ kind: 'bid', amount: 159 }).error).toContain('至少 160');
    expect(act({ kind: 'bid', amount: 400 }).ok).toBe(true);
    // 拍卖中不能抵押、卖楼凑钱，也不能掷骰、结束回合
    expect(game.mortgage('p1', 'xining').ok).toBe(false);
    expect(act({ kind: 'roll' }).ok).toBe(false);
    expect(act({ kind: 'endTurn' }).ok).toBe(false);
    expect(act({ kind: 'buy' }).ok).toBe(false);
  });

  it('轮到时现金不够最低出价的人自动退出', () => {
    const { state, act, events } = auction({ cash: [15000, 15000, 300] });
    act({ kind: 'bid', amount: 250 });
    // p3 只有 300，最低要 350：自动退出，轮到 p1
    expect(state.auction.active).toEqual(['p2', 'p1']);
    expect(events.at(-1)).toEqual({ type: 'auctionPassed', payload: { playerId: 'p3', reason: 'cash' } });
  });
});

describe('结束', () => {
  it('只剩最高出价者时按出价成交：钱付给银行，地归他，回合照常结束', () => {
    const { state, game, act, events } = auction({ cash: [15000, 15000, 15000] });
    act({ kind: 'bid', amount: 60 }); // p2
    act({ kind: 'bid', amount: 200 }); // p3
    act({ kind: 'pass' }); // p1
    act({ kind: 'bid', amount: 300 }); // p2
    act({ kind: 'pass' }); // p3
    expect(game.phase).toBe(P.TURN_END);
    expect(state.auction).toBeNull();
    expect(state.properties.yinchuan.ownerId).toBe('p2');
    expect(state.players.map((p) => p.cash)).toEqual([15000, 14700, 15000]);
    expect(events.at(-3)).toEqual({ type: 'auctionWon', payload: { playerId: 'p2', tileId: 'yinchuan', amount: 300 } });
    // 回合还是 p1 的
    expect(game.currentPlayer().id).toBe('p1');
  });

  it('放弃购买的人自己也能在拍卖里低价拿下', () => {
    const { state, act } = auction();
    act({ kind: 'pass' });
    act({ kind: 'pass' });
    expect(state.auction.active).toEqual(['p1']);
    act({ kind: 'bid', amount: 60 });
    expect(state.properties.yinchuan.ownerId).toBe('p1');
    expect(state.players[0].cash).toBe(RULES.startingCash - 60);
  });

  it('所有人都退出且没人出价：流拍，地产继续无主', () => {
    const { state, game, act, types } = auction();
    act({ kind: 'pass' });
    act({ kind: 'pass' });
    act({ kind: 'pass' });
    expect(game.phase).toBe(P.TURN_END);
    expect(state.properties.yinchuan.ownerId).toBeNull();
    expect(types()).toContain('auctionUnsold');
    expect(state.players.every((p) => p.cash === RULES.startingCash)).toBe(true);
  });

  it('最高出价者轮不到自己；退出后不能再回来', () => {
    const { state, game, act } = auction({ n: 4 });
    act({ kind: 'bid', amount: 60 }); // p2
    act({ kind: 'pass' }); // p3
    act({ kind: 'pass' }); // p4
    // p1 也退出：只剩 p2，成交，不会再轮到 p2 自己
    act({ kind: 'pass' });
    expect(state.properties.yinchuan.ownerId).toBe('p2');
    expect(game.auctionBid('p3', 500).ok).toBe(false);
  });
});

describe('存档', () => {
  it('拍卖中途存档再读回，进度不变，可以接着拍', () => {
    const { state, act } = auction();
    act({ kind: 'bid', amount: 60 });
    const saved = exportSave(state);
    expect(saved.ok).toBe(true);
    const loaded = importSave(saved.text, saveCtx);
    expect(loaded.ok).toBe(true);
    expect(loaded.state.auction).toEqual(state.auction);
    const game2 = createGame({ board, rules: RULES, state: loaded.state, bus: createEventBus(), cards: CARDS });
    expect(game2.actingPlayerId()).toBe('p3');
    expect(performAction(game2, { kind: 'bid', amount: 160 }).ok).toBe(true);
  });

  it('改坏的拍卖数据被拒绝', () => {
    const { state, act } = auction();
    act({ kind: 'bid', amount: 60 });
    const bad = (mut) => {
      const s = structuredClone(state);
      mut(s);
      return validateState(s, saveCtx).join('；');
    };
    expect(bad(() => {})).toBe('');
    expect(bad((s) => (s.auction = null))).toContain('缺少拍卖数据');
    expect(bad((s) => (s.auction.tileId = 'start'))).toContain('不是地产');
    expect(bad((s) => (s.properties.yinchuan.ownerId = 'p3'))).toContain('已经有主人');
    expect(bad((s) => (s.auction.starterId = 'p2'))).toContain('当前玩家');
    expect(bad((s) => (s.auction.active = ['p2', 'p2']))).toContain('在场玩家');
    expect(bad((s) => (s.auction.active = ['p9']))).toContain('在场玩家');
    expect(bad((s) => (s.auction.turn = 5))).toContain('轮次');
    expect(bad((s) => (s.auction.high = 10))).toContain('最高出价无效');
    expect(bad((s) => (s.players[1].cash = 10))).toContain('现金不足');
    expect(bad((s) => Object.assign(s.auction, { high: null, highId: 'p2' }))).toContain('没有出价却有出价人');
    expect(bad((s) => (s.auction.highId = null))).toContain('最高出价人不在场');
    expect(bad((s) => (s.auction.turn = 0))).toContain('已经是最高出价者');
    expect(bad((s) => (s.auction.active = ['p2']))).toContain('应已成交');
    expect(bad((s) => (s.phase = P.TURN_END))).toContain('非拍卖阶段');
  });

  it('版本 5 存档迁移后没有拍卖', () => {
    expect(STATE_VERSION).toBeGreaterThanOrEqual(6);
    expect(migrateState({ version: 5, players: [] })).toMatchObject({ version: STATE_VERSION, auction: null });
  });
});

describe('AI 出价', () => {
  const view = (state) => ({ state, board, rules: RULES, cards: CARDS });

  it('心理价以内跟价，超过就退出；从不出到现金减安全现金以上', () => {
    const { state } = auction({ cash: [15000, 15000, 15000] });
    const a = decideAction(view(state), 'p2', { level: 'normal', rng: createRng(1) });
    expect(a).toEqual({ kind: 'bid', amount: 60 });
    // 已经抬到 590：普通 AI 心理价 480（标价 600 × 0.8）以下，退出
    state.auction.high = 590;
    state.auction.highId = 'p3';
    expect(decideAction(view(state), 'p2', { level: 'normal', rng: createRng(1) })).toEqual({ kind: 'pass' });
  });

  it('能凑齐颜色组时愿意出到标价以上', () => {
    const { state } = auction({ cash: [15000, 15000, 15000] });
    state.properties.xining.ownerId = 'p2';
    state.auction.high = 600;
    state.auction.highId = 'p3';
    const a = decideAction(view(state), 'p2', { level: 'normal', rng: createRng(1) });
    expect(a.kind).toBe('bid');
    expect(a.amount).toBeGreaterThan(600);
    expect(a.amount).toBeLessThanOrEqual(Math.floor(600 * 1.3));
  });

  it('现金减去安全现金（至少 1000）出不起最低价时退出', () => {
    const { state } = auction({ cash: [15000, 1050, 15000] });
    expect(decideAction(view(state), 'p2', { level: 'normal', rng: createRng(1) })).toEqual({ kind: 'pass' });
  });
});

describe('联网拍卖', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('出价消息通过检查，金额只接受整数', () => {
    const parse = (action) => parseClientMessage(JSON.stringify({ v: PROTOCOL_VERSION, t: 'action', action }));
    expect(parse({ kind: 'bid', amount: 500 }).msg.action).toEqual({ kind: 'bid', amount: 500 });
    expect(parse({ kind: 'pass' }).ok).toBe(true);
    for (const amount of [-1, 1.5, '500', 2e9]) expect(parse({ kind: 'bid', amount }).ok, String(amount)).toBe(false);
  });

  it('轮到的人 10 秒不出价算退出，所有人收到说明', () => {
    const net = network({ matchOptions: { aiDelayMs: 10, turnTimeoutMs: 60_000, readyTimeoutMs: 500, auctionTimeoutMs: AUCTION_TIMEOUT_MS } });
    const a = net.client('a');
    const b = net.client('b');
    a.send('create', { name: '阿红' });
    b.send('join', { code: a.inbox.at(-1).room.code, name: '阿蓝' });
    a.send('start');
    // 让阿红走到一块无主地并放弃
    for (let i = 0; i < 50 && a.state.phase !== P.AWAIT_AUCTION; i++) {
      const acting = a.state.phase === P.AWAIT_ROLL || a.state.phase === P.TURN_END || a.state.phase === P.AWAIT_DECISION ? a.state.players[a.state.currentPlayerIndex].id : null;
      const who = acting === 'p1' ? a : b;
      const kind = { awaitRoll: 'roll', turnEnd: 'endTurn', awaitDecision: 'decline' }[a.state.phase];
      if (!kind) break;
      who.send('action', { action: { kind } });
    }
    expect(a.state.phase).toBe(P.AWAIT_AUCTION);
    const turn = a.state.auction.active[a.state.auction.turn];
    const name = a.state.players.find((p) => p.id === turn).name;
    vi.advanceTimersByTime(AUCTION_TIMEOUT_MS - 1);
    net.pump();
    expect(a.state.auction.active).toContain(turn);
    vi.advanceTimersByTime(1);
    net.pump();
    const notice = a.inbox.filter((m) => m.t === 'update').at(-1).notice;
    expect(notice).toBe(`${name} 超过 10 秒没出价，算退出`);
    expect(a.state.auction?.active ?? []).not.toContain(turn);
    expect(b.state).toEqual(a.state);
  });
});
