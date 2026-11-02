/**
 * 逻辑层：地产拍卖（轮流加价）。有人停在无主地产上选择不买时开拍。
 *
 * - 所有没破产的玩家参加，从放弃购买的人的下一位开始按座位轮流，放弃的人排在最后；
 * - 轮到你时出价或退出。第一口价不低于起拍价，之后每口至少比当前最高价多 auctionMinRaise；
 *   出价不能超过手上的现金，拍卖中不能抵押凑钱（现金在拍卖期间不会变化）；
 * - 退出后这场拍卖不能再回来；轮到时现金不够最低出价的人自动退出；
 * - 只剩最高出价者时他按出价买下；还没人出价就全部退出则流拍，地产继续无主。
 *
 * 每口价都严格高于上一口，出价又不能超过现金，所以拍卖一定会结束。
 *
 * state.auction：{ tileId, starterId, start, high, highId, active, turn }
 *   high / highId 为当前最高价和出价人（还没人出价时为 null）；active 为还在场的玩家（按出价顺序）；
 *   turn 为 active 里轮到的下标。
 */

import { announceGroups } from './property.js';

const ok = () => ({ ok: true });
const fail = (error) => ({ ok: false, error });

/** 起拍价：标价乘 auctionStartRate，向上取整到 10 元 */
export function auctionStartPrice(tile, rules) {
  return Math.max(10, Math.ceil((tile.price * rules.auctionStartRate) / 10) * 10);
}

/** 现在的最低出价 */
export function minBid({ state, rules }) {
  const a = state.auction;
  return a.high === null ? a.start : a.high + rules.auctionMinRaise;
}

/** 轮到出价的玩家 id，没有拍卖时为 null */
export function auctionTurn(state) {
  const a = state.auction;
  return a ? (a.active[a.turn] ?? null) : null;
}

/**
 * 开拍。返回 { ended } 表示是否当场结束（所有人都出不起起拍价）。
 * @param {{ state: object, board: object, rules: object, bus: object }} ctx
 */
export function startAuction(ctx, starterId, tileId) {
  const { state, board, rules, bus } = ctx;
  const tile = board.tiles.find((t) => t.id === tileId);
  const seat = state.players.findIndex((p) => p.id === starterId);
  const n = state.players.length;
  const active = [];
  for (let k = 1; k <= n; k++) {
    const p = state.players[(seat + k) % n];
    if (!p.bankrupt) active.push(p.id);
  }
  state.auction = { tileId, starterId, start: auctionStartPrice(tile, rules), high: null, highId: null, active, turn: 0 };
  bus.emit('auctionStarted', { tileId, starterId, start: state.auction.start, order: [...active] });
  return { ended: advance(ctx) };
}

/**
 * 推进到下一个能出价的人；该结束时结算。返回是否已结束。
 */
function advance(ctx) {
  const { state, bus } = ctx;
  const a = state.auction;
  for (;;) {
    if (a.active.length === 0) {
      bus.emit('auctionUnsold', { tileId: a.tileId });
      state.auction = null;
      return true;
    }
    if (a.highId !== null && a.active.length === 1) return settle(ctx);
    if (a.turn >= a.active.length) a.turn = 0;
    const id = a.active[a.turn];
    const player = state.players.find((p) => p.id === id);
    if (player.cash >= minBid(ctx)) return false;
    a.active.splice(a.turn, 1);
    bus.emit('auctionPassed', { playerId: id, reason: 'cash' });
  }
}

/** 成交：最高出价者付钱给银行，拿到地产 */
function settle(ctx) {
  const { state, bus } = ctx;
  const a = state.auction;
  const winner = state.players.find((p) => p.id === a.highId);
  winner.cash -= a.high;
  state.properties[a.tileId].ownerId = winner.id;
  bus.emit('auctionWon', { playerId: winner.id, tileId: a.tileId, amount: a.high });
  announceGroups(ctx, winner.id, [a.tileId]);
  state.auction = null;
  return true;
}

/**
 * 出价。调用方已确认现在是拍卖阶段。
 * @returns {{ ok: true, ended: boolean } | { ok: false, error: string }}
 */
export function placeBid(ctx, playerId, amount) {
  const { state } = ctx;
  if (auctionTurn(state) !== playerId) return fail('还没轮到你出价');
  const player = state.players.find((p) => p.id === playerId);
  const least = minBid(ctx);
  if (!Number.isInteger(amount)) return fail('出价必须是整数');
  if (amount < least) return fail(`出价至少 ${least} 元`);
  if (amount > player.cash) return fail(`现金不足：出价 ${amount}，现有 ${player.cash}`);
  const a = state.auction;
  a.high = amount;
  a.highId = playerId;
  a.turn += 1;
  ctx.bus.emit('auctionBid', { playerId, amount });
  return { ...ok(), ended: advance(ctx) };
}

/**
 * 退出这场拍卖。
 * @returns {{ ok: true, ended: boolean } | { ok: false, error: string }}
 */
export function passAuction(ctx, playerId) {
  const { state } = ctx;
  if (auctionTurn(state) !== playerId) return fail('还没轮到你');
  const a = state.auction;
  a.active.splice(a.turn, 1);
  ctx.bus.emit('auctionPassed', { playerId, reason: 'pass' });
  return { ...ok(), ended: advance(ctx) };
}
