/**
 * 表现层：整理地产卡片要显示的数据。纯函数，租金规则直接用逻辑层的 calcRent，不在这里重写。
 */
import { calcRent, ownsFullGroup } from '../../logic/systems/property.js';

/**
 * @typedef {{
 *   name: string,
 *   group: string,
 *   price: number,
 *   level: number,
 *   maxLevel: number,
 *   mortgaged: boolean,
 *   owner: { name: string, index: number } | null,
 *   rent: number,
 *   groupBonus: boolean,
 *   nextRent: number | null,
 * }} TileCard
 * rent：有主时为当前应付租金；无主时为买下后的空地租金。
 * groupBonus：租金因拥有整组空地而翻倍。
 * nextRent：升一级后的租金，已是最高等级时为 null。
 */

/**
 * @param {{ state: object, board: object, rules: object }} ctx
 * @param {number} index 格子下标
 * @returns {TileCard | null} 不是地产时返回 null
 */
export function tileCardInfo(ctx, index) {
  const { state, board, rules } = ctx;
  const tile = board.tiles[index];
  if (!tile || tile.type !== 'property') return null;
  const prop = state.properties[tile.id];
  const ownerIndex = state.players.findIndex((p) => p.id === prop.ownerId);
  const owner = ownerIndex >= 0 ? state.players[ownerIndex] : null;

  return {
    name: tile.name,
    group: tile.group,
    price: tile.price,
    level: prop.level,
    maxLevel: rules.maxLevel,
    mortgaged: prop.mortgaged,
    owner: owner ? { name: owner.name, index: ownerIndex } : null,
    rent: owner ? calcRent(ctx, tile.id) : tile.rent[0],
    groupBonus: Boolean(owner) && !prop.mortgaged && prop.level === 0 && !owner.bankrupt && ownsFullGroup(ctx, owner.id, tile.group),
    nextRent: prop.level < rules.maxLevel ? tile.rent[prop.level + 1] : null,
  };
}
