/**
 * 逻辑层：地产系统（购买、收租、升级、卖建筑、抵押、赎回）。
 * 操作返回 { ok: true } 或 { ok: false, error }，失败时状态不变。
 */

/**
 * @typedef {{
 *   state: { players: object[], properties: Record<string, { ownerId: string|null, level: number, mortgaged: boolean }> },
 *   board: { tiles: readonly object[], getGroupTiles: (group: string) => readonly object[] },
 *   rules: object,
 *   bus: { emit: (type: string, payload?: object) => void },
 * }} Context
 */

const ok = () => ({ ok: true });
const fail = (error) => ({ ok: false, error });

/** 消除浮点误差（如 300 * 0.1 = 30.000000000000004），再取整 */
const round6 = (v) => Math.round(v * 1e6) / 1e6;

/** 赎回费用 = 抵押价 + 利息（利息向上取整） */
export function redeemCost(tile, rules) {
  return tile.mortgageValue + Math.ceil(round6(tile.mortgageValue * rules.mortgageInterestRate));
}

/**
 * 某等级的基础租金（已乘租金倍数，四舍五入）。
 * @param {{ rent: number[] }} tile
 * @param {number} level
 * @param {{ rentMultiplier: number }} rules
 */
export function rentAt(tile, level, rules) {
  return Math.round(round6(tile.rent[level] * rules.rentMultiplier));
}

/** 卖一级建筑的退款（向下取整） */
export function buildingRefund(tile, rules) {
  return Math.floor(round6(tile.upgradeCost * rules.buildingSellRate));
}

function getPropertyTile(board, tileId) {
  return board.tiles.find((t) => t.type === 'property' && t.id === tileId) ?? null;
}

function getPlayer(state, playerId) {
  return state.players.find((p) => p.id === playerId) ?? null;
}

/**
 * 公共前置检查：玩家存在且未破产、格子是地产、（可选）玩家是地主。
 * @returns {{ error: string } | { player: object, tile: object, prop: object }}
 */
function lookup({ state, board }, playerId, tileId, { mustOwn = true } = {}) {
  const player = getPlayer(state, playerId);
  if (!player) return { error: `玩家不存在: ${playerId}` };
  if (player.bankrupt) return { error: '玩家已破产' };
  const tile = getPropertyTile(board, tileId);
  if (!tile) return { error: `不是地产: ${tileId}` };
  const prop = state.properties[tile.id];
  if (mustOwn && prop.ownerId !== playerId) return { error: `${tile.name} 不属于该玩家` };
  return { player, tile, prop };
}

/** @param {Context} ctx */
export function ownsFullGroup({ state, board }, playerId, group) {
  return board.getGroupTiles(group).every((t) => state.properties[t.id].ownerId === playerId);
}

/**
 * 停在该地产上应付的租金。无主、已抵押、地主已破产时为 0。
 * 空地且地主拥有整个颜色组时乘以 groupRentMultiplier。
 * @param {Context} ctx
 */
export function calcRent(ctx, tileId) {
  const { state, rules, board } = ctx;
  const tile = getPropertyTile(board, tileId);
  if (!tile) return 0;
  const prop = state.properties[tile.id];
  if (!prop.ownerId || prop.mortgaged) return 0;
  const owner = getPlayer(state, prop.ownerId);
  if (!owner || owner.bankrupt) return 0;

  const base = rentAt(tile, prop.level, rules);
  return prop.level === 0 && ownsFullGroup(ctx, prop.ownerId, tile.group)
    ? base * rules.groupRentMultiplier
    : base;
}

/**
 * 玩家把所有建筑卖掉、所有未抵押地产抵押后能拿到的现金总额。
 * @param {Context} ctx
 */
export function liquidationValue({ state, board, rules }, playerId) {
  const player = getPlayer(state, playerId);
  if (!player) return 0;
  let total = player.cash;
  for (const tile of board.tiles) {
    if (tile.type !== 'property') continue;
    const prop = state.properties[tile.id];
    if (prop.ownerId !== playerId) continue;
    total += prop.level * buildingRefund(tile, rules);
    if (!prop.mortgaged) total += tile.mortgageValue;
  }
  return total;
}

/**
 * 总资产：现金 + 地产购买价 + 已建建筑的升级费；抵押的地产扣掉抵押价（相当于欠银行的钱）。
 * 用于回合上限时排名。
 * @param {Context} ctx
 */
export function netWorth({ state, board }, playerId) {
  const player = getPlayer(state, playerId);
  if (!player) return 0;
  let total = player.cash;
  for (const tile of board.tiles) {
    if (tile.type !== 'property') continue;
    const prop = state.properties[tile.id];
    if (prop.ownerId !== playerId) continue;
    total += tile.price + prop.level * tile.upgradeCost - (prop.mortgaged ? tile.mortgageValue : 0);
  }
  return total;
}

/** @param {Context} ctx */
export function buyProperty(ctx, playerId, tileId) {
  const found = lookup(ctx, playerId, tileId, { mustOwn: false });
  if (found.error) return fail(found.error);
  const { player, tile, prop } = found;
  if (prop.ownerId !== null) return fail(`${tile.name} 已有主人`);
  if (player.cash < tile.price) return fail(`现金不足：需要 ${tile.price}，现有 ${player.cash}`);

  player.cash -= tile.price;
  prop.ownerId = playerId;
  ctx.bus.emit('propertyBought', { playerId, tileId: tile.id, price: tile.price });
  return ok();
}

/**
 * 地主升级这块地的规则限制（不含现金是否足够）。可以升级时返回 null。
 * code：maxLevel 已满级；notFullGroup 没有整个颜色组；mortgaged 组内有抵押地产。
 * @param {Context} ctx
 * @param {string} tileId 必须是有主地产
 * @returns {{ code: 'maxLevel' | 'notFullGroup' | 'mortgaged', message: string } | null}
 */
export function upgradeBlocker(ctx, tileId) {
  const { state, board, rules } = ctx;
  const tile = getPropertyTile(board, tileId);
  const prop = state.properties[tile.id];
  if (prop.level >= rules.maxLevel) return { code: 'maxLevel', message: `${tile.name} 已是最高等级` };
  if (!ownsFullGroup(ctx, prop.ownerId, tile.group)) return { code: 'notFullGroup', message: '需要拥有整个颜色组才能升级' };
  if (board.getGroupTiles(tile.group).some((t) => state.properties[t.id].mortgaged)) {
    return { code: 'mortgaged', message: '颜色组内有抵押地产，不能升级' };
  }
  return null;
}

/** @param {Context} ctx */
export function upgradeProperty(ctx, playerId, tileId) {
  const found = lookup(ctx, playerId, tileId);
  if (found.error) return fail(found.error);
  const { player, tile, prop } = found;

  const blocker = upgradeBlocker(ctx, tile.id);
  if (blocker) return fail(blocker.message);
  if (player.cash < tile.upgradeCost) return fail(`现金不足：需要 ${tile.upgradeCost}，现有 ${player.cash}`);

  player.cash -= tile.upgradeCost;
  prop.level += 1;
  ctx.bus.emit('propertyUpgraded', { playerId, tileId: tile.id, level: prop.level, cost: tile.upgradeCost });
  return ok();
}

/** @param {Context} ctx */
export function sellBuilding(ctx, playerId, tileId) {
  const found = lookup(ctx, playerId, tileId);
  if (found.error) return fail(found.error);
  const { player, tile, prop } = found;
  if (prop.level === 0) return fail(`${tile.name} 没有建筑`);

  const refund = buildingRefund(tile, ctx.rules);
  prop.level -= 1;
  player.cash += refund;
  ctx.bus.emit('buildingSold', { playerId, tileId: tile.id, level: prop.level, refund });
  return ok();
}

/** @param {Context} ctx */
export function mortgageProperty(ctx, playerId, tileId) {
  const found = lookup(ctx, playerId, tileId);
  if (found.error) return fail(found.error);
  const { player, tile, prop } = found;
  if (prop.mortgaged) return fail(`${tile.name} 已抵押`);
  // 同组有建筑时不能抵押，避免出现“组内既有建筑又有抵押”的状态
  if (ctx.board.getGroupTiles(tile.group).some((t) => ctx.state.properties[t.id].level > 0)) {
    return fail('颜色组内有建筑，请先卖掉建筑');
  }

  prop.mortgaged = true;
  player.cash += tile.mortgageValue;
  ctx.bus.emit('propertyMortgaged', { playerId, tileId: tile.id, amount: tile.mortgageValue });
  return ok();
}

/** @param {Context} ctx */
export function redeemProperty(ctx, playerId, tileId) {
  const found = lookup(ctx, playerId, tileId);
  if (found.error) return fail(found.error);
  const { player, tile, prop } = found;
  if (!prop.mortgaged) return fail(`${tile.name} 未抵押`);
  const cost = redeemCost(tile, ctx.rules);
  if (player.cash < cost) return fail(`现金不足：需要 ${cost}，现有 ${player.cash}`);

  player.cash -= cost;
  prop.mortgaged = false;
  ctx.bus.emit('propertyRedeemed', { playerId, tileId: tile.id, cost });
  return ok();
}
