import { describe, it, expect } from 'vitest';
import { TILES, GROUPS } from '../../../src/data/config/board.js';
import { RULES } from '../../../src/data/config/rules.js';
import { createBoard } from '../../../src/logic/core/board.js';
import { createEventBus } from '../../../src/logic/core/eventBus.js';
import { createInitialState } from '../../../src/logic/core/gameState.js';
import { createGame } from '../../../src/logic/core/game.js';
import { PHASES as P } from '../../../src/logic/core/turnMachine.js';
import {
  buyProperty,
  calcRent,
  liquidationValue,
  mortgageProperty,
  redeemCost,
  redeemProperty,
  sellBuilding,
  upgradeProperty,
} from '../../../src/logic/systems/property.js';
import { charge, liquidateForBankruptcy } from '../../../src/logic/systems/bankruptcy.js';

const tile = (id) => TILES.find((t) => t.id === id);
// 棕色组：西宁(1) 600 / 银川(3) 600；深蓝组：上海(37) / 北京(39)

function setup({ n = 2, rolls, seed = 1, rules = RULES } = {}) {
  const board = createBoard({ tiles: TILES, groups: GROUPS, rules });
  const state = createInitialState({
    board,
    rules,
    players: Array.from({ length: n }, (_, i) => ({ name: `玩家${i + 1}` })),
    seed,
  });
  const bus = createEventBus();
  const events = [];
  bus.on('*', (payload, type) => events.push({ type, payload }));
  const queue = rolls ? [...rolls] : null;
  const fixedRoll = () => {
    const dice = queue.shift();
    if (!dice) throw new Error('测试骰子序列用完');
    return { dice, total: dice[0] + dice[1], isDouble: dice[0] === dice[1] };
  };
  const game = createGame({ board, rules, state, bus, ...(queue && { rollDice: fixedRoll }) });
  return { state, events, game, ctx: { state, board, rules, bus } };
}

const give = (state, tileId, ownerId, extra = {}) => Object.assign(state.properties[tileId], { ownerId, ...extra });

describe('购买', () => {
  it('现金刚好够可以买，差 1 元不行且状态不变', () => {
    const { state, ctx } = setup();
    const p = state.players[0];
    p.cash = 599;
    expect(buyProperty(ctx, 'p1', 'xining').ok).toBe(false);
    expect(state.properties.xining.ownerId).toBeNull();
    expect(p.cash).toBe(599);
    p.cash = 600;
    expect(buyProperty(ctx, 'p1', 'xining').ok).toBe(true);
    expect(p.cash).toBe(0);
    expect(state.properties.xining.ownerId).toBe('p1');
  });

  it('已有主人、非地产、玩家不存在被拒绝', () => {
    const { state, ctx } = setup();
    give(state, 'xining', 'p2');
    expect(buyProperty(ctx, 'p1', 'xining').ok).toBe(false);
    expect(buyProperty(ctx, 'p1', 'start').ok).toBe(false);
    expect(buyProperty(ctx, 'p9', 'yinchuan').ok).toBe(false);
  });

  it('流程：停在无主地产 → 等待决策 → 买下 → 回合结束', () => {
    const { state, game } = setup({ rolls: [[1, 2]] }); // 到 3 银川
    game.rollDice();
    expect(game.phase).toBe(P.AWAIT_DECISION);
    expect(game.rollDice().ok).toBe(false);
    expect(game.buyProperty().ok).toBe(true);
    expect(state.properties.yinchuan.ownerId).toBe('p1');
    expect(game.phase).toBe(P.TURN_END);
  });

  it('流程：钱不够买时停留在决策阶段，可以放弃', () => {
    const { state, game } = setup({ rolls: [[1, 2]] });
    state.players[0].cash = 100;
    game.rollDice();
    expect(game.buyProperty().ok).toBe(false);
    expect(game.phase).toBe(P.AWAIT_DECISION);
    expect(game.declineProperty().ok).toBe(true);
    expect(state.properties.yinchuan.ownerId).toBeNull();
    expect(game.phase).toBe(P.TURN_END);
  });

  it('流程：决策阶段可抵押其他地产凑钱买地', () => {
    const { state, game } = setup({ rolls: [[1, 2]] });
    state.players[0].cash = 400;
    give(state, 'beijing', 'p1');
    game.rollDice();
    expect(game.mortgage('p1', 'beijing').ok).toBe(true);
    expect(game.buyProperty().ok).toBe(true);
  });
});

describe('收租', () => {
  it('按等级收租，抵押后不收租，无主为 0', () => {
    const { state, ctx } = setup();
    expect(calcRent(ctx, 'xining')).toBe(0);
    give(state, 'xining', 'p2');
    expect(calcRent(ctx, 'xining')).toBe(20);
    state.properties.xining.mortgaged = true;
    expect(calcRent(ctx, 'xining')).toBe(0);
  });

  it('整组空地租金翻倍，有建筑按等级租金', () => {
    const { state, ctx } = setup();
    give(state, 'xining', 'p2');
    give(state, 'yinchuan', 'p2');
    expect(calcRent(ctx, 'xining')).toBe(40);
    state.properties.xining.level = 2;
    expect(calcRent(ctx, 'xining')).toBe(tile('xining').rent[2]);
  });

  it('组内一块被抵押时，其余空地仍翻倍（经典规则）', () => {
    const { state, ctx } = setup();
    give(state, 'xining', 'p2');
    give(state, 'yinchuan', 'p2', { mortgaged: true });
    expect(calcRent(ctx, 'xining')).toBe(40);
  });

  it('破产地主不收租', () => {
    const { state, ctx } = setup();
    give(state, 'xining', 'p2');
    state.players[1].bankrupt = true;
    expect(calcRent(ctx, 'xining')).toBe(0);
  });

  it('流程：停在他人地产自动付租', () => {
    const { state, game, events } = setup({ rolls: [[1, 2]] });
    give(state, 'yinchuan', 'p2');
    game.rollDice();
    expect(state.players[0].cash).toBe(RULES.startingCash - 40);
    expect(state.players[1].cash).toBe(RULES.startingCash + 40);
    expect(game.phase).toBe(P.TURN_END);
    expect(events.some((e) => e.type === 'paymentMade')).toBe(true);
  });

  it('流程：停在自己地产不付钱', () => {
    const { state, game } = setup({ rolls: [[1, 2]] });
    give(state, 'yinchuan', 'p1');
    game.rollDice();
    expect(state.players[0].cash).toBe(RULES.startingCash);
    expect(game.phase).toBe(P.TURN_END);
  });
});

describe('升级与卖建筑', () => {
  it('前置条件：整组、未抵押、未满级、现金够', () => {
    const { state, ctx } = setup();
    const p = state.players[0];
    give(state, 'xining', 'p1');
    expect(upgradeProperty(ctx, 'p1', 'xining').error).toContain('整个颜色组');
    give(state, 'yinchuan', 'p1', { mortgaged: true });
    expect(upgradeProperty(ctx, 'p1', 'xining').error).toContain('抵押');
    state.properties.yinchuan.mortgaged = false;
    p.cash = 499;
    expect(upgradeProperty(ctx, 'p1', 'xining').error).toContain('现金不足');
    p.cash = 500 * 4;
    for (let i = 1; i <= 4; i++) {
      expect(upgradeProperty(ctx, 'p1', 'xining').ok).toBe(true);
      expect(state.properties.xining.level).toBe(i);
    }
    expect(p.cash).toBe(0);
    p.cash = 10000;
    expect(upgradeProperty(ctx, 'p1', 'xining').error).toContain('最高等级');
  });

  it('不能升级别人的地产', () => {
    const { state, ctx } = setup();
    give(state, 'xining', 'p2');
    give(state, 'yinchuan', 'p2');
    expect(upgradeProperty(ctx, 'p1', 'xining').ok).toBe(false);
  });

  it('卖建筑退一半升级费', () => {
    const { state, ctx } = setup();
    give(state, 'xining', 'p1', { level: 2 });
    give(state, 'yinchuan', 'p1');
    state.players[0].cash = 0;
    expect(sellBuilding(ctx, 'p1', 'xining').ok).toBe(true);
    expect(state.players[0].cash).toBe(250);
    expect(state.properties.xining.level).toBe(1);
    sellBuilding(ctx, 'p1', 'xining');
    expect(sellBuilding(ctx, 'p1', 'xining').error).toContain('没有建筑');
  });

  it('流程：升级只能在自己回合掷骰前', () => {
    const { state, game } = setup({ rolls: [[1, 2]] });
    give(state, 'xining', 'p1');
    give(state, 'yinchuan', 'p1');
    expect(game.upgrade('p2', 'xining').ok).toBe(false); // 不是 p2 的回合
    expect(game.upgrade('p1', 'xining').ok).toBe(true);
    game.rollDice(); // 停在自己的银川，进入 turnEnd
    expect(game.upgrade('p1', 'xining').ok).toBe(false);
  });
});

describe('抵押与赎回', () => {
  it('抵押得一半价格，赎回付抵押价 + 10% 利息（向上取整）', () => {
    const { state, ctx } = setup();
    const p = state.players[0];
    give(state, 'xining', 'p1');
    p.cash = 0;
    expect(mortgageProperty(ctx, 'p1', 'xining').ok).toBe(true);
    expect(p.cash).toBe(300);
    expect(mortgageProperty(ctx, 'p1', 'xining').error).toContain('已抵押');
    expect(redeemCost(tile('xining'), RULES)).toBe(330);
    expect(redeemProperty(ctx, 'p1', 'xining').error).toContain('现金不足');
    p.cash = 330;
    expect(redeemProperty(ctx, 'p1', 'xining').ok).toBe(true);
    expect(p.cash).toBe(0);
    expect(redeemProperty(ctx, 'p1', 'xining').error).toContain('未抵押');
  });

  it('利息取整：小数利息向上取整，无浮点误差', () => {
    expect(redeemCost({ mortgageValue: 305 }, RULES)).toBe(305 + 31); // 30.5 → 31
    expect(redeemCost({ mortgageValue: 300 }, { mortgageInterestRate: 0.1 })).toBe(330); // 不能变成 331
    expect(redeemCost({ mortgageValue: 700 }, { mortgageInterestRate: 0.1 })).toBe(770);
  });

  it('组内有建筑时不能抵押', () => {
    const { state, ctx } = setup();
    give(state, 'xining', 'p1', { level: 1 });
    give(state, 'yinchuan', 'p1');
    expect(mortgageProperty(ctx, 'p1', 'yinchuan').error).toContain('建筑');
  });

  it('liquidationValue = 现金 + 建筑退款 + 未抵押地产的抵押价', () => {
    const { state, ctx } = setup();
    state.players[0].cash = 100;
    give(state, 'xining', 'p1', { level: 2 }); // 2*250 + 300
    give(state, 'yinchuan', 'p1', { mortgaged: true }); // 0
    expect(liquidationValue(ctx, 'p1')).toBe(100 + 500 + 300);
  });
});

describe('欠款与破产', () => {
  /** p1 从 0 掷 3 步停在 p2 的银川（满级租金 3200） */
  function debtSetup({ cash, n = 2 } = {}) {
    const s = setup({ n, rolls: [[1, 2]] });
    give(s.state, 'xining', 'p2');
    give(s.state, 'yinchuan', 'p2', { level: 4 });
    s.state.players[0].cash = cash;
    return s;
  }

  it('现金不够进入还款阶段，变现后可还清', () => {
    const { state, game } = debtSetup({ cash: 1500 });
    give(state, 'beijing', 'p1', { level: 0 }); // 抵押价 2000
    game.rollDice();
    expect(game.phase).toBe(P.AWAIT_PAYMENT);
    expect(state.pendingDebt).toMatchObject({ debtorId: 'p1', creditorId: 'p2', amount: 3200 });
    expect(game.endTurn().ok).toBe(false);
    expect(game.payDebt().ok).toBe(false);
    expect(game.declareBankruptcy().error).toContain('足够还款');
    expect(game.mortgage('p1', 'beijing').ok).toBe(true);
    expect(game.payDebt().ok).toBe(true);
    expect(state.players[0].cash).toBe(1500 + 2000 - 3200);
    expect(state.players[1].cash).toBe(RULES.startingCash + 3200);
    expect(state.pendingDebt).toBeNull();
    expect(game.phase).toBe(P.TURN_END);
  });

  it('变现后仍不够：破产，现金与地产（含抵押状态）转给地主', () => {
    const { state, game, events } = debtSetup({ cash: 1000, n: 3 });
    give(state, 'lanzhou', 'p1', { mortgaged: true });
    game.rollDice();
    expect(game.declareBankruptcy().ok).toBe(true);
    expect(state.players[0]).toMatchObject({ bankrupt: true, cash: 0 });
    expect(state.players[1].cash).toBe(RULES.startingCash + 1000);
    expect(state.properties.lanzhou).toMatchObject({ ownerId: 'p2', mortgaged: true });
    expect(state.pendingDebt).toBeNull();
    expect(game.phase).toBe(P.TURN_END);
    expect(events.some((e) => e.type === 'playerBankrupt')).toBe(true);
    game.endTurn();
    expect(game.currentPlayer().id).toBe('p2');
  });

  it('破产时建筑先卖回银行，退款计入转给债主的现金', () => {
    const { state, game } = debtSetup({ cash: 0, n: 3 });
    give(state, 'lanzhou', 'p1', { level: 1 }); // 只为测试处置，不检查组规则
    game.rollDice();
    // 1 级建筑退 250 + 抵押价 500 = 750 < 3200
    expect(game.declareBankruptcy().ok).toBe(true);
    expect(state.players[1].cash).toBe(RULES.startingCash + 250);
    expect(state.properties.lanzhou).toMatchObject({ ownerId: 'p2', level: 0, mortgaged: false });
  });

  it('欠银行破产：地产收回为无主空地', () => {
    const { state, ctx } = setup({ n: 3 });
    give(state, 'xining', 'p1', { mortgaged: true, level: 0 });
    state.players[0].cash = 10;
    expect(charge(ctx, 'p1', null, 2000, { type: 'tax' }).paid).toBe(false);
    liquidateForBankruptcy(ctx, 'p1', null);
    expect(state.properties.xining).toEqual({ ownerId: null, level: 0, mortgaged: false });
    expect(state.players[0].cash).toBe(0);
  });

  it('破产连锁：两人局中破产即终局', () => {
    const { state, game } = debtSetup({ cash: 0 });
    game.rollDice();
    game.declareBankruptcy();
    expect(game.phase).toBe(P.GAME_OVER);
    expect(state.winnerId).toBe('p2');
    expect(game.endTurn().ok).toBe(false);
  });

  it('破产玩家的地产不再属于他，之后停上去交给新主人', () => {
    const { state, game } = debtSetup({ cash: 0, n: 3 });
    give(state, 'lanzhou', 'p1');
    game.rollDice();
    game.declareBankruptcy();
    const owners = Object.values(state.properties).map((p) => p.ownerId);
    expect(owners).not.toContain('p1');
  });

  it('非还款阶段不能还款或宣告破产', () => {
    const { game } = setup();
    expect(game.payDebt().ok).toBe(false);
    expect(game.declareBankruptcy().ok).toBe(false);
  });
});

describe('整局模拟（简易策略）', () => {
  /** 简易策略：能买就买、能升就升，欠款时先卖建筑再抵押，不够就破产 */
  function autoplay(game, state, maxSteps) {
    for (let step = 0; step < maxSteps; step++) {
      if (game.phase === P.GAME_OVER) return step;
      const me = game.actingPlayerId();
      switch (game.phase) {
        case P.AWAIT_ROLL: {
          const p = game.currentPlayer();
          if (p.inJail) p.inJail = false; // 坐牢在第 6 步实现
          for (const t of TILES) {
            if (state.properties[t.id]?.ownerId === me && p.cash > t.upgradeCost + 3000) game.upgrade(me, t.id);
          }
          expect(game.rollDice().ok).toBe(true);
          break;
        }
        case P.AWAIT_DECISION:
          if (!game.buyProperty().ok) expect(game.declineProperty().ok).toBe(true);
          break;
        case P.AWAIT_PAYMENT: {
          const owned = TILES.filter((t) => state.properties[t.id]?.ownerId === me);
          for (const t of owned) while (state.properties[t.id].level > 0) game.sellBuilding(me, t.id);
          for (const t of owned) {
            if (game.payDebt().ok) break;
            game.mortgage(me, t.id);
          }
          if (state.phase === P.AWAIT_PAYMENT && !game.payDebt().ok) {
            expect(game.declareBankruptcy().ok).toBe(true);
          }
          break;
        }
        case P.TURN_END:
          expect(game.endTurn().ok).toBe(true);
          break;
        default:
          throw new Error(`停在中间阶段: ${game.phase}`);
      }
      // 不变量（用 throw 而不是 expect，每步都检查时开销小很多）
      for (const p of state.players) {
        if (p.cash < 0) throw new Error(`现金为负: ${p.id} ${p.cash}`);
      }
      for (const [id, prop] of Object.entries(state.properties)) {
        const owner = state.players.find((p) => p.id === prop.ownerId);
        if (prop.ownerId && (!owner || owner.bankrupt)) throw new Error(`${id} 归属无效: ${prop.ownerId}`);
        if (prop.level < 0 || prop.level > RULES.maxLevel) throw new Error(`${id} 等级越界: ${prop.level}`);
        if (prop.mortgaged && prop.level > 0) throw new Error(`${id} 抵押且有建筑`);
      }
    }
    return -1;
  }

  it.each([1, 2, 3])('默认规则 种子 %i：2 万步内阶段始终合法、不变量成立', (seed) => {
    const { state, game } = setup({ n: 4, seed });
    autoplay(game, state, 20000);
    expect(state.turn).toBeGreaterThan(1);
  });

  // 默认数值下对局很难自然结束（见自检说明），用紧缩经济验证破产连锁能一路走到终局
  const TIGHT = { ...RULES, startingCash: 3000, passStartBonus: 1 };

  it.each([1, 2, 3, 4, 5])('紧缩经济 种子 %i：4 人局在有限步内终局', (seed) => {
    const { state, game } = setup({ n: 4, seed, rules: TIGHT });
    const steps = autoplay(game, state, 50000);
    expect(steps).toBeGreaterThan(0);
    expect(state.phase).toBe(P.GAME_OVER);
    const alive = state.players.filter((p) => !p.bankrupt);
    expect(alive).toHaveLength(1);
    expect(state.winnerId).toBe(alive[0].id);
  });
});
