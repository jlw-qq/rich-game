/**
 * 表现层：整理地产卡片要显示的数据。纯函数，租金规则直接用逻辑层的 calcRent，不在这里重写。
 */
import { calcRent, ownsFullGroup, upgradeBlocker } from '../../logic/systems/property.js';

/** 卡片正文字号 = 格高 × 该比例（与 boardRenderer 一致） */
export const CARD_TEXT_RATIO = 0.27;
/** 棋盘上卡片正文小于该字号（CSS 像素）时，只显示城市名，详细信息放到侧栏 */
export const MIN_CARD_TEXT_PX = 11;

/** @param {number} cellHeight 格高（CSS 像素） */
export const isCompactCard = (cellHeight) => cellHeight * CARD_TEXT_RATIO < MIN_CARD_TEXT_PX;

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
 *   upgrade: { kind: 'unowned' | 'needGroup' | 'mortgaged' | 'groupMortgaged' | 'ready' | 'max', rent: number | null },
 * }} TileCard
 * rent：有主时为当前应付租金；无主时为买下后的空地租金。
 * groupBonus：租金因拥有整组空地而翻倍。
 * upgrade：升级情况。rent 为升一级后的租金，满级时为 null。
 *   unowned 无主；needGroup 还没凑齐整组；mortgaged 本格已抵押；groupMortgaged 同组其他地已抵押；
 *   ready 可以升级；max 已满级。
 */

/** 卡片上“升级”一栏的文字 */
export function upgradeText({ upgrade }, fmt) {
  switch (upgrade.kind) {
    case 'unowned':
    case 'needGroup':
      return `凑齐整组后可升级 · 1 级 ${fmt(upgrade.rent)}`;
    case 'mortgaged':
      return '赎回后才能升级';
    case 'groupMortgaged':
      return '同组赎回后才能升级';
    case 'max':
      return '已满级';
    default:
      return `下一级 ${fmt(upgrade.rent)}`;
  }
}

/** @returns {TileCard['upgrade']} */
function upgradeInfo(ctx, tile, prop) {
  const rent = prop.level < ctx.rules.maxLevel ? tile.rent[prop.level + 1] : null;
  if (!prop.ownerId) return { kind: 'unowned', rent };
  if (prop.mortgaged) return { kind: 'mortgaged', rent };
  const blocker = upgradeBlocker(ctx, tile.id);
  const kind = { maxLevel: 'max', notFullGroup: 'needGroup', mortgaged: 'groupMortgaged' }[blocker?.code] ?? 'ready';
  return { kind, rent };
}

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
    upgrade: upgradeInfo(ctx, tile, prop),
  };
}
