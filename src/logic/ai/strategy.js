/**
 * 逻辑层：AI 决策。纯函数：读状态，返回下一步操作 { kind, tileId? }，不修改状态。
 * 返回的操作仍由 game 校验；非法操作由 driver 兜底。
 */
import { PHASES as P } from '../core/turnMachine.js';
import { calcRent, ownsFullGroup, redeemCost } from '../systems/property.js';

/**
 * @typedef {{ state: object, board: object, rules: object }} View
 * @typedef {{ kind: string, tileId?: string }} Action
 */

/** 安全现金下限与上限：至少留 1000，最多按 6000 留（否则后期 AI 什么都不敢买） */
const MIN_RESERVE = 1000;
const MAX_RESERVE = 6000;
/** 对手拥有的地产比例达到该值时，坐牢反而安全，选择留在牢里 */
const JAIL_STAY_RATIO = 0.4;

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

    case P.AWAIT_PAYMENT:
      return paymentAction(view, player);

    default:
      return null;
  }
}
