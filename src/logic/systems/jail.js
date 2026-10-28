/**
 * 逻辑层：出狱（保释、出狱卡）。入狱见 movement.sendToJail，坐牢掷骰流程见 core/game.js。
 */

const ok = () => ({ ok: true });
const fail = (error) => ({ ok: false, error });

function getJailedPlayer(state, playerId) {
  const player = state.players.find((p) => p.id === playerId);
  if (!player || player.bankrupt) return { error: `玩家无效: ${playerId}` };
  if (!player.inJail) return { error: '玩家不在监狱中' };
  return { player };
}

/**
 * @param {string} method 'bail' | 'card' | 'doubles' | 'forcedBail'
 */
export function releaseFromJail({ state, bus }, playerId, method) {
  const player = state.players.find((p) => p.id === playerId);
  player.inJail = false;
  player.jailTurns = 0;
  bus.emit('releasedFromJail', { playerId, method });
}

/** 主动交保释金出狱 */
export function payBail(ctx, playerId) {
  const { player, error } = getJailedPlayer(ctx.state, playerId);
  if (error) return fail(error);
  const bail = ctx.rules.jailBail;
  if (player.cash < bail) return fail(`现金不足：需要 ${bail}，现有 ${player.cash}`);

  player.cash -= bail;
  ctx.bus.emit('paymentMade', { payerId: playerId, payeeIds: [], amount: bail, reason: { type: 'bail' } });
  releaseFromJail(ctx, playerId, 'bail');
  return ok();
}

/** 把玩家持有的出狱卡全部放回原牌堆底部（破产时调用，避免卡牌从游戏中消失） */
export function returnJailFreeCards({ state, cards }, playerId) {
  const player = state.players.find((p) => p.id === playerId);
  for (const cardId of player.jailFreeCards) {
    const card = cards.find((c) => c.id === cardId);
    if (card) state.decks[card.deck].push(cardId);
  }
  player.jailFreeCards = [];
}

/** 使用出狱卡，卡放回原牌堆底部 */
export function useJailFreeCard(ctx, playerId) {
  const { player, error } = getJailedPlayer(ctx.state, playerId);
  if (error) return fail(error);
  if (player.jailFreeCards.length === 0) return fail('没有出狱卡');

  const cardId = player.jailFreeCards.shift();
  const card = ctx.cards.find((c) => c.id === cardId);
  if (card) ctx.state.decks[card.deck].push(cardId);
  releaseFromJail(ctx, playerId, 'card');
  return ok();
}
