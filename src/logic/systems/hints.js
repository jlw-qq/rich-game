/**
 * 逻辑层：本回合的经营机会（纯函数，不改状态）。表现层用它在操作区提示“现在能做什么”：
 * 能升级哪些地、升级后租金涨多少；差一块就凑齐的颜色组；离目标总资产还差多少。
 */
import { calcRent, rentAt, upgradeBlocker } from './property.js';
import { goalProgress } from './goal.js';

/** 最多列出几个“差一块凑齐”的颜色组 */
export const MAX_GROUP_HINTS = 2;

/**
 * @typedef {{
 *   upgrades: { count: number, best: { tileId: string, cost: number, from: number, to: number } } | null,
 *   groups: { group: string, tileId: string, ownerId: string | null, here: boolean }[],
 *   goal: { leaderId: string, leaderGap: number, myGap: number } | null,
 * }} TurnHints
 * upgrades：现金够、规则允许升级的地产数，以及租金涨得最多的一块（from 为现在停下要付的租金）。
 * groups：自己已有组里其余所有地、只差一块的颜色组；here 表示那一块就是现在停着、可以买的格子。
 * goal：短局目标资产模式下，领先者和自己离目标还差多少（已达到时为 0）。经典模式为 null。
 */

/**
 * @param {{ state: object, board: object, rules: object }} ctx
 * @param {string} playerId
 * @returns {TurnHints}
 */
export function turnHints(ctx, playerId) {
  const { state, board, rules } = ctx;
  const player = state.players.find((p) => p.id === playerId);
  if (!player || player.bankrupt) return { upgrades: null, groups: [], goal: null };
  const properties = board.tiles.filter((t) => t.type === 'property');

  // 能升级的地：自己的、规则允许、现金够
  let count = 0;
  let best = null;
  for (const tile of properties) {
    const prop = state.properties[tile.id];
    if (prop.ownerId !== playerId || upgradeBlocker(ctx, tile.id) || player.cash < tile.upgradeCost) continue;
    count += 1;
    const from = calcRent(ctx, tile.id);
    const to = rentAt(tile, prop.level + 1, rules);
    if (!best || to - from > best.to - best.from) best = { tileId: tile.id, cost: tile.upgradeCost, from, to };
  }

  // 差一块凑齐的颜色组：现在停着的那块排在最前
  const here = state.phase === 'awaitDecision' ? board.getTile(player.position) : null;
  const groups = [];
  for (const group of new Set(properties.map((t) => t.group))) {
    const tiles = board.getGroupTiles(group);
    const missing = tiles.filter((t) => state.properties[t.id].ownerId !== playerId);
    if (missing.length !== 1 || tiles.length < 2) continue;
    const tile = missing[0];
    groups.push({ group, tileId: tile.id, ownerId: state.properties[tile.id].ownerId, here: here?.id === tile.id });
  }
  groups.sort((a, b) => Number(b.here) - Number(a.here));

  let goal = null;
  const progress = goalProgress(ctx);
  if (progress) {
    // 并列领先时，自己也是领先者之一就算自己领先，否则取座位靠前的一位
    const mine = progress.players.find((p) => p.id === playerId);
    const leader = mine.leader ? mine : progress.players.find((p) => p.leader);
    goal = { leaderId: leader.id, leaderGap: leader.gap, myGap: mine.gap };
  }

  return { upgrades: count > 0 ? { count, best } : null, groups: groups.slice(0, MAX_GROUP_HINTS), goal };
}
