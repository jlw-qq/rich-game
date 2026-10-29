/**
 * 逻辑层：玩家之间的交易。发起方拿出 give，换取对方的 take。
 * 每一边可以包含地产、现金、出狱卡；对方只能接受或拒绝。
 *
 * 交易内容来自 UI 输入，执行前必须逐项校验；失败时状态不变。
 */

const ok = () => ({ ok: true });
const fail = (error) => ({ ok: false, error });

/** @typedef {{ properties: string[], cash: number, jailCards: number }} TradeSide */
/** @typedef {{ fromId: string, toId: string, give: TradeSide, take: TradeSide }} Trade */

const isNonNegInt = (v) => Number.isInteger(v) && v >= 0;

function getPlayer(state, playerId) {
  return state.players.find((p) => p.id === playerId) ?? null;
}

/**
 * 把外部传入的一边整理成标准结构。格式不对返回 { error }。
 * @returns {{ side: TradeSide } | { error: string }}
 */
function normalizeSide(raw, label) {
  if (raw === undefined || raw === null) return { side: { properties: [], cash: 0, jailCards: 0 } };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { error: `${label}格式无效` };
  const { properties = [], cash = 0, jailCards = 0 } = raw;
  if (!Array.isArray(properties) || !properties.every((id) => typeof id === 'string')) {
    return { error: `${label}的地产列表无效` };
  }
  if (new Set(properties).size !== properties.length) return { error: `${label}的地产重复` };
  if (!isNonNegInt(cash)) return { error: `${label}的现金必须是非负整数` };
  if (!isNonNegInt(jailCards)) return { error: `${label}的出狱卡数量必须是非负整数` };
  return { side: { properties: [...properties], cash, jailCards } };
}

const isEmptySide = (side) => side.properties.length === 0 && side.cash === 0 && side.jailCards === 0;

/** 检查一边的资产都属于 owner 且可以交易 */
function checkSide({ state, board }, owner, side, label) {
  if (side.cash > owner.cash) return `${label}现金不足：需要 ${side.cash}，现有 ${owner.cash}`;
  if (side.jailCards > owner.jailFreeCards.length) return `${label}没有那么多出狱卡`;
  for (const tileId of side.properties) {
    const tile = board.tiles.find((t) => t.type === 'property' && t.id === tileId);
    if (!tile) return `不是地产: ${tileId}`;
    if (state.properties[tileId].ownerId !== owner.id) return `${tile.name} 不属于${label}`;
    if (board.getGroupTiles(tile.group).some((t) => state.properties[t.id].level > 0)) {
      return `${tile.name} 所在颜色组有建筑，请先卖掉建筑`;
    }
  }
  return null;
}

/**
 * 校验并整理一笔交易。
 * @param {object} ctx { state, board }
 * @param {unknown} raw { fromId, toId, give, take }
 * @returns {{ ok: true, trade: Trade } | { ok: false, error: string }}
 */
export function prepareTrade(ctx, raw) {
  if (!raw || typeof raw !== 'object') return fail('交易内容无效');
  const from = getPlayer(ctx.state, raw.fromId);
  const to = getPlayer(ctx.state, raw.toId);
  if (!from || from.bankrupt) return fail('发起交易的玩家无效');
  if (!to || to.bankrupt) return fail('交易对象无效');
  if (from.id === to.id) return fail('不能和自己交易');

  const give = normalizeSide(raw.give, '发起方');
  if (give.error) return fail(give.error);
  const take = normalizeSide(raw.take, '对方');
  if (take.error) return fail(take.error);
  if (isEmptySide(give.side) && isEmptySide(take.side)) return fail('交易内容不能为空');

  const error = checkSide(ctx, from, give.side, '发起方') ?? checkSide(ctx, to, take.side, '对方');
  if (error) return fail(error);
  return { ok: true, trade: { fromId: from.id, toId: to.id, give: give.side, take: take.side } };
}

/** 把一边的资产从 owner 转给 receiver（已校验过） */
function moveSide({ state }, owner, receiver, side) {
  owner.cash -= side.cash;
  receiver.cash += side.cash;
  const cards = owner.jailFreeCards.splice(0, side.jailCards);
  receiver.jailFreeCards.push(...cards);
  // 地产连同抵押状态一起转让
  for (const tileId of side.properties) state.properties[tileId].ownerId = receiver.id;
}

/**
 * 执行交易。执行前重新校验，双方资产在提议后有变化时拒绝执行。
 * @param {object} ctx { state, board, bus }
 * @param {Trade} trade
 */
export function executeTrade(ctx, trade) {
  const checked = prepareTrade(ctx, trade);
  if (!checked.ok) return checked;
  const from = getPlayer(ctx.state, trade.fromId);
  const to = getPlayer(ctx.state, trade.toId);
  moveSide(ctx, from, to, checked.trade.give);
  moveSide(ctx, to, from, checked.trade.take);
  ctx.bus.emit('tradeAccepted', { trade: checked.trade });
  return ok();
}
