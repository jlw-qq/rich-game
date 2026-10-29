/**
 * 逻辑层：对局协调器。把状态机与各 system 组装成对外的操作接口，供 UI 与 AI 调用。
 * 所有操作返回 { ok: true, ... } 或 { ok: false, error }，失败时状态不变。
 */
import { createTurnMachine, PHASES as P } from './turnMachine.js';
import { rollDice as defaultRollDice } from '../systems/dice.js';
import { movePlayer, sendToJail } from '../systems/movement.js';
import {
  buyProperty,
  calcRent,
  liquidationValue,
  mortgageProperty,
  netWorth,
  redeemProperty,
  sellBuilding,
  upgradeProperty,
} from '../systems/property.js';
import { charge, liquidateForBankruptcy, payPendingDebt } from '../systems/bankruptcy.js';
import { applyCard, drawCard } from '../systems/cards.js';
import { payBail, releaseFromJail, returnJailFreeCards, useJailFreeCard } from '../systems/jail.js';
import { executeTrade, prepareTrade } from '../systems/trade.js';

const fail = (error) => ({ ok: false, error });

/** 一次落格最多由卡牌连续触发的额外移动次数，防止卡牌互相跳转形成无限连锁 */
export const MAX_CARD_CHAIN = 3;

/** 允许变现（卖建筑、抵押）的阶段：自己回合的空闲时刻，以及买地决策和还款时 */
const LIQUIDATE_PHASES = [P.AWAIT_ROLL, P.AWAIT_DECISION, P.AWAIT_PAYMENT, P.TURN_END];
/** 允许投资（升级、赎回）的阶段 */
const INVEST_PHASES = [P.AWAIT_ROLL];

/**
 * @param {{
 *   board: object,
 *   rules: object,
 *   state: object,
 *   bus: { emit: Function },
 *   cards?: object[],
 *   rollDice?: (state: object) => { dice: number[], total: number, isDouble: boolean },
 * }} options rollDice 可替换，便于测试固定点数
 */
export function createGame({ board, rules, state, bus, cards = [], rollDice = defaultRollDice }) {
  const ctx = { state, board, rules, bus, cards };

  /** 回合上限时的胜者：存活玩家中总资产最高者，并列时按座位顺序 */
  function pickRichest() {
    let best = null;
    let bestWorth = -Infinity;
    for (const p of state.players) {
      if (p.bankrupt) continue;
      const worth = netWorth(ctx, p.id);
      if (worth > bestWorth) {
        best = p;
        bestWorth = worth;
      }
    }
    return best?.id ?? null;
  }

  const fsm = createTurnMachine(state, bus, { maxRounds: rules.maxRounds, pickWinner: pickRichest });

  /** 当前有权操作的玩家：还款阶段是欠款人，交易阶段是被提议的一方，其余是当前玩家 */
  function actingPlayerId() {
    if (state.phase === P.AWAIT_PAYMENT) return state.pendingDebt?.debtorId ?? null;
    if (state.phase === P.AWAIT_TRADE) return state.pendingTrade?.toId ?? null;
    return fsm.currentPlayer()?.id ?? null;
  }

  function finishTile() {
    fsm.transition(P.SETTLE);
    fsm.transition(P.TURN_END);
  }

  /** 送进监狱并结束本回合（不再追加掷骰） */
  function jailAndEnd(player) {
    sendToJail(ctx, player.id);
    state.doublesCount = 0;
    fsm.forceTurnEnd();
  }

  /** 收款：付得起就结算，付不起进入还款阶段 */
  function chargeOrAwait(player, creditorId, amount, reason) {
    const { paid } = charge(ctx, player.id, creditorId, amount, reason);
    if (paid) finishTile();
    else fsm.transition(P.AWAIT_PAYMENT);
  }

  /** 从当前阶段进入移动，移动后触发落点格子 */
  function moveAndResolve(player, steps, depth) {
    fsm.transition(P.MOVING);
    movePlayer(ctx, player.id, steps);
    fsm.transition(P.TILE_EVENT);
    resolveTile(player, depth);
  }

  function resolveCard(player, deck, depth) {
    const card = drawCard(ctx, player.id, deck);
    if (!card) return finishTile();
    const plan = applyCard(ctx, player.id, card);
    const reason = { type: 'card', cardId: card.id };

    switch (plan.kind) {
      case 'charge':
        return chargeOrAwait(player, plan.creditorId, plan.amount, reason);
      case 'jail':
        return jailAndEnd(player);
      case 'move':
        if (plan.steps === 0) return finishTile();
        if (depth >= MAX_CARD_CHAIN) {
          bus.emit('cardChainLimited', { playerId: player.id, cardId: card.id });
          return finishTile();
        }
        return moveAndResolve(player, plan.steps, depth + 1);
      default:
        return finishTile();
    }
  }

  /** 按格子类型分发事件。depth 为卡牌连锁深度 */
  function resolveTile(player, depth = 0) {
    const tile = board.getTile(player.position);
    switch (tile.type) {
      case 'property':
        return resolveProperty(player, tile);
      case 'tax':
        return chargeOrAwait(player, null, tile.amount, { type: 'tax', tileId: tile.id });
      case 'chance':
      case 'fate':
        return resolveCard(player, tile.type, depth);
      case 'goToJail':
        return jailAndEnd(player);
      default:
        // 起点、监狱（探监）、停车场：无事件
        return finishTile();
    }
  }

  function resolveProperty(player, tile) {
    const prop = state.properties[tile.id];
    if (prop.ownerId === null) {
      fsm.transition(P.AWAIT_DECISION);
      bus.emit('purchaseOffered', { playerId: player.id, tileId: tile.id, price: tile.price });
      return;
    }
    if (prop.ownerId === player.id) return finishTile();
    const rent = calcRent(ctx, tile.id);
    if (rent === 0) return finishTile();
    chargeOrAwait(player, prop.ownerId, rent, { type: 'rent', tileId: tile.id });
  }

  /** 坐牢时掷骰：双数出狱并移动；坐满回合强制保释后移动；否则继续坐牢 */
  function rollInJail(player) {
    const result = rollDice(state);
    player.jailTurns += 1;
    state.doublesCount = 0; // 出狱的双数不奖励追加掷骰
    bus.emit('diceRolled', { playerId: player.id, ...result, doublesCount: 0, inJail: true });

    if (result.isDouble) {
      releaseFromJail(ctx, player.id, 'doubles');
      moveAndResolve(player, result.total, 0);
      return { ok: true, roll: result, jailed: false };
    }
    if (player.jailTurns < rules.maxJailTurns) {
      fsm.forceTurnEnd();
      return { ok: true, roll: result, jailed: true };
    }
    // 坐满回合：强制交保释金。付不起进入还款，付清后再按本次点数移动
    const { paid } = charge(ctx, player.id, null, rules.jailBail, { type: 'forcedBail', steps: result.total });
    if (!paid) {
      fsm.transition(P.AWAIT_PAYMENT);
      return { ok: true, roll: result, jailed: true };
    }
    releaseFromJail(ctx, player.id, 'forcedBail');
    moveAndResolve(player, result.total, 0);
    return { ok: true, roll: result, jailed: false };
  }

  function roll() {
    if (state.phase !== P.AWAIT_ROLL) return fail(`当前阶段不能掷骰: ${state.phase}`);
    const player = fsm.currentPlayer();
    if (!player || player.bankrupt) return fail('当前玩家不能行动');
    if (player.inJail) return rollInJail(player);

    const result = rollDice(state);
    state.doublesCount = result.isDouble ? state.doublesCount + 1 : 0;
    bus.emit('diceRolled', { playerId: player.id, ...result, doublesCount: state.doublesCount });

    if (state.doublesCount >= rules.maxConsecutiveDoubles) {
      jailAndEnd(player);
      return { ok: true, roll: result, jailed: true };
    }
    moveAndResolve(player, result.total, 0);
    return { ok: true, roll: result, jailed: false };
  }

  /** 买下脚下的地产 */
  function buy() {
    if (state.phase !== P.AWAIT_DECISION) return fail(`当前阶段不能购买: ${state.phase}`);
    const player = fsm.currentPlayer();
    const result = buyProperty(ctx, player.id, board.getTile(player.position).id);
    if (result.ok) finishTile();
    return result;
  }

  /** 放弃购买，地产保持无主 */
  function decline() {
    if (state.phase !== P.AWAIT_DECISION) return fail(`当前阶段不能放弃购买: ${state.phase}`);
    const player = fsm.currentPlayer();
    bus.emit('purchaseDeclined', { playerId: player.id, tileId: board.getTile(player.position).id });
    finishTile();
    return { ok: true };
  }

  /** 包装地产操作：检查阶段与操作人 */
  function assetAction(fn, phases) {
    return (playerId, tileId) => {
      if (!phases.includes(state.phase)) return fail(`当前阶段不能执行该操作: ${state.phase}`);
      if (playerId !== actingPlayerId()) return fail('不是该玩家的操作时机');
      return fn(ctx, playerId, tileId);
    };
  }

  /** 包装出狱操作：只能在自己回合掷骰前 */
  function jailAction(fn) {
    return () => {
      if (state.phase !== P.AWAIT_ROLL) return fail(`当前阶段不能出狱: ${state.phase}`);
      return fn(ctx, fsm.currentPlayer().id);
    };
  }

  /** 现金凑够后付清欠款；强制保释的欠款付清后出狱并继续移动 */
  function payDebt() {
    if (state.phase !== P.AWAIT_PAYMENT) return fail(`当前阶段没有待付欠款: ${state.phase}`);
    const { reason, debtorId } = state.pendingDebt;
    const result = payPendingDebt(ctx);
    if (!result.ok) return result;

    if (reason?.type === 'forcedBail') {
      const player = state.players.find((p) => p.id === debtorId);
      releaseFromJail(ctx, debtorId, 'forcedBail');
      moveAndResolve(player, reason.steps, 0);
    } else {
      finishTile();
    }
    return result;
  }

  /** 资产全部变现仍不够还款时宣告破产 */
  function declareBankruptcy() {
    if (state.phase !== P.AWAIT_PAYMENT) return fail(`只能在还款阶段宣告破产: ${state.phase}`);
    const debt = state.pendingDebt;
    if (liquidationValue(ctx, debt.debtorId) >= debt.amount) {
      return fail('资产变现后足够还款，不能宣告破产');
    }
    liquidateForBankruptcy(ctx, debt.debtorId, debt.creditorId);
    returnJailFreeCards(ctx, debt.debtorId);
    return fsm.declareBankrupt(debt.debtorId);
  }

  /**
   * 当前玩家掷骰前向别人提议交易。
   * @param {string} playerId 发起人，必须是当前玩家
   * @param {{ toId: string, give?: object, take?: object }} offer
   */
  function proposeTrade(playerId, offer) {
    if (state.phase !== P.AWAIT_ROLL) return fail(`当前阶段不能发起交易: ${state.phase}`);
    if (playerId !== fsm.currentPlayer()?.id) return fail('只能在自己的回合发起交易');
    if (state.tradesThisTurn >= rules.maxTradesPerTurn) return fail(`每回合最多发起 ${rules.maxTradesPerTurn} 次交易`);
    const checked = prepareTrade(ctx, { ...offer, fromId: playerId });
    if (!checked.ok) return checked;

    state.pendingTrade = checked.trade;
    state.tradesThisTurn += 1;
    fsm.transition(P.AWAIT_TRADE);
    bus.emit('tradeProposed', { trade: checked.trade });
    return { ok: true };
  }

  /**
   * 被提议的一方接受交易。交易阶段不允许其他操作，双方资产不会变化；
   * 万一交易已失效（如存档被改过），返回失败且状态不变，对方仍可拒绝。
   */
  function acceptTrade() {
    if (state.phase !== P.AWAIT_TRADE) return fail(`当前阶段没有待答复的交易: ${state.phase}`);
    const result = executeTrade(ctx, state.pendingTrade);
    if (!result.ok) return result;
    state.pendingTrade = null;
    fsm.transition(P.AWAIT_ROLL);
    return result;
  }

  function rejectTrade() {
    if (state.phase !== P.AWAIT_TRADE) return fail(`当前阶段没有待答复的交易: ${state.phase}`);
    const trade = state.pendingTrade;
    state.pendingTrade = null;
    bus.emit('tradeRejected', { trade });
    fsm.transition(P.AWAIT_ROLL);
    return { ok: true };
  }

  /** 结束回合：掷出双数且仍可行动则同一玩家再掷，否则换下一位 */
  function endTurn() {
    if (state.phase !== P.TURN_END) return fail(`当前阶段不能结束回合: ${state.phase}`);
    // 目标资产：回合结束时有人达到就立即终局，多人同时达到时总资产最高者获胜
    if (rules.goalNetWorth > 0) {
      const reached = state.players.filter((p) => !p.bankrupt && netWorth(ctx, p.id) >= rules.goalNetWorth);
      if (reached.length > 0) {
        const winner = reached.reduce((a, b) => (netWorth(ctx, b.id) > netWorth(ctx, a.id) ? b : a));
        return fsm.finishGame(winner.id, 'goal');
      }
    }
    const player = fsm.currentPlayer();
    if (state.doublesCount > 0 && player && !player.bankrupt && !player.inJail) {
      return fsm.grantExtraRoll();
    }
    state.doublesCount = 0;
    state.tradesThisTurn = 0;
    return fsm.endTurn();
  }

  return {
    state,
    get phase() {
      return state.phase;
    },
    currentPlayer: fsm.currentPlayer,
    actingPlayerId,
    netWorth: (playerId) => netWorth(ctx, playerId),
    rollDice: roll,
    buyProperty: buy,
    declineProperty: decline,
    upgrade: assetAction(upgradeProperty, INVEST_PHASES),
    redeem: assetAction(redeemProperty, INVEST_PHASES),
    mortgage: assetAction(mortgageProperty, LIQUIDATE_PHASES),
    sellBuilding: assetAction(sellBuilding, LIQUIDATE_PHASES),
    payBail: jailAction(payBail),
    useJailFreeCard: jailAction(useJailFreeCard),
    payDebt,
    declareBankruptcy,
    proposeTrade,
    acceptTrade,
    rejectTrade,
    endTurn,
  };
}
