/**
 * 逻辑层：AI 执行器。每次 step() 让当前该行动的 AI 走一步。
 *
 * 防死循环：
 * - 决策抛错、返回非法操作、或操作执行后状态没有任何变化，都改用兜底操作；
 * - 同一回合内的步数超过 maxStepsPerTurn 后，不再询问策略，直接用兜底操作；
 * - 兜底操作每一步都必然推进状态（掷骰、拒绝交易、放弃购买、付款或破产、结束回合）；
 * - 每回合发起交易的次数有上限（rules.maxTradesPerTurn），AI 之间互相提议也不会无限进行。
 */
import { PHASES as P } from '../core/turnMachine.js';
import { performAction } from '../core/actions.js';
import { createRng } from '../utils/rng.js';
import { decideAction } from './strategy.js';

export const DEFAULT_MAX_STEPS_PER_TURN = 100;

/** 状态指纹：用来判断一步操作有没有推进状态 */
function signature(state) {
  const players = state.players.map((p) => `${p.cash},${p.position},${p.bankrupt ? 1 : 0},${p.inJail ? 1 : 0},${p.jailFreeCards.length}`);
  const props = Object.values(state.properties).map((p) => `${p.ownerId ?? '-'}${p.level}${p.mortgaged ? 'm' : ''}`);
  const trade = state.pendingTrade ? JSON.stringify(state.pendingTrade) : '-';
  const choice = state.pendingChoice ? `${state.pendingChoice.cardId}` : '-';
  return [state.phase, state.turn, state.currentPlayerIndex, state.doublesCount, state.tradesThisTurn, trade, choice, players.join('|'), props.join('')].join('#');
}

/**
 * @param {{
 *   game: object,
 *   state: object,
 *   board: object,
 *   rules: object,
 *   decide?: typeof decideAction,
 *   maxStepsPerTurn?: number,
 *   cards?: object[],
 *   controls?: (player: object) => boolean,
 * }} options decide 可替换，便于测试兜底逻辑；cards 为卡牌配置（城市事件选项要用）；
 *   controls 决定哪些玩家由 AI 操作，默认是 AI 玩家（联网时掉线或超时的玩家也交给 AI）
 */
export function createAiDriver({
  game,
  state,
  board,
  rules,
  decide = decideAction,
  maxStepsPerTurn = DEFAULT_MAX_STEPS_PER_TURN,
  cards = [],
  controls = (player) => player.isAI,
}) {
  const view = { state, board, rules, cards };
  const stats = { steps: 0, fallbacks: 0 };
  let turnKey = -1;
  let stepsThisTurn = 0;

  /** 当前该行动的玩家是 AI 且对局未结束 */
  function isAiTurn() {
    if (state.phase === P.GAME_OVER) return false;
    const id = game.actingPlayerId();
    const player = state.players.find((p) => p.id === id);
    return player !== undefined && controls(player) === true;
  }

  /** 卖光建筑、抵押全部地产，确保接下来付款或破产必有一个成功 */
  function liquidateAll(playerId) {
    for (const t of board.tiles) {
      if (t.type !== 'property') continue;
      const prop = state.properties[t.id];
      if (prop.ownerId !== playerId) continue;
      while (prop.level > 0 && game.sellBuilding(playerId, t.id).ok);
    }
    for (const t of board.tiles) {
      if (t.type === 'property' && state.properties[t.id].ownerId === playerId) game.mortgage(playerId, t.id);
    }
  }

  function fallback(playerId) {
    switch (state.phase) {
      case P.AWAIT_ROLL:
        return game.rollDice();
      case P.AWAIT_TRADE:
        return game.rejectTrade();
      case P.AWAIT_CHOICE:
        // 第一个选项是稳妥选项，配置校验保证它总能选
        return game.chooseOption(0);
      case P.AWAIT_DECISION:
        return game.declineProperty();
      case P.AWAIT_PAYMENT: {
        const paid = game.payDebt();
        if (paid.ok) return paid;
        const bankrupt = game.declareBankruptcy();
        if (bankrupt.ok) return bankrupt;
        liquidateAll(playerId);
        const retry = game.payDebt();
        return retry.ok ? retry : game.declareBankruptcy();
      }
      case P.TURN_END:
        return game.endTurn();
      default:
        return { ok: false, error: `无法处理的阶段: ${state.phase}` };
    }
  }

  /**
   * 让当前 AI 走一步。
   * @returns {null | { playerId: string, action: object | null, result: object, fallback: boolean, error?: string }}
   *   null 表示现在不是 AI 的回合
   */
  function step() {
    if (!isAiTurn()) return null;
    const playerId = game.actingPlayerId();
    const player = state.players.find((p) => p.id === playerId);

    if (state.turn !== turnKey) {
      turnKey = state.turn;
      stepsThisTurn = 0;
    }
    stepsThisTurn += 1;
    stats.steps += 1;

    let action = null;
    let error;
    if (stepsThisTurn <= maxStepsPerTurn) {
      // AI 的随机数状态存在 state 里（不消耗骰子序列），读档后决策可以复现
      const rng = createRng(state.aiRngState);
      try {
        action = decide(view, playerId, { level: player.aiLevel ?? 'normal', rng });
      } catch (err) {
        error = `AI 决策出错: ${err?.message ?? err}`;
      }
      state.aiRngState = rng.getState();
    } else {
      error = `AI 本回合步数超过 ${maxStepsPerTurn}，改用兜底操作`;
    }

    if (action) {
      const before = signature(state);
      const result = performAction(game, action);
      if (result.ok && signature(state) !== before) return { playerId, action, result, fallback: false };
      error = result.ok ? `操作 ${action.kind} 没有推进状态` : result.error;
    }

    stats.fallbacks += 1;
    return { playerId, action, result: fallback(playerId), fallback: true, error };
  }

  return { step, isAiTurn, stats };
}
