/**
 * 逻辑层：AI 决策。纯函数：读状态，返回下一步操作 { kind, tileId? }，不修改状态。
 * 返回的操作仍由 game 校验；非法操作由 driver 兜底。
 */
import { PHASES as P } from '../core/turnMachine.js';
import { calcRent, ownsFullGroup, redeemCost, rentAt } from '../systems/property.js';
import { choiceOptions } from '../systems/choice.js';

/**
 * @typedef {{ state: object, board: object, rules: object }} View
 * @typedef {{ kind: string, tileId?: string, trade?: object }} Action
 */

/** 安全现金下限与上限：至少留 1000，最多按 6000 留（否则后期 AI 什么都不敢买） */
const MIN_RESERVE = 1000;
const MAX_RESERVE = 6000;
/** 对手拥有的地产比例达到该值时，坐牢反而安全，选择留在牢里 */
const JAIL_STAY_RATIO = 0.4;
/** 交易估值：凑齐（或失去）一个颜色组，额外按组内地价总和的该比例计价 */
const GROUP_BONUS_RATE = 0.5;
/** 出狱卡按保释金的该比例计价 */
const JAIL_CARD_RATE = 0.6;
/** 每回合向人类玩家提议交易的概率，避免每回合都弹出交易打扰人 */
const HUMAN_OFFER_CHANCE = 0.25;

const isProperty = (t) => t.type === 'property';

function ownedTiles({ state, board }, playerId) {
  return board.tiles.filter((t) => isProperty(t) && state.properties[t.id].ownerId === playerId);
}

/** 安全现金：对手地产里最高的一笔租金，限制在 [MIN_RESERVE, MAX_RESERVE] */
export function reserveFor(view, playerId) {
  const { state, board } = view;
  let maxRent = 0;
  for (const t of board.tiles) {
    if (!isProperty(t)) continue;
    const owner = state.properties[t.id].ownerId;
    if (owner && owner !== playerId) maxRent = Math.max(maxRent, calcRent(view, t.id));
  }
  return Math.min(MAX_RESERVE, Math.max(MIN_RESERVE, maxRent));
}

/** 对手拥有的地产占全部地产的比例 */
function opponentOwnedRatio({ state, board }, playerId) {
  const props = board.tiles.filter(isProperty);
  const theirs = props.filter((t) => {
    const owner = state.properties[t.id].ownerId;
    return owner && owner !== playerId;
  });
  return theirs.length / props.length;
}

/** 组内是否有建筑（有建筑时不能抵押） */
function groupHasBuildings({ state, board }, group) {
  return board.getGroupTiles(group).some((t) => state.properties[t.id].level > 0);
}

function groupHasMortgage({ state, board }, group) {
  return board.getGroupTiles(group).some((t) => state.properties[t.id].mortgaged);
}

/** 可升级的地产，按等级从低到高（均衡建造），同级按租金涨幅从大到小 */
function upgradeCandidates(view, playerId) {
  const { state, rules } = view;
  return ownedTiles(view, playerId)
    .filter((t) => {
      const prop = state.properties[t.id];
      return (
        prop.level < rules.maxLevel &&
        ownsFullGroup(view, playerId, t.group) &&
        !groupHasMortgage(view, t.group)
      );
    })
    .sort((a, b) => {
      const la = state.properties[a.id].level;
      const lb = state.properties[b.id].level;
      if (la !== lb) return la - lb;
      return b.rent[lb + 1] - b.rent[lb] - (a.rent[la + 1] - a.rent[la]);
    });
}

/** 掷骰前的投资：赎回、升级。没有合适的投资时返回 null */
function investAction(view, player, reserve, { allowRedeem, upgradeReserve }) {
  const { state, rules } = view;

  if (allowRedeem) {
    const mortgaged = ownedTiles(view, player.id)
      .filter((t) => state.properties[t.id].mortgaged)
      // 先赎回整组里的地（赎回后才能升级），再按价格从高到低
      .sort((a, b) => Number(ownsFullGroup(view, player.id, b.group)) - Number(ownsFullGroup(view, player.id, a.group)) || b.price - a.price);
    const target = mortgaged.find((t) => player.cash - redeemCost(t, rules) >= reserve * 1.5);
    if (target) return { kind: 'redeem', tileId: target.id };
  }

  const upgrade = upgradeCandidates(view, player.id).find((t) => player.cash - t.upgradeCost >= upgradeReserve);
  if (upgrade) return { kind: 'upgrade', tileId: upgrade.id };
  return null;
}

/**
 * 还款：先抵押不成组的空地（租金低的先抵），再卖建筑（等级高的先卖），最后抵押剩下的地。
 * 资产全部变现仍不够时宣告破产。
 */
function paymentAction(view, player) {
  const { state } = view;
  const debt = state.pendingDebt;
  if (player.cash >= debt.amount) return { kind: 'payDebt' };

  const owned = ownedTiles(view, player.id);
  const canMortgage = (t) => !state.properties[t.id].mortgaged && !groupHasBuildings(view, t.group);
  const byRent = (a, b) => a.rent[0] - b.rent[0];

  const loose = owned.filter((t) => canMortgage(t) && !ownsFullGroup(view, player.id, t.group)).sort(byRent);
  if (loose.length > 0) return { kind: 'mortgage', tileId: loose[0].id };

  const built = owned
    .filter((t) => state.properties[t.id].level > 0)
    .sort((a, b) => state.properties[b.id].level - state.properties[a.id].level || a.upgradeCost - b.upgradeCost);
  if (built.length > 0) return { kind: 'sell', tileId: built[0].id };

  const rest = owned.filter(canMortgage).sort(byRent);
  if (rest.length > 0) return { kind: 'mortgage', tileId: rest[0].id };

  return { kind: 'bankrupt' };
}

const roundUp100 = (v) => Math.ceil(v / 100) * 100;

const groupPrice = (board, group) => board.getGroupTiles(group).reduce((sum, t) => sum + t.price, 0);

/** 交易中一边资产的估值：地产按地价（已抵押的扣掉赎回费），现金按面值，出狱卡按保释金折算 */
function sideValue({ board, rules, state }, side) {
  let total = side.cash + side.jailCards * rules.jailBail * JAIL_CARD_RATE;
  for (const id of side.properties) {
    const tile = board.tiles.find((t) => t.id === id);
    total += state.properties[id].mortgaged ? tile.price - redeemCost(tile, rules) : tile.price;
  }
  return total;
}

/** 某玩家完整拥有的颜色组。owner(tileId) 给出地产归属 */
function fullGroupsOf(board, owner, playerId) {
  const groups = new Set(board.tiles.filter(isProperty).map((t) => t.group));
  return new Set([...groups].filter((g) => board.getGroupTiles(g).every((t) => owner(t.id) === playerId)));
}

/**
 * 交易对 playerId 的净收益（正数表示划算）。
 * groupAware 时考虑颜色组：自己凑齐加分、拆散扣分，让对方凑齐按威胁扣分。
 */
export function evaluateTrade(view, playerId, trade, { groupAware = true } = {}) {
  const { state, board } = view;
  const iAmFrom = trade.fromId === playerId;
  const out = iAmFrom ? trade.give : trade.take;
  const inc = iAmFrom ? trade.take : trade.give;
  const otherId = iAmFrom ? trade.toId : trade.fromId;
  let value = sideValue(view, inc) - sideValue(view, out);
  if (!groupAware) return value;

  const before = (id) => state.properties[id].ownerId;
  const moved = new Map([...trade.give.properties.map((id) => [id, trade.toId]), ...trade.take.properties.map((id) => [id, trade.fromId])]);
  const after = (id) => (moved.has(id) ? moved.get(id) : before(id));
  const bonus = (g) => groupPrice(board, g) * GROUP_BONUS_RATE;

  const mineBefore = fullGroupsOf(board, before, playerId);
  const mineAfter = fullGroupsOf(board, after, playerId);
  for (const g of mineAfter) if (!mineBefore.has(g)) value += bonus(g);
  for (const g of mineBefore) if (!mineAfter.has(g)) value -= bonus(g);
  const theirsBefore = fullGroupsOf(board, before, otherId);
  for (const g of fullGroupsOf(board, after, otherId)) if (!theirsBefore.has(g)) value -= bonus(g);
  return value;
}

/** 回应交易：净收益为正、付出现金后不低于安全下限才接受 */
function respondTrade(view, player, easy) {
  const trade = view.state.pendingTrade;
  const out = trade.fromId === player.id ? trade.give : trade.take;
  if (player.cash - out.cash < (easy ? 0 : MIN_RESERVE)) return { kind: 'rejectTrade' };
  return { kind: evaluateTrade(view, player.id, trade, { groupAware: !easy }) > 0 ? 'acceptTrade' : 'rejectTrade' };
}

/**
 * 主动交易（普通难度）：某颜色组只差一块、这块在对手手里时，用现金去买。
 * 同一回合内每被拒绝一次就加价一档；对人类每回合最多提议一次，且只按一定概率提议。
 */
function tradeOffer(view, player, reserve, rng) {
  const { state, board, rules } = view;
  const attempt = state.tradesThisTurn;
  if (attempt >= rules.maxTradesPerTurn) return null;

  const groups = [...new Set(board.tiles.filter(isProperty).map((t) => t.group))];
  const candidates = [];
  for (const g of groups) {
    const tiles = board.getGroupTiles(g);
    const missing = tiles.filter((t) => state.properties[t.id].ownerId !== player.id);
    if (missing.length !== 1 || tiles.length < 2) continue;
    const target = missing[0];
    const ownerId = state.properties[target.id].ownerId;
    if (ownerId === null || groupHasBuildings(view, g)) continue;
    const owner = state.players.find((p) => p.id === ownerId);
    // 对人类只提议一次（第二档报价），对 AI 每次被拒后加价
    if (!owner.isAI && attempt > 0) continue;
    const step = owner.isAI ? attempt : 1;
    const cash = roundUp100(target.price + groupPrice(board, g) * GROUP_BONUS_RATE * (0.5 + 0.5 * step));
    if (player.cash - cash < reserve) continue;
    candidates.push({ owner, target, cash, worth: groupPrice(board, g) });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.worth - a.worth);
  const best = candidates[0];
  if (!best.owner.isAI && rng.next() >= HUMAN_OFFER_CHANCE) return null;
  return {
    kind: 'proposeTrade',
    trade: { toId: best.owner.id, give: { properties: [], cash: best.cash, jailCards: 0 }, take: { properties: [best.target.id], cash: 0, jailCards: 0 } },
  };
}

/**
 * 城市事件选择。
 * 普通难度按期望收益选：冒险输了付得起（付完不低于安全下限）才冒险；免费升级按多收约 6 回合的租金估值。
 * 简单难度在能选的选项里随机选。
 */
function choiceAction(view, player, easy, rng) {
  const { state, rules } = view;
  const card = view.cards?.find((c) => c.id === state.pendingChoice?.cardId);
  if (!card) return { kind: 'choose', index: 0 };
  const options = choiceOptions(view, player.id, card);
  const open = options.map((o, i) => (o.available ? i : -1)).filter((i) => i >= 0);
  if (easy) return { kind: 'choose', index: open[Math.floor(rng.next() * open.length)] };

  const reserve = reserveFor(view, player.id);
  const value = (o) => {
    const out = o.outcome;
    if (out.type === 'gain') return out.amount;
    if (out.type === 'upgrade') {
      const level = state.properties[o.target.id].level;
      return (rentAt(o.target, level + 1, rules) - rentAt(o.target, level, rules)) * 6 + o.target.upgradeCost;
    }
    if (player.cash - out.lose < reserve) return -Infinity;
    return o.chance * out.win - (1 - o.chance) * out.lose;
  };
  let best = 0;
  for (const i of open) if (value(options[i]) > value(options[best])) best = i;
  return { kind: 'choose', index: best };
}

/** 买地：留足安全现金就买；能凑组时放宽到一半安全现金 */
function shouldBuy(view, player, tile, reserve) {
  const { state, board } = view;
  if (player.cash < tile.price) return false;
  const left = player.cash - tile.price;
  if (left >= reserve) return true;
  const group = board.getGroupTiles(tile.group);
  const mine = group.filter((t) => state.properties[t.id].ownerId === player.id).length;
  return mine > 0 && left >= reserve / 2;
}

/**
 * @param {View} view
 * @param {string} playerId
 * @param {{ level?: 'easy' | 'normal', rng: { next: () => number } }} options
 * @returns {Action | null} null 表示不需要该玩家操作
 */
export function decideAction(view, playerId, { level = 'normal', rng }) {
  const { state, board, rules } = view;
  const player = state.players.find((p) => p.id === playerId);
  if (!player) return null;
  // 当前玩家刚破产时阶段停在 turnEnd，仍需由他结束回合把行动权交出去
  if (state.phase === P.TURN_END) return { kind: 'endTurn' };
  if (player.bankrupt) return null;
  const easy = level === 'easy';

  switch (state.phase) {
    case P.AWAIT_ROLL: {
      const reserve = reserveFor(view, playerId);
      const invest = easy
        ? rng.next() < 0.3
          ? investAction(view, player, MIN_RESERVE / 2, { allowRedeem: false, upgradeReserve: MIN_RESERVE / 2 })
          : null
        : investAction(view, player, reserve, { allowRedeem: true, upgradeReserve: reserve });
      if (invest) return invest;
      if (!easy) {
        const offer = tradeOffer(view, player, reserve, rng);
        if (offer) return offer;
      }

      if (player.inJail) {
        if (easy) return player.jailFreeCards.length > 0 ? { kind: 'jailCard' } : { kind: 'roll' };
        // 对手地产多时坐牢更安全：留在牢里掷骰
        if (opponentOwnedRatio(view, playerId) < JAIL_STAY_RATIO) {
          if (player.jailFreeCards.length > 0) return { kind: 'jailCard' };
          if (player.cash - rules.jailBail >= reserve) return { kind: 'bail' };
        }
      }
      return { kind: 'roll' };
    }

    case P.AWAIT_DECISION: {
      const tile = board.getTile(player.position);
      if (easy) {
        const buy = player.cash - tile.price >= MIN_RESERVE / 2 && rng.next() < 0.7;
        return { kind: buy ? 'buy' : 'decline' };
      }
      return { kind: shouldBuy(view, player, tile, reserveFor(view, playerId)) ? 'buy' : 'decline' };
    }

    case P.AWAIT_TRADE:
      return respondTrade(view, player, easy);

    case P.AWAIT_CHOICE:
      return choiceAction(view, player, easy, rng);

    case P.AWAIT_PAYMENT:
      return paymentAction(view, player);

    default:
      return null;
  }
}
