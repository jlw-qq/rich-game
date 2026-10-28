/**
 * 逻辑层：付款、欠款与破产资产处置。
 * creditorId：null 表示银行；字符串表示单个玩家；字符串数组表示多位玩家平分（如“向每位玩家付款”卡）。
 */
import { buildingRefund } from './property.js';

const ok = () => ({ ok: true });
const fail = (error) => ({ ok: false, error });

function getPlayer(state, playerId) {
  return state.players.find((p) => p.id === playerId) ?? null;
}

/** 收款方已破产或不存在时视为银行 */
function resolveCreditor(state, creditorId) {
  if (typeof creditorId !== 'string') return null;
  const creditor = getPlayer(state, creditorId);
  return creditor && !creditor.bankrupt ? creditor : null;
}

/**
 * 把 amount 分给收款方。多位收款方时平分，除不尽的余数与已破产收款方的份额归银行。
 * @returns {object[]} 实际收款的玩家
 */
function distribute(state, creditorId, amount) {
  const ids = creditorId === null ? [] : [creditorId].flat();
  if (ids.length === 0) return [];
  const share = Math.floor(amount / ids.length);
  const payees = ids.map((id) => resolveCreditor(state, id)).filter(Boolean);
  for (const p of payees) p.cash += share;
  return payees;
}

function transfer(ctx, payer, creditorId, amount, reason) {
  payer.cash -= amount;
  const payees = distribute(ctx.state, creditorId, amount);
  ctx.bus.emit('paymentMade', { payerId: payer.id, payeeIds: payees.map((p) => p.id), amount, reason });
}

/**
 * 向玩家收款。现金够则立即付清；不够则记为欠款（state.pendingDebt），由调用方进入还款阶段。
 * @returns {{ paid: boolean }}
 */
export function charge(ctx, payerId, creditorId, amount, reason) {
  if (!Number.isInteger(amount) || amount <= 0) throw new RangeError(`付款金额必须是正整数: ${amount}`);
  const { state, bus } = ctx;
  if (state.pendingDebt) throw new Error('已有未付清的欠款');
  const payer = getPlayer(state, payerId);
  if (!payer || payer.bankrupt) throw new RangeError(`付款玩家无效: ${payerId}`);

  if (payer.cash >= amount) {
    transfer(ctx, payer, creditorId, amount, reason);
    return { paid: true };
  }
  state.pendingDebt = { debtorId: payerId, creditorId, amount, reason };
  bus.emit('debtPending', { ...state.pendingDebt, cash: payer.cash });
  return { paid: false };
}

/** 现金已凑够时付清欠款 */
export function payPendingDebt(ctx) {
  const { state } = ctx;
  const debt = state.pendingDebt;
  if (!debt) return fail('没有欠款');
  const payer = getPlayer(state, debt.debtorId);
  if (payer.cash < debt.amount) return fail(`现金不足：欠 ${debt.amount}，现有 ${payer.cash}`);

  transfer(ctx, payer, debt.creditorId, debt.amount, debt.reason);
  state.pendingDebt = null;
  return ok();
}

/**
 * 破产资产处置：先把建筑卖回银行，再处置现金和地产。
 * 单个玩家债主：现金归债主，地产转给债主并保留抵押状态。
 * 银行或多位债主：现金按欠款比例分给债主（不超过各自应得），地产收回为无主空地。
 * 只处置资产，不改 bankrupt 标记（由状态机 declareBankrupt 负责）。
 */
export function liquidateForBankruptcy(ctx, debtorId, creditorId) {
  const { state, board, rules, bus } = ctx;
  const debtor = getPlayer(state, debtorId);
  const heir = resolveCreditor(state, creditorId);

  const transferred = [];
  for (const tile of board.tiles) {
    if (tile.type !== 'property') continue;
    const prop = state.properties[tile.id];
    if (prop.ownerId !== debtorId) continue;

    debtor.cash += prop.level * buildingRefund(tile, rules);
    prop.level = 0;
    if (heir) {
      prop.ownerId = heir.id;
    } else {
      prop.ownerId = null;
      prop.mortgaged = false;
    }
    transferred.push(tile.id);
  }

  const cash = debtor.cash;
  debtor.cash = 0;
  const payees = distribute(state, creditorId, cash);
  state.pendingDebt = null;
  bus.emit('assetsLiquidated', {
    debtorId,
    heirId: heir?.id ?? null,
    payeeIds: payees.map((p) => p.id),
    cash,
    properties: transferred,
  });
}
