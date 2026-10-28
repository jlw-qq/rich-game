/**
 * 逻辑层：机会卡、命运卡。牌堆是卡牌 id 数组，存放在 state.decks，从头抽、放回底部。
 * applyCard 只处理能立即结算的效果，需要收款、移动、入狱时返回计划，由对局协调器继续执行。
 */

export const DECKS = ['chance', 'fate'];
export const EFFECT_TYPES = ['gain', 'pay', 'collectFromEach', 'payEach', 'move', 'moveTo', 'goToJail', 'jailFree', 'repairs'];

export class CardConfigError extends Error {
  /** @param {string[]} errors */
  constructor(errors) {
    super(`卡牌配置无效:\n- ${errors.join('\n- ')}`);
    this.name = 'CardConfigError';
    this.errors = errors;
  }
}

const isPositiveInt = (v) => Number.isInteger(v) && v > 0;

/**
 * @param {object[]} cards
 * @param {{ tiles: readonly object[] }} board
 * @returns {string[]}
 */
export function validateCards(cards, board) {
  if (!Array.isArray(cards)) return ['卡牌列表必须是数组'];
  const errors = [];
  const ids = new Set();
  const tileIds = new Set(board.tiles.map((t) => t.id));

  cards.forEach((c, i) => {
    const where = `卡牌[${i}]`;
    if (typeof c?.id !== 'string' || c.id === '') errors.push(`${where} 缺少 id`);
    else if (ids.has(c.id)) errors.push(`${where} id 重复: ${c.id}`);
    else ids.add(c.id);
    if (!DECKS.includes(c?.deck)) errors.push(`${where} 未知牌堆: ${c?.deck}`);
    if (typeof c?.title !== 'string' || typeof c?.text !== 'string') errors.push(`${where} 缺少 title 或 text`);

    const e = c?.effect;
    if (!EFFECT_TYPES.includes(e?.type)) {
      errors.push(`${where} 未知效果: ${e?.type}`);
      return;
    }
    if (['gain', 'pay', 'collectFromEach', 'payEach'].includes(e.type) && !isPositiveInt(e.amount)) {
      errors.push(`${where} amount 必须是正整数，实际为 ${e.amount}`);
    }
    if (e.type === 'move' && (!Number.isInteger(e.steps) || e.steps === 0)) {
      errors.push(`${where} steps 必须是非零整数，实际为 ${e.steps}`);
    }
    if (e.type === 'moveTo' && !tileIds.has(e.tileId)) errors.push(`${where} 目标格不存在: ${e.tileId}`);
    if (e.type === 'repairs' && !isPositiveInt(e.perLevel)) {
      errors.push(`${where} perLevel 必须是正整数，实际为 ${e.perLevel}`);
    }
  });
  return errors;
}

/** Fisher–Yates 洗牌（就地） */
function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * @param {object[]} cards
 * @param {{ int: (min: number, max: number) => number }} rng
 * @returns {Record<string, string[]>}
 */
export function buildDecks(cards, rng) {
  const decks = Object.fromEntries(DECKS.map((d) => [d, []]));
  for (const c of cards) decks[c.deck]?.push(c.id);
  for (const pile of Object.values(decks)) shuffle(pile, rng);
  return decks;
}

/**
 * 从牌堆顶抽一张。出狱卡由玩家持有，其余卡立即放回牌堆底部。
 * 牌堆为空或抽到配置里不存在的卡（如旧存档）时返回 null。
 */
export function drawCard({ state, cards, bus }, playerId, deck) {
  const pile = state.decks?.[deck];
  if (!pile || pile.length === 0) return null;
  const id = pile.shift();
  const card = cards.find((c) => c.id === id);
  if (!card) return null;
  if (card.effect.type !== 'jailFree') pile.push(id);
  bus.emit('cardDrawn', { playerId, deck, cardId: id });
  return card;
}

/**
 * 执行卡牌效果。
 * @returns {{ kind: 'done' }
 *   | { kind: 'charge', creditorId: string[] | null, amount: number }
 *   | { kind: 'move', steps: number }
 *   | { kind: 'jail' }}
 */
export function applyCard({ state, board, bus }, playerId, card) {
  const player = state.players.find((p) => p.id === playerId);
  const others = state.players.filter((p) => p.id !== playerId && !p.bankrupt);
  const e = card.effect;

  switch (e.type) {
    case 'gain':
      player.cash += e.amount;
      bus.emit('cashGained', { playerId, amount: e.amount, reason: { type: 'card', cardId: card.id } });
      return { kind: 'done' };

    case 'pay':
      return { kind: 'charge', creditorId: null, amount: e.amount };

    case 'collectFromEach': {
      // 简化：对方只付现有现金，不进入还款流程（同一时刻只处理一笔欠款）
      for (const other of others) {
        const paid = Math.min(e.amount, other.cash);
        if (paid === 0) continue;
        other.cash -= paid;
        player.cash += paid;
        bus.emit('paymentMade', { payerId: other.id, payeeIds: [playerId], amount: paid, reason: { type: 'card', cardId: card.id } });
      }
      return { kind: 'done' };
    }

    case 'payEach':
      if (others.length === 0) return { kind: 'done' };
      return { kind: 'charge', creditorId: others.map((p) => p.id), amount: e.amount * others.length };

    case 'move':
      return { kind: 'move', steps: e.steps };

    case 'moveTo': {
      const target = board.tiles.findIndex((t) => t.id === e.tileId);
      return { kind: 'move', steps: (((target - player.position) % board.size) + board.size) % board.size };
    }

    case 'goToJail':
      return { kind: 'jail' };

    case 'jailFree':
      player.jailFreeCards.push(card.id);
      return { kind: 'done' };

    case 'repairs': {
      const levels = Object.values(state.properties)
        .filter((prop) => prop.ownerId === playerId)
        .reduce((sum, prop) => sum + prop.level, 0);
      if (levels === 0) return { kind: 'done' };
      return { kind: 'charge', creditorId: null, amount: levels * e.perLevel };
    }

    default:
      return { kind: 'done' };
  }
}
